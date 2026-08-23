import type { PrismaClient, Entitlement } from "@prisma/client";
import {
  kickChannelMember,
  sendDirectMessage,
  refManagedChat,
} from "./telegramBot.js";
import { resolvePackageChannelId } from "./channelCrypto.js";
import { decryptChatIdAesGcm, userIdIndexKey } from "../utils/crypto.js";
import { emitSafetyEvent, emitStructuredLog } from "../utils/structuredError.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LOOKAHEAD_MS = FOUR_DAYS_MS();

function FOUR_DAYS_MS() {
  return 4 * 24 * 60 * 60 * 1000;
}

export type SweepResult = {
  markedExpired: number;
  enteredGrace: number;
  remindedExpired: number;
  remindedPreGrace: number;
  renewedSkipped: number;
  removed: number;
  failed: number;
  ranAt: string;
};

function maskTGUid(tgid: bigint | number | string): string {
  return `uidfp:${userIdIndexKey(tgid).slice(0, 8)}…`;
}

function safeCode(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err || "");
  const tg = raw.match(/\[(\d{3})\]/)?.[1];
  return tg ? `tg_${tg}` : fallback;
}

function buildExpiredReminderText(ent: { resourceType: string; resourceId: string; expiresAt: Date; graceEndsAt: Date }): string {
  const expires = ent.expiresAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const grace = ent.graceEndsAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (ent.resourceType === "membership_channel") {
    return `【同频 · 会员已到期】\n你的会员权益已于 ${expires} 到期，现已进入 3 天宽限期，宽限截止：${grace}。\n宽限期内频道访问暂时保留；若在截止前完成续费，将自动取消清理任务。\n请打开同频 Mini App 完成续费。`;
  }
  return `【同频 · 内容包已到期】\n你购买的内容包权益已于 ${expires} 到期，现已进入 3 天宽限期，宽限截止：${grace}。\n宽限期内频道访问暂时保留；若在截止前完成续费，将自动取消清理任务。\n请打开同频 Mini App 完成续费。`;
}

function buildPreGraceReminderText(ent: { resourceType: string; resourceId: string; graceEndsAt: Date }): string {
  const grace = ent.graceEndsAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (ent.resourceType === "membership_channel") {
    return `【同频 · 会员宽限即将结束】\n你的会员权益宽限期将于 ${grace} 结束。\n如届时仍无新的有效会员权益，系统会自动移出会员主频道；完成续费后将取消清理。`;
  }
  return `【同频 · 内容包宽限即将结束】\n你的内容包宽限期将于 ${grace} 结束。\n如届时仍无新的有效内容包权益，系统会自动移出对应私密频道；完成续费后将取消清理。`;
}

async function resolveMembershipMainChatId(prisma: PrismaClient): Promise<bigint | null> {
  const row = await prisma.adminManagedChannel.findFirst({
    where: { purpose: "membership_main" },
    select: { deprecatedChatIdBig: true, chatIdCiphertextB64: true },
    orderBy: [{ updatedAt: "desc" }],
  });
  if (typeof row?.deprecatedChatIdBig === "bigint") return row.deprecatedChatIdBig;
  if (row?.chatIdCiphertextB64) {
    try { return decryptChatIdAesGcm(row.chatIdCiphertextB64); } catch { return null; }
  }
  return null;
}

async function resolveCleanupChannelChatId(prisma: PrismaClient, ent: Pick<Entitlement, "resourceType" | "resourceId">): Promise<bigint | null> {
  if (ent.resourceType === "membership_channel" && ent.resourceId === "membership-main") {
    return resolveMembershipMainChatId(prisma);
  }
  if (ent.resourceType === "package") {
    const pkg = await prisma.contentPackage.findUnique({
      where: { id: ent.resourceId },
      select: { channelId: true, channelIdCiphertext: true },
    });
    if (!pkg) return null;
    return resolvePackageChannelId({ channelId: pkg.channelId, channelIdCiphertext: pkg.channelIdCiphertext });
  }
  return null;
}

async function hasRenewedEntitlement(prisma: PrismaClient, ent: Pick<Entitlement, "id" | "userId" | "resourceType" | "resourceId">, now: Date): Promise<boolean> {
  const renewed = await prisma.entitlement.findFirst({
    where: {
      id: { not: ent.id },
      userId: ent.userId,
      resourceType: ent.resourceType,
      resourceId: ent.resourceId,
      status: "active",
      startsAt: { lte: now },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    select: { id: true },
  });
  return !!renewed;
}

async function sendReminderAndUpdate(
  prisma: PrismaClient,
  ent: any,
  field: "expiryReminderAt" | "preGraceReminderAt",
  text: string,
  now: Date,
): Promise<{ sent: boolean; errorCode: string | null }> {
  const tgid = ent.user?.telegramUserId;
  if (!tgid) {
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: { lastRemovalErrorCode: "missing_telegram_user_id" },
    });
    return { sent: false, errorCode: "missing_telegram_user_id" };
  }
  try {
    const dm = await sendDirectMessage({
      telegramUserId: tgid.toString(),
      text,
      disableWebPagePreview: true,
    });
    if (!dm.success) {
      const code = safeCode(dm.errorMessage || "dm_failed", "dm_failed");
      await prisma.entitlement.update({
        where: { id: ent.id },
        data: { lastRemovalErrorCode: code },
      });
      return { sent: false, errorCode: code };
    }
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: {
        [field]: now,
        expiryReminderCount: (ent.expiryReminderCount || 0) + 1,
        lastRemovalErrorCode: null,
      },
    });
    return { sent: true, errorCode: null };
  } catch (err) {
    const code = safeCode(err, "dm_request_failed");
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: { lastRemovalErrorCode: code },
    });
    return { sent: false, errorCode: code };
  }
}

export async function processEntitlementGraceCleanup(
  prisma: PrismaClient,
  entitlementId: string,
  opts?: { now?: Date },
): Promise<{ ok: boolean; action: string; errorCode?: string | null }> {
  const now = opts?.now ?? new Date();
  const ent = await prisma.entitlement.findUnique({
    where: { id: entitlementId },
    include: {
      user: { select: { telegramUserId: true, displayName: true } },
    },
  });
  if (!ent) return { ok: false, action: "not_found", errorCode: "entitlement_not_found" };
  if (!ent.expiresAt) return { ok: true, action: "skip_no_expiry" };
  if (!["membership_channel", "package"].includes(ent.resourceType)) return { ok: true, action: "skip_resource_type" };

  const graceEndsAt = ent.graceEndsAt ?? new Date(ent.expiresAt.getTime() + THREE_DAYS_MS);

  if (ent.status === "active" && ent.expiresAt.getTime() <= now.getTime()) {
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: {
        status: "expired",
        graceEndsAt,
        removalStatus: "grace_period",
      },
    });
  } else if (!ent.graceEndsAt) {
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: { graceEndsAt },
    });
  }

  const renewed = await hasRenewedEntitlement(prisma, ent, now);
  if (renewed) {
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: {
        removalStatus: "renewed_during_grace",
        lastRemovalErrorCode: null,
      },
    });
    return { ok: true, action: "renewed_during_grace" };
  }

  const fresh = await prisma.entitlement.findUnique({
    where: { id: ent.id },
    include: { user: { select: { telegramUserId: true, displayName: true } } },
  });
  if (!fresh) return { ok: false, action: "reload_failed", errorCode: "entitlement_reload_failed" };
  if (!fresh.expiresAt) return { ok: true, action: "skip_no_expiry_after_reload" };

  if (!fresh.expiryReminderAt && now.getTime() >= fresh.expiresAt.getTime()) {
    const sent = await sendReminderAndUpdate(
      prisma,
      fresh,
      "expiryReminderAt",
      buildExpiredReminderText({ resourceType: fresh.resourceType, resourceId: fresh.resourceId, expiresAt: fresh.expiresAt, graceEndsAt }),
      now,
    );
    if (!sent.sent) return { ok: false, action: "expiry_reminder_failed", errorCode: sent.errorCode };
    return { ok: true, action: "expiry_reminded" };
  }

  if (!fresh.preGraceReminderAt && now.getTime() >= graceEndsAt.getTime() - ONE_DAY_MS && now.getTime() < graceEndsAt.getTime()) {
    const sent = await sendReminderAndUpdate(
      prisma,
      fresh,
      "preGraceReminderAt",
      buildPreGraceReminderText({ resourceType: fresh.resourceType, resourceId: fresh.resourceId, graceEndsAt }),
      now,
    );
    if (!sent.sent) return { ok: false, action: "pre_grace_reminder_failed", errorCode: sent.errorCode };
    return { ok: true, action: "pre_grace_reminded" };
  }

  if (now.getTime() < graceEndsAt.getTime()) {
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: {
        graceEndsAt,
        removalStatus: "grace_period",
      },
    });
    return { ok: true, action: "grace_waiting" };
  }

  const renewedAtFinalCheck = await hasRenewedEntitlement(prisma, ent, now);
  if (renewedAtFinalCheck) {
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: {
        removalStatus: "renewed_during_grace",
        lastRemovalErrorCode: null,
      },
    });
    return { ok: true, action: "renewed_before_kick" };
  }

  const channelChatId = await resolveCleanupChannelChatId(prisma, ent);
  if (!channelChatId) {
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: {
        graceEndsAt,
        removalStatus: "removal_failed",
        removalAttemptedAt: now,
        lastRemovalErrorCode: "channel_not_configured",
      },
    });
    return { ok: false, action: "channel_missing", errorCode: "channel_not_configured" };
  }

  const tgid = fresh.user?.telegramUserId;
  if (!tgid) {
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: {
        graceEndsAt,
        removalStatus: "removal_failed",
        removalAttemptedAt: now,
        lastRemovalErrorCode: "missing_telegram_user_id",
      },
    });
    return { ok: false, action: "user_missing_tgid", errorCode: "missing_telegram_user_id" };
  }

  try {
    const kicked = await kickChannelMember({
      channel: refManagedChat(channelChatId),
      telegramUserId: tgid.toString(),
      allowReinvite: true,
    });
    if (!kicked.success) {
      const code = safeCode(kicked.errorMessage || "kick_failed", "kick_failed");
      await prisma.entitlement.update({
        where: { id: ent.id },
        data: {
          graceEndsAt,
          removalStatus: "removal_failed",
          removalAttemptedAt: now,
          lastRemovalErrorCode: code,
        },
      });
      return { ok: false, action: "kick_failed", errorCode: code };
    }
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: {
        graceEndsAt,
        removalStatus: "removed",
        removalAttemptedAt: now,
        removedAt: now,
        lastRemovalErrorCode: null,
      },
    });
    return { ok: true, action: "removed" };
  } catch (err) {
    const code = safeCode(err, "kick_request_failed");
    await prisma.entitlement.update({
      where: { id: ent.id },
      data: {
        graceEndsAt,
        removalStatus: "removal_failed",
        removalAttemptedAt: now,
        lastRemovalErrorCode: code,
      },
    });
    return { ok: false, action: "kick_request_failed", errorCode: code };
  }
}

export async function runEntitlementSweep(prisma: PrismaClient): Promise<SweepResult> {
  const now = new Date();
  const result: SweepResult = {
    markedExpired: 0,
    enteredGrace: 0,
    remindedExpired: 0,
    remindedPreGrace: 0,
    renewedSkipped: 0,
    removed: 0,
    failed: 0,
    ranAt: now.toISOString(),
  };

  try {
    const rows = await prisma.entitlement.findMany({
      where: {
        resourceType: { in: ["membership_channel", "package"] },
        expiresAt: { not: null, lte: new Date(now.getTime() + LOOKAHEAD_MS) },
        status: { in: ["active", "expired"] },
      },
      select: { id: true },
      take: 500,
      orderBy: [{ expiresAt: "asc" }],
    });

    for (const row of rows) {
      const processed = await processEntitlementGraceCleanup(prisma, row.id, { now });
      switch (processed.action) {
        case "grace_waiting":
          result.enteredGrace += 1;
          break;
        case "expiry_reminded":
          result.markedExpired += 1;
          result.remindedExpired += 1;
          break;
        case "pre_grace_reminded":
          result.remindedPreGrace += 1;
          break;
        case "renewed_during_grace":
        case "renewed_before_kick":
          result.renewedSkipped += 1;
          break;
        case "removed":
          result.removed += 1;
          break;
        default:
          if (!processed.ok) result.failed += 1;
          break;
      }
    }
  } catch (err) {
    emitSafetyEvent(
      {
        event: "entitlements_sweep_failed",
        errorClass: "db_error",
        note: "entitlement_grace_cleanup_sweep_failed",
      },
      err,
    );
    result.failed += 1;
  }

  emitStructuredLog({
    event: "entitlements_sweep_done",
    errorClass: result.failed > 0 ? "db_error" : "business",
    note: result.failed > 0 ? "grace_cleanup_done_with_failures" : "grace_cleanup_done_clean",
    counts: {
      enteredGrace: result.enteredGrace,
      remindedExpired: result.remindedExpired,
      remindedPreGrace: result.remindedPreGrace,
      renewedSkipped: result.renewedSkipped,
      removed: result.removed,
      failed: result.failed,
    },
  });
  return result;
}

export function startEntitlementsCron(
  prisma: PrismaClient,
  opts?: { intervalMs?: number; runImmediately?: boolean },
): { stop: () => void; runOnce: () => Promise<SweepResult> } {
  const intervalMs = opts?.intervalMs ?? SIX_HOURS_MS;
  let stopped = false;

  const runOnce = () => runEntitlementSweep(prisma).catch((err) => {
    emitSafetyEvent(
      {
        event: "entitlements_runonce_unhandled",
        errorClass: "unknown",
        note: "grace_cleanup_run_once_unhandled",
      },
      err,
    );
    return {
      markedExpired: 0,
      enteredGrace: 0,
      remindedExpired: 0,
      remindedPreGrace: 0,
      renewedSkipped: 0,
      removed: 0,
      failed: 1,
      ranAt: new Date().toISOString(),
    };
  });

  if (opts?.runImmediately !== false) {
    setTimeout(() => { if (!stopped) void runOnce(); }, 5000);
  }
  const timer = setInterval(() => { if (!stopped) void runOnce(); }, intervalMs);
  try { (timer as any).unref?.(); } catch {}

  return {
    stop: () => { stopped = true; clearInterval(timer); },
    runOnce,
  };
}
