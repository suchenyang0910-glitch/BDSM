import { formatMinorAmountForDisplay } from "../utils/currency.js";
import { emitSafetyEvent } from "../utils/structuredError.js";
import { sendDirectMessage, type SendDirectMessageResult } from "./telegramBot.js";

const RECIPIENTS_ENV = "PAYMENT_SUCCESS_NOTIFY_TELEGRAM_USER_IDS";
const ADMIN_ORDERS_URL_ENV = "PAYMENT_SUCCESS_NOTIFY_ADMIN_ORDERS_URL";

type PaymentSuccessReplyMarkup = {
  inline_keyboard: Array<Array<{
    text: string;
    url?: string;
    copy_text?: { text: string };
  }>>;
};

type SendDirectMessage = (opts: {
  telegramUserId: bigint | number | string;
  text: string;
  parseMode?: "MarkdownV2" | "HTML" | "Markdown";
  disableWebPagePreview?: boolean;
  replyMarkup?: PaymentSuccessReplyMarkup;
}) => Promise<SendDirectMessageResult>;

export type PaymentSuccessNotification = {
  orderNo: string;
  paymentMethod: "telegram_stars" | "usdt_trc20" | "manual";
  amountMinor: bigint | number | string;
  currency: string;
  productTitle?: string | null;
  /** 仅平台昵称；不得传 Telegram 名、用户名或手机号。 */
  userDisplayName?: string | null;
  /** 仅 USDT-TRC20 成功通知展示订单实际分配的收款地址。 */
  receivingUsdtAddress?: string | null;
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

function safeOrderNo(orderNo: string): string {
  const value = String(orderNo || "").trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(value) ? value : "已确认";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeProductTitle(value: string | null | undefined): string {
  const normalized = String(value || "").replace(/[\r\n\t]/g, " ").trim();
  return normalized ? normalized.slice(0, 48) : "内容权益";
}

function safePlatformNickname(value: string | null | undefined): string {
  const normalized = String(value || "").replace(/[\r\n\t]/g, " ").trim();
  return normalized ? normalized.slice(0, 32) : "同频成员";
}

function safeReceivingUsdtAddress(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(normalized) ? normalized : null;
}

function operatorOrdersUrl(orderNo: string): string {
  const fallback = "https://bdsm.linkx.club/admin/orders";
  try {
    const url = new URL(process.env[ADMIN_ORDERS_URL_ENV] || fallback);
    if (url.protocol !== "https:") throw new Error("admin_orders_url_must_be_https");
    url.searchParams.set("orderNo", orderNo);
    return url.toString();
  } catch {
    return `${fallback}?orderNo=${encodeURIComponent(orderNo)}`;
  }
}

export function buildPaymentSuccessNotificationText(input: PaymentSuccessNotification): string {
  const method = input.paymentMethod === "telegram_stars"
    ? "Telegram Stars"
    : input.paymentMethod === "usdt_trc20"
    ? "USDT-TRC20"
    : "人工确认";
  const amount = formatMinorAmountForDisplay(input.amountMinor, input.currency);
  const unit = String(input.currency || "").toUpperCase() === "XTR" ? "Stars" : String(input.currency || "").toUpperCase();
  const orderNo = safeOrderNo(input.orderNo);
  const receivingUsdtAddress = input.paymentMethod === "usdt_trc20"
    ? safeReceivingUsdtAddress(input.receivingUsdtAddress)
    : null;
  return [
    "【同频 · 支付成功】",
    `用户：${escapeHtml(safePlatformNickname(input.userDisplayName))}`,
    `订单：<code>${escapeHtml(orderNo)}</code>`,
    `方式：${method}`,
    `商品：${escapeHtml(safeProductTitle(input.productTitle))}`,
    `金额：${amount} ${unit}`.trim(),
    ...(receivingUsdtAddress ? [`收款地址（TRC-20）：<code>${receivingUsdtAddress}</code>`] : []),
    "权益：已完成发放。",
  ].join("\n");
}

/** 支付成功运营通知的受控快捷操作：复制订单号 / 前往对应后台订单。 */
export function buildPaymentSuccessNotificationReplyMarkup(input: PaymentSuccessNotification): PaymentSuccessReplyMarkup {
  const orderNo = safeOrderNo(input.orderNo);
  const receivingUsdtAddress = input.paymentMethod === "usdt_trc20"
    ? safeReceivingUsdtAddress(input.receivingUsdtAddress)
    : null;
  return {
    inline_keyboard: [
      [{ text: "复制订单号", copy_text: { text: orderNo } }],
      ...(receivingUsdtAddress ? [[{ text: "复制收款地址", copy_text: { text: receivingUsdtAddress } }]] : []),
      [{ text: "查看后台订单", url: operatorOrdersUrl(orderNo) }],
    ],
  };
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
  const replyMarkup = buildPaymentSuccessNotificationReplyMarkup(input);
  const settled = await Promise.allSettled(
    recipients.map((telegramUserId) => send({
      telegramUserId,
      text,
      parseMode: "HTML",
      disableWebPagePreview: true,
      replyMarkup,
    })),
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
