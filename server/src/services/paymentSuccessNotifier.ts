import { formatMinorAmountForDisplay } from "../utils/currency.js";
import { emitSafetyEvent } from "../utils/structuredError.js";
import { sendDirectMessage, type SendDirectMessageResult } from "./telegramBot.js";

const RECIPIENTS_ENV = "PAYMENT_SUCCESS_NOTIFY_TELEGRAM_USER_IDS";

type SendDirectMessage = (opts: {
  telegramUserId: bigint | number | string;
  text: string;
  disableWebPagePreview?: boolean;
}) => Promise<SendDirectMessageResult>;

export type PaymentSuccessNotification = {
  orderNo: string;
  paymentMethod: "telegram_stars" | "usdt_trc20" | "manual";
  amountMinor: bigint | number | string;
  currency: string;
  productTitle?: string | null;
  /** 仅平台昵称；不得传 Telegram 名、用户名、手机号或收款地址。 */
  userDisplayName?: string | null;
};

/**
 * 只接受 Telegram 数字用户 ID，去重且不把 ID 写入日志、审计或响应。
 * 未配置时静默禁用，支付和权益交付永远不受影响。
 */
export function loadPaymentSuccessNotifyRecipients(raw = process.env[RECIPIENTS_ENV] || ""): bigint[] {
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const value of raw.split(",")) {
    const normalized = value.trim();
    if (!/^\d{5,20}$/.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(BigInt(normalized));
  }
  return out;
}

function maskOrderNo(orderNo: string): string {
  const value = String(orderNo || "").trim();
  if (value.length <= 6) return "已确认";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

function safeProductTitle(value: string | null | undefined): string {
  const normalized = String(value || "").replace(/[\r\n\t]/g, " ").trim();
  return normalized ? normalized.slice(0, 48) : "内容权益";
}

function safePlatformNickname(value: string | null | undefined): string {
  const normalized = String(value || "").replace(/[\r\n\t]/g, " ").trim();
  return normalized ? normalized.slice(0, 32) : "同频成员";
}

export function buildPaymentSuccessNotificationText(input: PaymentSuccessNotification): string {
  const method = input.paymentMethod === "telegram_stars"
    ? "Telegram Stars"
    : input.paymentMethod === "usdt_trc20"
    ? "USDT-TRC20"
    : "人工确认";
  const amount = formatMinorAmountForDisplay(input.amountMinor, input.currency);
  const unit = String(input.currency || "").toUpperCase() === "XTR" ? "Stars" : String(input.currency || "").toUpperCase();
  return [
    "【同频 · 支付成功】",
    `用户：${safePlatformNickname(input.userDisplayName)}`,
    `订单：${maskOrderNo(input.orderNo)}`,
    `方式：${method}`,
    `商品：${safeProductTitle(input.productTitle)}`,
    `金额：${amount} ${unit}`.trim(),
    "权益：已完成发放。",
  ].join("\n");
}

/**
 * 支付事务提交后调用。通知仅为运营提醒：任何异常都被隔离，绝不回滚订单或权益。
 */
export async function notifyPaymentSuccess(
  input: PaymentSuccessNotification,
  send: SendDirectMessage = sendDirectMessage,
): Promise<{ configured: boolean; attempted: number; delivered: number }> {
  const recipients = loadPaymentSuccessNotifyRecipients();
  if (recipients.length === 0) return { configured: false, attempted: 0, delivered: 0 };

  const text = buildPaymentSuccessNotificationText(input);
  const settled = await Promise.allSettled(
    recipients.map((telegramUserId) => send({ telegramUserId, text, disableWebPagePreview: true })),
  );
  const delivered = settled.filter((item) => item.status === "fulfilled" && item.value.success).length;
  const failed = settled.length - delivered;
  if (failed > 0) {
    emitSafetyEvent({
      event: "payment_success_notify_failed",
      errorClass: "unknown",
      orderNo: input.orderNo,
      retryHint: 0,
      note: "telegram_operator_notification_unavailable",
      counts: { attempted: recipients.length, delivered, failed },
    });
  }
  return { configured: true, attempted: recipients.length, delivered };
}
