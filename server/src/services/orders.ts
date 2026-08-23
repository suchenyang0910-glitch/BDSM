import type { PrismaClient } from "@prisma/client";
import { kickChannelMember, sendDirectMessage, refMembershipMain, maskChatIdSafe, chatIdFingerprint } from "./telegramBot.js";
import { hmacSha256Hex, userIdIndexKey } from "../utils/crypto.js";
import { extractPrismaCodeOnly } from "../utils/structuredError.js";
import { verifyAndFreezePaymentAddressIntegrity } from "./paymentAddressIntegrity.js";
import { notifyPaymentSuccess } from "./paymentSuccessNotifier.js";

type Tx = any;

export const STARS_ORDER_EXPIRES_MS = 20 * 60 * 1000; // Stars 发票 20 分钟过期
export const USDT_ORDER_EXPIRES_MS = 20 * 60 * 1000;   // USDT 同窗口

export function starsPaymentPayloadForOrder(order: { orderNo: string; userId: string; amountMinor: bigint | number | string }): {
  payloadPlain: string;
  payloadHmac: string;
} {
  const plain = `stars:${order.orderNo}:u:${order.userId}:amt:${String(order.amountMinor)}:ts:${Date.now().toString(36)}`;
  return { payloadPlain: plain, payloadHmac: hmacSha256Hex(`order_payload:${plain}`) };
}

export function parseStarsPayloadPlain(plain: string): { orderNo: string; userId: string; amountMinorStr: string } | null {
  if (!plain || !plain.startsWith("stars:")) return null;
  const parts = plain.split(":");
  // stars INTyyyymmddXXXXXX u UUID amt 123 ts ...
  // 预期分割后:
  // [0]stars [1]INTyyyymmddXXXXXX [2]u [3]<uuid> [4]amt [5]<bigint> [6]ts [7]<hex>
  if (parts.length < 7) return null;
  const orderNo = parts[1];
  const userId = parts[3];
  const amountMinorStr = parts[5];
  if (!orderNo || !userId || !amountMinorStr) return null;
  return { orderNo, userId, amountMinorStr };
}

export function rawEventHashForTelegram(botKey: string, updateId: bigint | number | string, chargeId: string): string {
  return hmacSha256Hex(`tg_event:${botKey}:${String(updateId)}:${chargeId}`);
}

export function generateOrderNo(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
  return `INT${y}${m}${d}${rand}`;
}

export type MarkPaidResult = {
  order: any;
  entitlements: any[];
  idempotent: boolean;
};

export type CancelResult = { order: any; idempotent: boolean };
export type RefundResult = {
  order: any;
  revokedEntitlements: any[];
  idempotent: boolean;
  channelKicks: { entitlementId: string; success: boolean; error?: string }[];
  userNotified: boolean;
  notifyError?: string;
};

const beforeSnapshot = (o: any) => ({
  id: o.id,
  orderNo: o.orderNo,
  status: o.status,
  paidAt: o.paidAt ? o.paidAt.toISOString() : null,
  amountMinor: o.amountMinor?.toString() ?? null,
  currency: o.currency,
  entitlements: (o.entitlements || []).map((e: any) => ({
    id: e.id,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    status: e.status,
    expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
  })),
});

function membershipChannelId(): null {
  // 【Security Boundary - 细节2】orders 服务层同样不直接从 env 取明文 chatId；
  // 所有频道操作一律通过 ChannelRef（如 refMembershipMain()）交给 telegramBot 服务层解析。
  return null;
}

export async function markOrderPaid(
  prisma: PrismaClient,
  orderNo: string,
  opts: { adminId: string; reason: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<MarkPaidResult> {
  if (!opts.adminId) {
    const err: any = new Error("adminId is required for markOrderPaid");
    err.code = "ADMIN_UNAUTHORIZED";
    throw err;
  }
  if (!opts.reason || typeof opts.reason !== "string" || opts.reason.trim().length < 2) {
    const err: any = new Error("人工补单必须填写到账说明（至少 2 个字符）");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const order = await prisma.order.findUnique({
    where: { orderNo },
    include: {
      product: { include: { contentPackage: true, contents: true } },
      entitlements: true,
    },
  });
  if (!order) {
    const err: any = new Error("Order not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (order.status === "paid") {
    return { order, entitlements: order.entitlements, idempotent: true };
  }
  const nonPayable = ["failed", "refunded", "cancelled", "expired"];
  if (nonPayable.includes(order.status)) {
    const err: any = new Error(`Cannot mark ${order.status} order as paid`);
    err.code = "CONFLICT";
    throw err;
  }

  const result = await prisma.$transaction(async (tx: Tx) => {
    const updated = await tx.order.update({
      where: { id: order.id },
      data: { status: "paid", paidAt: new Date() },
      include: { product: { include: { contentPackage: true, contents: true } } },
    });

    const ptype = updated.product.type;
    let resourceType: "content" | "package" | "membership_channel";
    let resourceId: string;
    let expiresAt: Date | null = null;

    if (ptype === "membership") {
      resourceType = "membership_channel";
      resourceId = "membership-main";
      if (updated.product.durationDays && updated.product.durationDays > 0) {
        const nowMs = Date.now();
        const addMs = updated.product.durationDays * 24 * 60 * 60 * 1000;
        const existingActive = await tx.entitlement.findMany({
          where: {
            userId: updated.userId,
            resourceType: "membership_channel",
            resourceId: "membership-main",
            status: "active",
          },
          select: { expiresAt: true },
        });
        let baseMs = nowMs;
        for (const e of existingActive) {
          if (e.expiresAt && e.expiresAt.getTime() > baseMs) {
            baseMs = e.expiresAt.getTime();
          }
        }
        expiresAt = new Date(baseMs + addMs);
      }
    } else if (ptype === "package") {
      const pkg = updated.product.contentPackage;
      if (!pkg) {
        const e: any = new Error("Package product has no linked contentPackage");
        e.code = "CONFLICT";
        throw e;
      }
      resourceType = "package";
      resourceId = pkg.id;
    } else if (ptype === "single") {
      const first = updated.product.contents?.[0];
      if (!first) {
        const e: any = new Error("Single product has no linked content");
        e.code = "CONFLICT";
        throw e;
      }
      resourceType = "content";
      resourceId = first.id;
    } else {
      const e: any = new Error(`Unsupported product type: ${ptype}`);
      e.code = "CONFLICT";
      throw e;
    }

    const entitlement = await tx.entitlement.create({
      data: {
        userId: updated.userId,
        resourceType,
        resourceId,
        sourceOrderId: updated.id,
        startsAt: new Date(),
        expiresAt,
        status: "active",
      },
    });

    await tx.adminAuditLog.create({
      data: {
        adminId: opts.adminId,
        action: "admin.order.mark_paid",
        objectType: "order",
        objectId: orderNo,
        reason: opts.reason,
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
      },
    });

    return { order: updated, entitlements: [entitlement] };
  });

  return { ...result, idempotent: false };
}

export async function cancelOrder(
  prisma: PrismaClient,
  orderNo: string,
  opts: { adminId: string; reason: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<CancelResult> {
  if (!opts.adminId) {
    const err: any = new Error("adminId required for cancelOrder");
    err.code = "ADMIN_UNAUTHORIZED";
    throw err;
  }
  if (!opts.reason || opts.reason.trim().length < 2) {
    const err: any = new Error("取消说明至少 2 个字符");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const order = await prisma.order.findUnique({
    where: { orderNo },
    include: { entitlements: true },
  });
  if (!order) {
    const err: any = new Error("Order not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (order.status === "cancelled") return { order, idempotent: true };
  const allowCancel = ["pending", "processing", "expired", "failed"];
  if (!allowCancel.includes(order.status)) {
    const err: any = new Error(`Cannot cancel order in status ${order.status}; only ${allowCancel.join("/")} allowed`);
    err.code = "CONFLICT";
    throw err;
  }
  const before = beforeSnapshot(order);
  const updated = await prisma.$transaction(async (tx: Tx) => {
    const u = await tx.order.update({
      where: { id: order.id },
      data: { status: "cancelled" },
      include: { entitlements: true },
    });
    await tx.adminAuditLog.create({
      data: {
        adminId: opts.adminId,
        action: "admin.order.cancel",
        objectType: "order",
        objectId: orderNo,
        beforeValue: before as any,
        afterValue: beforeSnapshot(u) as any,
        reason: opts.reason,
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
      },
    });
    return u;
  });
  return { order: updated, idempotent: false };
}

export async function refundOrder(
  prisma: PrismaClient,
  orderNo: string,
  opts: { adminId: string; reason: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<RefundResult> {
  if (!opts.adminId) {
    const err: any = new Error("adminId required for refundOrder");
    err.code = "ADMIN_UNAUTHORIZED";
    throw err;
  }
  if (!opts.reason || opts.reason.trim().length < 2) {
    const err: any = new Error("退款说明至少 2 个字符");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const order = await prisma.order.findUnique({
    where: { orderNo },
    include: { entitlements: true, user: { select: { id: true, telegramUserId: true, displayName: true } } },
  });
  if (!order) {
    const err: any = new Error("Order not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (order.status === "refunded") {
    return {
      order,
      revokedEntitlements: order.entitlements.filter((e) => e.status === "revoked"),
      idempotent: true,
      channelKicks: [],
      userNotified: false,
    };
  }
  if (order.status !== "paid") {
    const err: any = new Error(`Cannot refund order in status ${order.status}; only "paid" allowed`);
    err.code = "CONFLICT";
    throw err;
  }
  const before = beforeSnapshot(order);
  // 【Security Boundary - 细节2】不直接持有明文 chatId，通过 ChannelRef 调用
  const tgid = order.user?.telegramUserId ? String(order.user.telegramUserId) : null;
  const toRevoke = order.entitlements.filter((e) => e.status === "active");

  const txResult = await prisma.$transaction(async (tx: Tx) => {
    const revokedList: any[] = [];
    for (const e of toRevoke) {
      const r = await tx.entitlement.update({
        where: { id: e.id },
        data: { status: "revoked" },
      });
      revokedList.push(r);
    }
    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: { status: "refunded" },
      include: { entitlements: true },
    });
    await tx.adminAuditLog.create({
      data: {
        adminId: opts.adminId,
        action: "admin.order.refund",
        objectType: "order",
        objectId: orderNo,
        beforeValue: before as any,
        afterValue: beforeSnapshot(updatedOrder) as any,
        reason: opts.reason,
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
      },
    });
    return { order: updatedOrder, revoked: revokedList };
  });

  const channelKicks: { entitlementId: string; success: boolean; error?: string }[] = [];
  if (tgid) {
    for (const e of txResult.revoked) {
      if (e.resourceType === "membership_channel") {
        try {
          const r = await kickChannelMember({ channel: refMembershipMain(), telegramUserId: tgid, allowReinvite: true });
          channelKicks.push({
            entitlementId: e.id,
            success: !!r.success,
            error: r.success ? undefined : (r.errorMessage ? "kick_failed" : undefined),
          });
        } catch (err: any) {
          channelKicks.push({ entitlementId: e.id, success: false, error: "kick_request_failed" });
        }
      }
    }
  }
  let userNotified = false;
  let notifyError: string | undefined;
  if (tgid) {
    try {
      const text = `【退款通知】您的订单 ${orderNo} 已处理退款。对应内容权益已回收。若有疑问请在客服会话中留言。`;
      const r = await sendDirectMessage({ telegramUserId: tgid, text, disableWebPagePreview: true });
      userNotified = !!r.success;
      if (!r.success) notifyError = r.errorMessage ? "notify_dm_failed" : undefined;
    } catch (err: any) {
      notifyError = "notify_dm_request_failed";
    }
  }
  // 【Security Boundary - 细节4】channelKicks 和 notifyError 中绝不包含明文 chatId / inviteLink / 用户资料
  // 这里已全部脱敏，仅保留成功/失败状态和错误类别码
  return {
    order: txResult.order,
    revokedEntitlements: txResult.revoked,
    idempotent: false,
    channelKicks,
    userNotified,
    notifyError,
  };
}

// ============================================================
// 【Sprint 3 V2 P0】Telegram Stars 支付成功交付（webhook 专用）
// 核心约束：
//   1) 仅在 successful_payment 后触发，pre_checkout_query 绝不发权益
//   2) 同事务中：校验订单未过期 + 用户匹配 + 金额匹配 + 幂等 → markOrderPaid → PaymentTransaction.confirmed 创建
//   3) 事务外再通知 Bot（不影响成功态）
// ============================================================

export type StarsSuccessfulDeliveryResult = {
  delivered: boolean;
  idempotent: boolean;
  errorClass?: string;
  orderNo?: string;
  entitlements?: any[];
};

export async function deliverStarsSuccessfulPayment(
  prisma: PrismaClient,
  opts: {
    telegramPaymentChargeId: string;
    rawEventHash: string;
    payloadPlain: string;
    telegramUserIdPlain: bigint | number | string;
    amountMinor: bigint | number | string;
    currency: string;
    botKey: string;
  },
): Promise<StarsSuccessfulDeliveryResult> {
  if (!opts.telegramPaymentChargeId) return { delivered: false, idempotent: false, errorClass: "missing_charge_id" };
  if (!opts.rawEventHash) return { delivered: false, idempotent: false, errorClass: "missing_event_hash" };
  const parsed = parseStarsPayloadPlain(opts.payloadPlain);
  if (!parsed) return { delivered: false, idempotent: false, errorClass: "bad_payload_plain" };
  const amountExpected = BigInt(parsed.amountMinorStr);
  const amountGot = BigInt(String(opts.amountMinor));
  if (amountExpected !== amountGot) {
    return { delivered: false, idempotent: false, errorClass: "amount_mismatch" };
  }
  if (!opts.currency || opts.currency.toUpperCase() !== "XTR") {
    return { delivered: false, idempotent: false, errorClass: "bad_currency" };
  }
  // 注意：telegramUserIdPlain 和 userId 不是强绑定，因为用户可能多设备用同一 TG 账号，
  // 但订单里的 user 在创建时一定有对应 telegramUserId，这里只做弱校验（用于 DM 通知）

  try {
    const order = await prisma.order.findUnique({
      where: { orderNo: parsed.orderNo },
      include: {
        product: { include: { contentPackage: true, contents: true } },
        entitlements: true,
        user: { select: { id: true, telegramUserId: true, displayName: true } },
      },
    });
    if (!order) return { delivered: false, idempotent: false, errorClass: "order_not_found", orderNo: parsed.orderNo };
    if (order.userId !== parsed.userId) return { delivered: false, idempotent: false, errorClass: "order_user_mismatch", orderNo: parsed.orderNo };
    if (BigInt(order.amountMinor.toString()) !== amountExpected) return { delivered: false, idempotent: false, errorClass: "order_amount_mismatch" };
    // 幂等：已 paid 直接返回成功（不重复发权益）
    if (order.status === "paid") {
      return { delivered: true, idempotent: true, orderNo: order.orderNo, entitlements: order.entitlements };
    }
    if ((order as any).expiresAt && new Date((order as any).expiresAt).getTime() < Date.now()) {
      // 过期但没 paid：标记 expired，写入 rejected 交易
      await prisma.$transaction(async (tx: Tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: "expired" } });
        try {
          await tx.paymentTransaction.create({
            data: {
              orderId: order.id,
              provider: "telegram",
              status: "rejected",
              providerChargeId: opts.telegramPaymentChargeId,
              amountMinor: amountGot,
              currency: opts.currency.toUpperCase(),
              rawEventHash: opts.rawEventHash,
              telegramPayloadHmac: (order as any).paymentPayloadHmac || undefined,
              receivedAt: new Date(),
              rejectedAt: new Date(),
              rejectReason: "expired_invoice_late_arrival",
            },
          });
        } catch { /* ignore unique conflict on rawEventHash */ }
      });
      return { delivered: false, idempotent: false, errorClass: "order_expired_before_fulfill", orderNo: order.orderNo };
    }
    const payable = ["pending", "processing"];
    if (!payable.includes(order.status)) {
      return { delivered: false, idempotent: false, errorClass: `order_status_${order.status}_not_payable`, orderNo: order.orderNo };
    }

    const result = await prisma.$transaction(async (tx: Tx) => {
      // 1) 同事务先尝试写入 payment_transaction（唯一约束 rawEventHash；同事件重投不重复）
      let txRow: any;
      try {
        txRow = await tx.paymentTransaction.create({
          data: {
            orderId: order.id,
            provider: "telegram",
            status: "confirmed",
            providerChargeId: opts.telegramPaymentChargeId,
            amountMinor: amountGot,
            currency: opts.currency.toUpperCase(),
            rawEventHash: opts.rawEventHash,
            telegramPayloadHmac: (order as any).paymentPayloadHmac || undefined,
            receivedAt: new Date(),
            confirmedAt: new Date(),
          },
        });
      } catch (e: any) {
        const code: string = e?.code || String(e?.name || "unknown");
        if (code === "P2002") {
          // rawEventHash 唯一：说明同事件已投递，幂等
          const already = await tx.order.findUnique({ where: { id: order.id }, include: { entitlements: true } });
          if (!already) return { delivered: false, idempotent: false, errorClass: "order_gone_after_conflict" };
          if (already.status === "paid") return { delivered: true, idempotent: true, orderNo: already.orderNo, entitlements: already.entitlements };
          // 理论上 transaction 表里已 confirmed 时 order 一定是 paid（因为同一事务）；
          // 极端竞争时这里可做补偿：把 order 推到 paid 再发权益
        }
        throw e; // 其他错误（如 DB 故障）向上抛，让 webhook 200 OK，但 Telegram 不再重投
      }

      // 2) 更新订单 paid + paidAt
      const paidAt = new Date();
      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          status: "paid",
          paidAt,
          providerOrderId: opts.telegramPaymentChargeId,
        },
        include: { product: { include: { contentPackage: true, contents: true } } },
      });

      // 3) 生成权益（与 markOrderPaid 内部权益生成逻辑一致）
      const ptype = updated.product.type;
      let resourceType: "content" | "package" | "membership_channel";
      let resourceId: string;
      let expiresAt: Date | null = null;
      if (ptype === "membership") {
        resourceType = "membership_channel";
        resourceId = "membership-main";
        if (updated.product.durationDays && updated.product.durationDays > 0) {
          const addMs = updated.product.durationDays * 24 * 60 * 60 * 1000;
          const existingActive = await tx.entitlement.findMany({
            where: { userId: updated.userId, resourceType: "membership_channel", resourceId: "membership-main", status: "active" },
            select: { expiresAt: true },
          });
          let baseMs = Date.now();
          for (const e of existingActive) {
            if (e.expiresAt && e.expiresAt.getTime() > baseMs) baseMs = e.expiresAt.getTime();
          }
          expiresAt = new Date(baseMs + addMs);
        }
      } else if (ptype === "package") {
        const pkg = updated.product.contentPackage;
        if (!pkg) throw Object.assign(new Error("Package product has no linked contentPackage"), { code: "CONFLICT" });
        resourceType = "package";
        resourceId = pkg.id;
      } else if (ptype === "single") {
        const first = updated.product.contents?.[0];
        if (!first) throw Object.assign(new Error("Single product has no linked content"), { code: "CONFLICT" });
        resourceType = "content";
        resourceId = first.id;
      } else {
        throw Object.assign(new Error(`Unsupported product type: ${ptype}`), { code: "CONFLICT" });
      }
      const entitlement = await tx.entitlement.create({
        data: {
          userId: updated.userId,
          resourceType,
          resourceId,
          sourceOrderId: updated.id,
          startsAt: new Date(),
          expiresAt,
          status: "active",
        },
      });
      void txRow;
      return { order: updated, entitlements: [entitlement] };
    });

    // 事务外：通知用户（不抛错，成功与否都不改变 delivered=true）
    const tgid = order.user?.telegramUserId ? BigInt(order.user.telegramUserId.toString()) : null;
    if (tgid) {
      (async () => {
        try {
          const ttl = Math.floor(STARS_ORDER_EXPIRES_MS / 60000);
          const text = `【支付成功】订单 ${order.orderNo} 已确认。您的权益已发放；若为频道/内容包交付，Mini App 内刷新即可解锁。客服会话留言将在 24h 内响应。`;
          await sendDirectMessage({ telegramUserId: tgid, text, disableWebPagePreview: true });
          void ttl;
        } catch { /* swallow notify errors */ }
      })().catch(() => {});
    }
    // 事务已经提交；运营提醒失败绝不影响订单/权益。
    await notifyPaymentSuccess({
      orderNo: result.order.orderNo,
      paymentMethod: "telegram_stars",
      amountMinor: amountGot,
      currency: opts.currency,
      productTitle: result.order.product?.title,
    });
    return { delivered: true, idempotent: false, orderNo: result.order.orderNo, entitlements: result.entitlements };
  } catch (e: any) {
    const prismaCode = extractPrismaCodeOnly(e);
    return { delivered: false, idempotent: false, errorClass: prismaCode ? `tx_${prismaCode}` : "exception_unknown" };
  }
}

// ============================================================
// 【Sprint 3 V2 P1】USDT-TRC20 链上事件认单
//   · 入口：内网 POST /internal/usdt/chain-event（由独立链监听 worker 调用，不公网暴露）
//   · detected → confirming → confirmed 三态；confirmations 达目标才走 paid
//   · 幂等两级：① rawEventHash (usdt:<source>:<network>:<txHash>) UNIQUE；② order.status === 'paid' 短路
//   · 严格校验：network = tron_trc20；tokenContract 正确；toAddress ∈ 地址池；amount 与尾数精确匹配；未过期
// ============================================================
export type UsdtChainEventConfirmResult = {
  status: "detected" | "confirming" | "confirmed" | "rejected" | "idempotent";
  idempotent: boolean;
  orderNo?: string;
  txId?: string;
  rejectReason?: string;
  errorClass?: string;
  entitlements?: any[];
};

export function rawEventHashForUsdt(source: string, network: string, txHash: string, logIndex: number = 0): string {
  return hmacSha256Hex(`usdt_event:${source}:${network}:${txHash}:${logIndex}`);
}

export async function confirmUsdtChainEvent(
  prisma: PrismaClient,
  opts: {
    source: string;
    network: string;
    txHash: string;
    logIndex?: number;
    tokenContract: string;
    fromAddress: string;
    toAddress: string;
    amountMinor: bigint | number | string;
    blockNumber: bigint | number | string;
    confirmations: number;
    confirmationsTarget?: number;
    receivedAt?: Date;
    acceptedTokenContracts?: string[];
  },
): Promise<UsdtChainEventConfirmResult> {
  const acceptedTokens = Array.isArray(opts.acceptedTokenContracts) && opts.acceptedTokenContracts.length > 0
    ? opts.acceptedTokenContracts.map((s) => s.trim())
    : ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"];
  const confirmationsTarget =
    typeof opts.confirmationsTarget === "number" && opts.confirmationsTarget > 0
      ? opts.confirmationsTarget
      : 19;

  if (!opts.txHash) return { status: "rejected", idempotent: false, rejectReason: "missing_tx_hash" };
  if (!opts.network || opts.network.toLowerCase() !== "tron_trc20") {
    return { status: "rejected", idempotent: false, rejectReason: "unsupported_network" };
  }
  if (!opts.tokenContract || !acceptedTokens.includes(opts.tokenContract.trim())) {
    return { status: "rejected", idempotent: false, rejectReason: "bad_token_contract" };
  }
  if (!opts.toAddress || !String(opts.toAddress).startsWith("T")) {
    return { status: "rejected", idempotent: false, rejectReason: "bad_to_address" };
  }
  const amountMinor = BigInt(String(opts.amountMinor));
  if (amountMinor <= 0n) {
    return { status: "rejected", idempotent: false, rejectReason: "bad_amount" };
  }
  const confirmations = Number(opts.confirmations || 0);
  const rawEventHash = rawEventHashForUsdt(opts.source || "default", opts.network, opts.txHash, opts.logIndex ?? 0);

  // 匹配订单
  const candidateOrder: any = await prisma.order.findFirst({
    where: {
      paymentMethod: "usdt_trc20_external",
      status: { in: ["pending", "processing", "paid"] },
      amountMinor,
      usdtPaymentAddress: { address: opts.toAddress.trim() },
    },
    orderBy: [{ createdAt: "desc" }],
    include: { usdtPaymentAddress: true, product: true, user: true },
  });

  if (!candidateOrder) {
    // 无匹配订单 → 入库 rejected + rejectReason=no_matching_order（便于人工复核），rawEventHash 唯一
    try {
      await prisma.paymentTransaction.create({
        data: {
          orderId: "00000000-0000-0000-0000-000000000000",
          provider: "tron",
          status: "rejected",
          providerChargeId: opts.txHash,
          network: opts.network,
          tokenContract: opts.tokenContract,
          toAddress: opts.toAddress,
          fromAddress: opts.fromAddress,
          amountMinor,
          currency: "USDT",
          confirmations,
          confirmationsTarget,
          rawEventHash,
          blockNumber: opts.blockNumber ? BigInt(String(opts.blockNumber)) : null,
          receivedAt: opts.receivedAt || new Date(),
          rejectedAt: new Date(),
          rejectReason: "no_matching_order_or_amount",
        },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        return { status: "idempotent", idempotent: true };
      }
      return { status: "rejected", idempotent: false, errorClass: `tx_${e?.code}`, rejectReason: "db_error" };
    }
    return { status: "rejected", idempotent: false, rejectReason: "no_matching_order_or_amount" };
  }

  const integrity = await verifyAndFreezePaymentAddressIntegrity(prisma, candidateOrder.usdtPaymentAddress, "confirm");
  if (!integrity.ok || candidateOrder.usdtPaymentAddress?.status !== "assigned") {
    try {
      await prisma.paymentTransaction.create({
        data: {
          orderId: candidateOrder.id,
          provider: "tron",
          status: "rejected",
          providerChargeId: opts.txHash,
          network: opts.network,
          tokenContract: opts.tokenContract,
          toAddress: opts.toAddress,
          fromAddress: opts.fromAddress,
          amountMinor,
          currency: "USDT",
          confirmations,
          confirmationsTarget,
          rawEventHash,
          blockNumber: opts.blockNumber ? BigInt(String(opts.blockNumber)) : null,
          receivedAt: opts.receivedAt || new Date(),
          rejectedAt: new Date(),
          rejectReason: !integrity.ok ? "payment_address_integrity_failed" : "payment_address_not_assigned",
        },
      });
    } catch (e: any) {
      if (e?.code === "P2002") return { status: "idempotent", idempotent: true };
    }
    return {
      status: "rejected",
      idempotent: false,
      rejectReason: !integrity.ok ? "payment_address_integrity_failed" : "payment_address_not_assigned",
    };
  }

  if (candidateOrder.status === "paid") {
    return { status: "confirmed", idempotent: true, orderNo: candidateOrder.orderNo };
  }

  const expired = candidateOrder.expiresAt && new Date(candidateOrder.expiresAt).getTime() < Date.now();
  if (expired) {
    try {
      await prisma.$transaction(async (tx: Tx) => {
        await tx.order.update({
          where: { id: candidateOrder.id },
          data: {
            status: "expired",
            rejectedAt: new Date(),
            rejectReason: "usdt_payment_arrived_after_expiry",
          },
        });
        try {
          await tx.paymentTransaction.create({
            data: {
              orderId: candidateOrder.id,
              provider: "tron",
              status: "rejected",
              providerChargeId: opts.txHash,
              network: opts.network,
              tokenContract: opts.tokenContract,
              toAddress: opts.toAddress,
              fromAddress: opts.fromAddress,
              amountMinor,
              currency: "USDT",
              confirmations,
              confirmationsTarget,
              rawEventHash,
              blockNumber: opts.blockNumber ? BigInt(String(opts.blockNumber)) : null,
              receivedAt: opts.receivedAt || new Date(),
              rejectedAt: new Date(),
              rejectReason: "usdt_payment_arrived_after_expiry",
            },
          });
        } catch (ee: any) {
          if (ee?.code !== "P2002") throw ee;
        }
      });
    } catch (e: any) {
      return { status: "rejected", idempotent: false, errorClass: `tx_${e?.code}`, rejectReason: "expired_order_db_error" };
    }
    return { status: "rejected", idempotent: false, rejectReason: "order_expired_before_confirmation" };
  }

  const needConfirmingOnly = confirmations < confirmationsTarget;

  try {
    const result = await prisma.$transaction(async (tx: Tx) => {
      const fresh: any = await tx.order.findUnique({ where: { id: candidateOrder.id } });
      if (!fresh) throw Object.assign(new Error("order_gone"), { code: "NOT_FOUND" });
      if (fresh.status === "paid") {
        return { idempotentPaid: true } as any;
      }
      if (!["pending", "processing"].includes(String(fresh.status))) {
        throw Object.assign(new Error(`bad_order_status_${fresh.status}`), { code: "CONFLICT" });
      }

      const newStatus: any = needConfirmingOnly ? "confirming" : "confirmed";
      const now = new Date();
      const existingTx: any = await tx.paymentTransaction.findUnique({ where: { rawEventHash } });
      let txRow: any;
      if (existingTx) {
        if (existingTx.status === "confirmed") {
          return { idempotentPaid: true } as any;
        }
        const updateData: any = { confirmations };
        if (needConfirmingOnly) {
          updateData.status = "confirming";
        } else {
          updateData.status = "confirmed";
          updateData.confirmedAt = now;
          if (opts.blockNumber) updateData.blockNumber = BigInt(String(opts.blockNumber));
        }
        txRow = await tx.paymentTransaction.update({
          where: { id: existingTx.id },
          data: updateData,
        });
      } else {
        txRow = await tx.paymentTransaction.create({
          data: {
            orderId: fresh.id,
            provider: "tron",
            status: newStatus,
            providerChargeId: opts.txHash,
            network: opts.network,
            tokenContract: opts.tokenContract,
            toAddress: opts.toAddress,
            fromAddress: opts.fromAddress,
            amountMinor,
            currency: "USDT",
            confirmations,
            confirmationsTarget,
            rawEventHash,
            blockNumber: opts.blockNumber ? BigInt(String(opts.blockNumber)) : null,
            receivedAt: opts.receivedAt || now,
            confirmedAt: needConfirmingOnly ? null : now,
          },
        });
      }

      if (needConfirmingOnly) {
        const orderStatus: any = fresh.status === "pending" ? "processing" : fresh.status;
        if (orderStatus !== fresh.status) {
          await tx.order.update({
            where: { id: fresh.id },
            data: { status: orderStatus as any },
          });
        }
        return { stage: "confirming" as const, txRow, orderStatus } as any;
      }

      // confirmed: markOrderPaid
      const updated = await tx.order.update({
        where: { id: fresh.id },
        data: {
          status: "paid",
          paidAt: new Date(),
          providerOrderId: opts.txHash,
        },
        include: { product: { include: { contentPackage: true, contents: true } }, user: true },
      });
      let resourceType: any = null;
      let resourceId: any = null;
      let expiresAt: any = null;
      const ptype = updated.product?.type;
      if (ptype === "membership") {
        resourceType = "membership_channel";
        resourceId = "membership-main";
        if (!updated.product.durationDays) throw Object.assign(new Error("Membership product missing durationDays"), { code: "CONFLICT" });
        const addMs = updated.product.durationDays * 24 * 60 * 60 * 1000;
        const existingActive = await tx.entitlement.findMany({
          where: { userId: updated.userId, resourceType: "membership_channel", resourceId: "membership-main", status: "active" },
          select: { expiresAt: true },
        });
        let baseMs = Date.now();
        for (const e of existingActive) {
          if (e.expiresAt && e.expiresAt.getTime() > baseMs) baseMs = e.expiresAt.getTime();
        }
        expiresAt = new Date(baseMs + addMs);
      } else if (ptype === "package") {
        const pkg = updated.product.contentPackage;
        if (!pkg) throw Object.assign(new Error("Package product has no linked contentPackage"), { code: "CONFLICT" });
        resourceType = "package";
        resourceId = pkg.id;
      } else if (ptype === "single") {
        const first = updated.product.contents?.[0];
        if (!first) throw Object.assign(new Error("Single product has no linked content"), { code: "CONFLICT" });
        resourceType = "content";
        resourceId = first.id;
      } else {
        throw Object.assign(new Error(`Unsupported product type: ${ptype}`), { code: "CONFLICT" });
      }
      const entitlement = await tx.entitlement.create({
        data: {
          userId: updated.userId,
          resourceType,
          resourceId,
          sourceOrderId: updated.id,
          startsAt: new Date(),
          expiresAt,
          status: "active",
        },
      });
      return { stage: "confirmed" as const, txRow, order: updated, entitlements: [entitlement] } as any;
    });

    if ((result as any).idempotentPaid) {
      return { status: "confirmed", idempotent: true, orderNo: candidateOrder.orderNo };
    }
    if ((result as any).stage === "confirming") {
      return {
        status: "confirming",
        idempotent: false,
        orderNo: candidateOrder.orderNo,
        txId: (result as any).txRow?.id,
      };
    }
    // confirmed: 事务外 notify
    const tgid = candidateOrder.user?.telegramUserId ? BigInt(candidateOrder.user.telegramUserId.toString()) : null;
    if (tgid) {
      (async () => {
        try {
          const text = `【USDT 支付成功】订单 ${candidateOrder.orderNo}，金额 ${Number(amountMinor) / 1_000_000} USDT-TRC20 已确认入账（${confirmations}/${confirmationsTarget} 区块）。权益已发放。`;
          await sendDirectMessage({ telegramUserId: tgid, text, disableWebPagePreview: true });
        } catch { /* ignore */ }
      })().catch(() => {});
    }
    // 链上确认达标且 DB 事务提交后，再尝试通知运营；失败不影响已发放权益。
    await notifyPaymentSuccess({
      orderNo: (result as any).order.orderNo,
      paymentMethod: "usdt_trc20",
      amountMinor,
      currency: "USDT",
      productTitle: (result as any).order.product?.title,
    });
    return {
      status: "confirmed",
      idempotent: false,
      orderNo: (result as any).order.orderNo,
      txId: (result as any).txRow?.id,
      entitlements: (result as any).entitlements,
    };
  } catch (e: any) {
    if (e?.code === "P2002") {
      return { status: "idempotent", idempotent: true, orderNo: candidateOrder.orderNo };
    }
    const prismaCode = extractPrismaCodeOnly(e);
    return {
      status: "rejected",
      idempotent: false,
      errorClass: prismaCode ? `tx_${prismaCode}` : "exception_unknown",
      rejectReason: "tx_commit_error",
    };
  }
}
