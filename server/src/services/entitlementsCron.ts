/**
 * Entitlements 过期 & 通知 Cron。
 *  - 每小时扫描一次；启动时立刻先跑一次，避免冷启动漏扫。
 *  - 所有外部调用（sendMessage / kick）失败只 warn、不 throw，保证 DB 状态更新不被 Telegram API 阻断。
 *  - 幂等由 DB 字段保证：
 *      notify3dAt      → 到期前 3 天提醒是否已发（NULL = 待提醒）
 *      notifyExpiredAt → 到期当日通知&踢人是否已执行（NULL = 待处理）
 *  - 【Security Boundary - 细节4】console.warn / console.error 日志中绝不包含明文 chatId、
 *    inviteLink、Bot Token 或用户资料（姓名/用户名/头像），仅保留 HMAC 指纹或脱敏标识。
 */
import type { PrismaClient } from "@prisma/client";
import {
  kickChannelMember,
  sendDirectMessage,
  TELEGRAM_CONFIG,
  refMembershipMain,
  refPackageFeatured,
  maskChatIdSafe,
  chatIdFingerprint,
} from "./telegramBot.js";
import { userIdIndexKey } from "../utils/crypto.js";
import { emitSafetyEvent, emitStructuredLog } from "../utils/structuredError.js";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const WARN_WINDOW_MS = 30 * 60 * 1000; // 30min 窗口，每小时扫肯定至少命中一次
const GRACE_AFTER_EXPIRE_MS = 1 * 60 * 1000; // 过期 1 分钟后再通知&踢，给事务留时间

export type SweepResult = {
  markedExpired: number;
  warned3d: number;
  notifiedExpired: number;
  kicked: number;
  skippedMissingChannel: number;
  externalErrors: number;
  ranAt: string;
};

type ChannelRefForSweep =
  | { kind: "membership_main" }
  | { kind: "package_featured" };

function getChannelRefForResource(resourceType: string, resourceId: string): ChannelRefForSweep | null {
  if (resourceType === "membership_channel" && resourceId === "membership-main") {
    return { kind: "membership_main" };
  }
  if (resourceType === "package") {
    return { kind: "package_featured" };
  }
  return null;
}

function toChannelRef(ref: ChannelRefForSweep) {
  if (ref.kind === "membership_main") return refMembershipMain();
  return refPackageFeatured();
}

function maskTGUid(tgid: bigint | number | string): string {
  const raw = String(tgid);
  if (!raw) return "****";
  const fprLocal = userIdIndexKey(tgid);
  return `uidfp:${fprLocal.slice(0, 8)}…`;
}

function build3dWarningText(ent: { resourceType: string; resourceId: string; expiresAt: Date }): string {
  const dateStr = ent.expiresAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (ent.resourceType === "membership_channel") {
    return `【同频 · 会员即将到期】\n你的同频会员将于 ${dateStr} 到期，续费可无缝延长访问权益，无需担心被移出收费频道。\n打开同频 Mini App → 我的订单 → 选择会员续费即可。`;
  }
  if (ent.resourceType === "package") {
    return `【同频 · 内容包即将到期】\n你购买的内容包将于 ${dateStr} 到期，到期后将自动移出对应内容包频道。续费可保持访问。`;
  }
  return `【同频 · 权益提醒】\n你购买的内容权益将于 ${dateStr} 到期，请注意续费。`;
}

function buildExpiredText(ent: { resourceType: string; resourceId: string }): string {
  if (ent.resourceType === "membership_channel") {
    return `【同频 · 会员已到期】\n你的同频会员权益已到期，已从收费会员频道移出。完成续费后将重新发送频道邀请链接，恢复所有会员内容访问。`;
  }
  if (ent.resourceType === "package") {
    return `【同频 · 内容包已到期】\n你购买的内容包权益已到期，已从对应频道移出。续费后可重新进入。`;
  }
  return `【同频 · 权益已到期】\n你购买的内容权益已到期。续费可恢复对应访问。`;
}

export async function runEntitlementSweep(prisma: PrismaClient, opts?: { dryRun?: boolean }): Promise<SweepResult> {
  const now = new Date();
  const result: SweepResult = {
    markedExpired: 0,
    warned3d: 0,
    notifiedExpired: 0,
    kicked: 0,
    skippedMissingChannel: 0,
    externalErrors: 0,
    ranAt: now.toISOString(),
  };

  try {
    // ====== 1) 过期状态切换（纯 DB，updateMany 原子幂等）======
    if (!opts?.dryRun) {
      const expiredRes = await prisma.entitlement.updateMany({
        where: { status: "active", expiresAt: { not: null, lt: now } },
        data: { status: "expired" },
      });
      result.markedExpired = expiredRes.count ?? 0;
    }
  } catch (err) {
    emitSafetyEvent(
      {
        event: "entitlements_mark_expired_failed",
        errorClass: "db_error",
        retryHint: 1,
        note: "updateMany_entitlement_status_expired_failed",
      },
      err,
    );
    result.externalErrors += 1;
  }

  // ====== 2) 到期前 3 天提醒（notify3dAt IS NULL 做幂等）======
  try {
    const warnLower = new Date(now.getTime() + THREE_DAYS_MS - WARN_WINDOW_MS);
    const warnUpper = new Date(now.getTime() + THREE_DAYS_MS + WARN_WINDOW_MS);
    const candidates3d = await prisma.entitlement.findMany({
      where: {
        status: "active",
        notify3dAt: null,
        expiresAt: { not: null, gte: warnLower, lte: warnUpper },
      },
      include: { user: { select: { telegramUserId: true, displayName: true } } },
    });
    for (const ent of candidates3d) {
      if (!ent.expiresAt) continue;
      const tgid = ent.user.telegramUserId;
      if (!tgid) {
        result.externalErrors += 1;
        console.warn(
          `[entitlements-sweep] warn3d skipped: entitlement ${ent.id} user has no telegramUserId (masked=${maskTGUid(0)})`,
        );
        continue;
      }
      let sent = true;
      if (!opts?.dryRun) {
        try {
          const r = await sendDirectMessage({ telegramUserId: tgid.toString(), text: build3dWarningText(ent as any), disableWebPagePreview: true });
          sent = r.success;
          if (!sent) {
            result.externalErrors += 1;
            console.warn(
              `[entitlements-sweep] warn3d sendMessage failed for user=${maskTGUid(tgid)}: code=dm_failed`,
            );
          }
        } catch (err) {
          sent = false;
          result.externalErrors += 1;
          console.warn(
            `[entitlements-sweep] warn3d sendMessage threw for user=${maskTGUid(tgid)}: code=dm_request_failed`,
          );
        }
      }
      if (sent && !opts?.dryRun) {
        await prisma.entitlement.update({ where: { id: ent.id }, data: { notify3dAt: now } });
      }
      if (sent) result.warned3d += 1;
    }
  } catch (err) {
    emitSafetyEvent(
      {
        event: "entitlements_warn3d_pass_failed",
        errorClass: "unknown",
        retryHint: 1,
        note: "3d_warning_pass_failed_may_include_db_or_dm",
      },
      err,
    );
    result.externalErrors += 1;
  }

  // ====== 3) 到期当日：通知 + 踢人（notifyExpiredAt IS NULL 做幂等）======
  try {
    const expiredCutoff = new Date(now.getTime() - GRACE_AFTER_EXPIRE_MS);
    const expiredPending = await prisma.entitlement.findMany({
      where: {
        status: "expired",
        notifyExpiredAt: null,
        expiresAt: { not: null, lt: expiredCutoff },
      },
      include: { user: { select: { telegramUserId: true, displayName: true } } },
    });
    for (const ent of expiredPending) {
      const tgid = ent.user.telegramUserId;
      let notified = true;
      if (tgid && !opts?.dryRun) {
        try {
          const r = await sendDirectMessage({ telegramUserId: tgid.toString(), text: buildExpiredText(ent as any), disableWebPagePreview: true });
          notified = r.success;
          if (!notified) {
            result.externalErrors += 1;
            console.warn(
              `[entitlements-sweep] expired sendMessage failed for user=${maskTGUid(tgid)}: code=dm_failed`,
            );
          }
        } catch (err) {
          notified = false;
          result.externalErrors += 1;
          console.warn(
            `[entitlements-sweep] expired sendMessage threw for user=${maskTGUid(tgid)}: code=dm_request_failed`,
          );
        }
      } else if (!tgid) {
        notified = true;
      }

      // kick 仅在有频道映射 + 有 tgid 时执行
      let kickedThis = false;
      const channelRef = getChannelRefForResource(ent.resourceType, ent.resourceId);
      if (!channelRef) {
        result.skippedMissingChannel += 1;
      } else if (!tgid) {
        result.externalErrors += 1;
        console.warn(
          `[entitlements-sweep] kick skipped: entitlement ${ent.id} user has no telegramUserId (masked=${maskTGUid(0)})`,
        );
      } else if (!opts?.dryRun) {
        try {
          const r = await kickChannelMember({ channel: toChannelRef(channelRef), telegramUserId: tgid.toString() });
          if (r.success) {
            kickedThis = true;
          } else {
            result.externalErrors += 1;
            console.warn(
              `[entitlements-sweep] kick failed for user=${maskTGUid(tgid)} on resource=${ent.resourceType}:${ent.resourceId.slice(0,8)}…: code=kick_failed`,
            );
          }
        } catch (err) {
          result.externalErrors += 1;
          console.warn(
            `[entitlements-sweep] kick threw for user=${maskTGUid(tgid)} on resource=${ent.resourceType}:${ent.resourceId.slice(0,8)}…: code=kick_request_failed`,
          );
        }
      }
      if (kickedThis) result.kicked += 1;

      // 只要不是所有外部步骤都硬失败（通知或踢人至少一个尝试过），就把 notifyExpiredAt 落库防重复
      // 若两者都没做（dry run 或都失败），保持 NULL 留待下次重试
      const didSomething = opts?.dryRun || notified || kickedThis || !channelRef;
      if (didSomething && !opts?.dryRun) {
        await prisma.entitlement.update({ where: { id: ent.id }, data: { notifyExpiredAt: now } });
      }
      if (notified) result.notifiedExpired += 1;
    }
  } catch (err) {
    emitSafetyEvent(
      {
        event: "entitlements_expired_notify_kick_failed",
        errorClass: "unknown",
        retryHint: 1,
        note: "expired_notify_plus_kick_pass_failed_may_include_db_or_dm_or_kick",
      },
      err,
    );
    result.externalErrors += 1;
  }

  const summary =
    `[entitlements-sweep] done @ ${result.ranAt}: expired=${result.markedExpired}, warn3d=${result.warned3d}, ` +
    `expired-notified=${result.notifiedExpired}, kicked=${result.kicked}, skipped-no-channel=${result.skippedMissingChannel}, errors=${result.externalErrors}`;
  emitStructuredLog({
    event: "entitlements_sweep_done",
    errorClass: result.externalErrors > 0 ? "db_error" : "business",
    retryHint: 0,
    note: result.externalErrors > 0 ? "sweep_done_with_errors" : "sweep_done_clean",
    counts: {
      markedExpired: result.markedExpired,
      warned3d: result.warned3d,
      notifiedExpired: result.notifiedExpired,
      kicked: result.kicked,
      skippedNoChannel: result.skippedMissingChannel,
      errors: result.externalErrors,
    },
  });
  return result;
}

export function startEntitlementsCron(prisma: PrismaClient, opts?: { intervalMs?: number; runImmediately?: boolean }): { stop: () => void; runOnce: () => Promise<SweepResult> } {
  const intervalMs = opts?.intervalMs ?? 60 * 60 * 1000; // 默认 1 小时
  let stopped = false;

  const runOnce = () => runEntitlementSweep(prisma).catch((err) => {
    emitSafetyEvent(
      {
        event: "entitlements_runonce_unhandled",
        errorClass: "unknown",
        retryHint: 1,
        note: "entitlements_runOnce_outer_catch_swallowed_unhandled",
      },
      err,
    );
    return { markedExpired: 0, warned3d: 0, notifiedExpired: 0, kicked: 0, skippedMissingChannel: 0, externalErrors: 1, ranAt: new Date().toISOString() } as SweepResult;
  });

  if (opts?.runImmediately !== false) {
    // 启动后 5s 跑第一次（给 DB/网络 留冷启动缓冲）
    setTimeout(() => { if (!stopped) runOnce(); }, 5000);
  }
  const timer = setInterval(() => { if (!stopped) runOnce(); }, intervalMs);
  // 防止 node:test 在 setInterval 挂着无法退出；只在生产才 unref（测试环境保留 ref）
  if (typeof (timer as any).unref === "function" && process.env.NODE_ENV === "production") {
    (timer as any).unref();
  }

  console.log(`[entitlements-sweep] cron scheduled: interval=${Math.round(intervalMs / 60000)}min, public-channel-hint=${TELEGRAM_CONFIG.publicChannelUrl}`);
  return {
    stop: () => { stopped = true; clearInterval(timer); },
    runOnce,
  };
}
