/**
 * 【Phase 0-3 / 0-4】单一 webhook 入口路由（webhook-only 生产模式）
 *
 * 固定路径： POST /api/telegram/webhook          (botSlot = default = invite_bot)
 * 多槽支持：  POST /api/telegram/webhook/:botSlot (botSlot ∈ invite_bot)
 *
 * 【Phase 0-6 红线】
 *   - 请求必须携带 X-Telegram-Bot-Api-Secret-Token 请求头
 *     （该 secret 由我方通过 setWebhook(secret_token=...) 注册到 Telegram，不是 BotFather 自动给）
 *   - botSlot 绝不能放 query 参数；路由/服务端硬编码映射，不接受客户端自由指定
 *
 * 【Phase 0-4 红线】update_id 处理三段式（绝不把网络 IO 包在事务里）：
 *   1) 短事务A：领取 processing（CAS：pending 或 processing_stale(>10min) 或 failed）
 *   2) 事务外：网络 IO（分发处理器，当前=更新 admin_managed_channels 索引/入库）
 *   3) 短事务B：写 processed / failed（只 WHERE status=processing，防并发覆盖）
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  validateWebhookSecretToken,
  listSupportedBotSlots,
  TELEGRAM_WEBHOOK_CONFIG,
  chatIdFingerprint,
  maskChatIdSafe,
  answerPreCheckoutQuery,
  sendDirectMessage,
  resolveMiniAppUrl,
  type TelegramInlineKeyboardMarkup,
} from "../services/telegramBot.js";
import { encryptChatIdAesGcm, chatIdIndexKey, hmacSha256Hex } from "../utils/crypto.js";
import {
  parseStarsPayloadPlain,
  rawEventHashForTelegram,
  deliverStarsSuccessfulPayment,
  STARS_ORDER_EXPIRES_MS,
} from "../services/orders.js";
import { encryptPackageColsFromPlain } from "../services/channelCrypto.js";

const STALE_PROCESSING_MS = 10 * 60 * 1000; // processing 超过 10 分钟视为卡住，下一轮重置

type UpdateChatInfo = {
  chatIdBig: bigint;
  chatType: string;
  chatTitle: string | null;
  chatUsername: string | null;
  dateSec: number | null;
  event: string;
};

type BotMembershipInfo = {
  status: string;
  isAdmin: boolean;
  canPostMessages: boolean;
  canInviteUsers: boolean;
  canRestrictMembers: boolean;
};

type ChannelPostMessageInfo = {
  messageId: bigint;
  mediaKind: "video" | "photo" | "document" | "text";
  postedAt: Date;
  captionFingerprint: string | null;
};

const CONTENT_START_PAYLOAD_RE = /^content_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** 只接受 Telegram 私聊中的 /start [payload]，群组内不回复，避免打扰频道运营。 */
export function parsePrivateStartCommand(update: any): { telegramUserId: string; contentId: string | null } | null {
  const message = update?.message;
  if (!message || typeof message !== "object" || message?.chat?.type !== "private") return null;
  const telegramUserId = message?.from?.id;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (telegramUserId == null || !/^\/start(?:\s+\S+)?$/i.test(text)) return null;
  const payload = text.split(/\s+/, 2)[1] || "";
  const match = CONTENT_START_PAYLOAD_RE.exec(payload);
  return { telegramUserId: String(telegramUserId), contentId: match ? match[1] : null };
}

export function miniAppContentUrl(contentId: string): string {
  const url = new URL(resolveMiniAppUrl());
  url.hash = `view=content&id=${encodeURIComponent(contentId)}&from=bot`;
  return url.toString();
}

async function replyToPrivateStart(prisma: any, update: any): Promise<boolean> {
  const start = parsePrivateStartCommand(update);
  if (!start) return false;

  let title: string | null = null;
  if (start.contentId) {
    const content = await prisma.content.findUnique({
      where: { id: start.contentId },
      select: { title: true, status: true },
    });
    if (content?.status === "published") title = String(content.title || "").trim().slice(0, 160) || null;
  }

  const miniAppUrl = title && start.contentId ? miniAppContentUrl(start.contentId) : resolveMiniAppUrl();
  const replyMarkup: TelegramInlineKeyboardMarkup = {
    inline_keyboard: [[{ text: "打开 Mini App", web_app: { url: miniAppUrl } }]],
  };
  const text = title
    ? `你正在查看《${title}》\n\n可先免费观看试看；如需观看完整内容，请在同频内开通对应会员权益。`
    : "欢迎来到同频。\n\n你可以先浏览精选内容与免费试看；开通会员后，可进入会员频道观看完整内容。";
  const result = await sendDirectMessage({
    telegramUserId: start.telegramUserId,
    text,
    replyMarkup,
    disableWebPagePreview: true,
  });
  return result.success;
}

function extractChatFromUpdate(raw: any): UpdateChatInfo | null {
  const u = raw && typeof raw === "object" ? raw : null;
  if (!u) return null;
  const find = (nodes: any[]): UpdateChatInfo | null => {
    for (const n of nodes) {
      if (n && typeof n === "object" && typeof n.chat?.id !== "undefined") {
        const chatType = typeof n.chat.type === "string" ? n.chat.type : "unknown";
        return {
          chatIdBig: BigInt(String(n.chat.id)),
          chatType,
          chatTitle: typeof n.chat.title === "string" ? n.chat.title : null,
          chatUsername: typeof n.chat.username === "string" ? n.chat.username : null,
          dateSec: typeof n.date === "number" ? n.date : null,
          event: n.__event || "other",
        };
      }
    }
    return null;
  };
  const tagged: any = { ...u };
  (tagged as any).__event = null as any;
  for (const key of ["channel_post", "my_chat_member", "message", "edited_channel_post", "edited_message", "chat_member", "callback_query", "pre_checkout_query"]) {
    if (u[key] && typeof u[key] === "object") {
      (tagged as any).__event = key;
      const r = find([{ ...u[key], __event: key }]);
      if (r) return r;
    }
  }
  // successful_payment 在 body.message.successful_payment 里，而 message.chat 可能有 user id，已由上面 "message" 分支覆盖
  return null;
}

function extractBotMembershipFromUpdate(raw: any): BotMembershipInfo | null {
  const m = raw?.my_chat_member;
  if (!m || typeof m !== "object") return null;
  const next = m.new_chat_member;
  if (!next || typeof next !== "object") return null;
  return {
    status: String(next.status || "unknown"),
    isAdmin: ["administrator", "creator"].includes(String(next.status || "")),
    canPostMessages: next.can_post_messages === true,
    canInviteUsers: next.can_invite_users === true,
    canRestrictMembers: next.can_restrict_members === true,
  };
}

function extractChannelPostMessage(raw: any): ChannelPostMessageInfo | null {
  const msg = raw?.channel_post || raw?.edited_channel_post;
  if (!msg || typeof msg !== "object" || typeof msg.message_id === "undefined") return null;
  const mediaKind =
    msg.video ? "video" :
    Array.isArray(msg.photo) && msg.photo.length > 0 ? "photo" :
    msg.document ? "document" :
    "text";
  const captionSource =
    typeof msg.caption === "string" && msg.caption.trim()
      ? msg.caption.trim()
      : (typeof msg.text === "string" && msg.text.trim() ? msg.text.trim() : null);
  return {
    messageId: BigInt(String(msg.message_id)),
    mediaKind,
    postedAt: typeof msg.date === "number" ? new Date(msg.date * 1000) : new Date(),
    captionFingerprint: captionSource ? hmacSha256Hex(`telegram_channel_caption:${captionSource}`) : null,
  };
}

export default async function telegramWebhookRoutes(fastify: FastifyInstance) {
  // --- 发布期 Gate / 运维：GET /api/telegram/webhook/status（返回不含敏感字段）
  fastify.get(TELEGRAM_WEBHOOK_CONFIG.fixedPath + "/status", async (_req, reply) => {
    return reply.status(200).send({
      ok: true,
      fixedPath: TELEGRAM_WEBHOOK_CONFIG.fixedPath,
      supportedBotSlots: listSupportedBotSlots(),
      requiresSecretHeader: "X-Telegram-Bot-Api-Secret-Token",
      phase04Status: "processing_transaction_A__io_outside__final_transaction_B",
      staleProcessingMs: STALE_PROCESSING_MS,
    });
  });

  // --- 主 webhook（固定路径 + 可选槽位，统一处理逻辑）
  const handler = async (req: FastifyRequest<{ Params?: { botSlot?: string } }>, reply: any) => {
    // 【Phase 0-6 校验1】Header Secret（恒时比较）
    const headerVal = (req.headers as any)["x-telegram-bot-api-secret-token"];
    const v = validateWebhookSecretToken(headerVal);
    if (!v.ok) {
      return reply.status(401).send({ ok: false, error: "webhook_secret_invalid", reason: v.reason });
    }

    const botSlot = (req.params as any)?.botSlot || TELEGRAM_WEBHOOK_CONFIG.defaultBotSlot;
    const prisma: any = (fastify as any).prisma || (req as any).prisma;

    const body: any = req.body;
    const updateIdRaw: unknown = body && typeof body === "object" ? (body as any).update_id : null;
    if (updateIdRaw == null) {
      return reply.status(200).send({ ok: true, skipped: "no_update_id" }); // 200 OK 避免 Telegram 重试轰炸
    }
    const updateId = BigInt(String(updateIdRaw));
    const chatInfo = extractChatFromUpdate(body);
    const botMembership = extractBotMembershipFromUpdate(body);
    const channelPostMessage = extractChannelPostMessage(body);

    // ===== Phase 0-4 三段式状态机 =====
    // 【Stage A - 短事务：领取 processing】（绝不包含网络 IO）
    let claimed = false;
    let logId: string | null = null;
    try {
      await prisma.$transaction(async (tx: any) => {
        const existing = await tx.telegramUpdateLog.findUnique({
          where: { updateId_botKey: { updateId, botKey: botSlot } },
        });
        const now = new Date();
        const staleCutoff = new Date(now.getTime() - STALE_PROCESSING_MS);
        const isStaleProcessing =
          existing?.status === "processing" && existing.startedAt && new Date(existing.startedAt) < staleCutoff;

        if (!existing || existing.status === "pending" || existing.status === "failed" || isStaleProcessing) {
          const data: any = {
            updateId,
            botKey: botSlot,
            status: "processing",
            eventType: chatInfo?.event || undefined,
            chatIdHmac: chatInfo ? chatIdIndexKey(chatInfo.chatIdBig) : undefined,
            chatIdMasked: chatInfo ? maskChatIdSafe(chatInfo.chatIdBig) : undefined,
            errorClass: null,
            startedAt: now,
            endedAt: null,
          };
          if (!existing) {
            const created = await tx.telegramUpdateLog.create({ data, select: { id: true } });
            logId = created.id;
          } else {
            const updated = await tx.telegramUpdateLog.update({
              where: { id: existing.id },
              data,
              select: { id: true },
            });
            logId = updated.id;
          }
          claimed = true;
        }
        // processed 或 processing 非过期：已领取 → 直接 return 幂等
      });
    } catch (e: any) {
      // 领取异常（比如唯一键冲突）→ 200 OK 让 Telegram 不再反复投递同一 update
      return reply.status(200).send({ ok: true, claimed: false, skipped: "claim_conflict_" + (e?.code || "unknown") });
    }

    if (!claimed || !logId) {
      // 幂等：已成功处理或并发 processing 非过期
      return reply.status(200).send({ ok: true, claimed: false, skipped: "already_processed_or_locked" });
    }

    // 【Stage B - 事务外：实际业务处理（含本地 DB upsert，独立事务）】
    let stageErrClass: string | null = null;
    try {
      // ================================================================
      // PAY-1) pre_checkout_query → 只 answer，不发权益，不写 payment_transaction
      // 幂等：短窗内 rawEventHash 相同（updateId + pre_checkout_query.id）时跳过重复 answer
      // ================================================================
      const started = await replyToPrivateStart(prisma, body);
      const pcq = (body as any).pre_checkout_query;
      if (started) {
        // /start 已回复；不继续进入频道发现，防止把用户私聊错误登记为频道。
      } else if (pcq && typeof pcq === "object" && typeof pcq.id === "string") {
        const pcqId: string = pcq.id;
        const totalAmountRaw = pcq.total_amount; // Telegram: number (int)
        const currencyRaw: string = (pcq.currency || "").toString();
        const payloadPlain: string = (pcq.invoice_payload || "").toString();
        const fromUserId = pcq.from?.id; // number
        const parsed = parseStarsPayloadPlain(payloadPlain);

        let accept = true;
        let errorMsg: string | undefined;

        if (!parsed) {
          accept = false;
          errorMsg = "无法解析订单信息，请重新创单。";
        } else {
          // 查 order：必须存在 + 状态 payable + currency XTR + 金额匹配 + 未过期 + payload HMAC 一致
          const orderRow = await prisma.order.findUnique({ where: { orderNo: parsed.orderNo } });
          if (!orderRow) { accept = false; errorMsg = "订单不存在，请重新下单。"; }
          else if (!["pending", "processing"].includes(orderRow.status)) {
            accept = false;
            if (orderRow.status === "expired") errorMsg = "订单已过期，请重新下单。";
            else if (orderRow.status === "paid") errorMsg = "该订单已完成支付。";
            else if (orderRow.status === "cancelled") errorMsg = "订单已取消，请重新下单。";
            else errorMsg = "订单当前状态不可支付。";
          } else if ((orderRow as any).expiresAt && new Date((orderRow as any).expiresAt).getTime() < Date.now()) {
            accept = false;
            errorMsg = "订单已过期，请重新下单。";
          } else if (BigInt(String(orderRow.amountMinor)) !== BigInt(parsed.amountMinorStr)) {
            accept = false; errorMsg = "支付金额与订单不匹配，请重新下单。";
          } else if (!orderRow.currency || orderRow.currency.toUpperCase() !== "XTR" || (currencyRaw || "").toUpperCase() !== "XTR") {
            accept = false; errorMsg = "币种不匹配，请重新下单。";
          } else {
            // payload HMAC 指纹校验（确保 payload 没被篡改）
            const expectedHmac = hmacSha256Hex(`order_payload:${payloadPlain}`);
            if ((orderRow as any).paymentPayloadHmac && (orderRow as any).paymentPayloadHmac !== expectedHmac) {
              accept = false; errorMsg = "订单支付数据校验失败，请重新下单。";
            } else if (fromUserId && !orderRow.userId) {
              accept = true; // 允许匿名走 Stars，后续成功回调再绑定
            }
          }
        }

        try {
          const pcqAnswer = await answerPreCheckoutQuery({
            preCheckoutQueryId: pcqId,
            ok: accept,
            errorMessage: accept ? undefined : errorMsg,
          });
          // 失败记录 stageErrClass，但仍 200（Telegram 已推走该事件）
          if (!pcqAnswer.ok) {
            stageErrClass = `pre_checkout_answer_failed_${pcqAnswer.errorClass || "unknown"}`;
          }
          // pre_checkout_query 完成：不继续处理 successful_payment（同一个 update 一般只含一个事件）
          void totalAmountRaw; void fromUserId;
        } catch (q: any) {
          stageErrClass = `pre_checkout_answer_exception_${String(q?.message || q).slice(0, 32)}`;
        }
      } else if (body.message && typeof body.message === "object" && body.message.successful_payment && typeof body.message.successful_payment === "object") {
        // ================================================================
        // PAY-2) successful_payment → 原子交付（order+entitlement+transaction 同事务）
        // ================================================================
        const sp = body.message.successful_payment;
        const chargeId = sp.telegram_payment_charge_id;
        const payloadPlain: string = (sp.invoice_payload || "").toString();
        const amountRaw = sp.total_amount; // number (int, XTR 最小单位)
        const currencyRaw: string = (sp.currency || "").toString();
        const fromUserId = body.message.from?.id ?? sp.order_info?.telegram_user_id ?? null;
        if (chargeId && typeof chargeId === "string" && fromUserId) {
          const rawEventHash = rawEventHashForTelegram(botSlot, updateId, chargeId);
          const delivery = await deliverStarsSuccessfulPayment(prisma, {
            telegramPaymentChargeId: chargeId,
            rawEventHash,
            payloadPlain,
            telegramUserIdPlain: fromUserId,
            amountMinor: BigInt(String(amountRaw || 0)),
            currency: currencyRaw,
            botKey: botSlot,
          });
          if (!delivery.delivered) {
            // 除了真正 DB 崩溃之外，所有 delivery 失败我们都记为 info（stageErrClass 只在严重场景才写 failed）
            // 为避免 Telegram 反复重投产生无意义重试，stageErrClass 只在 "tx_*" 异常里标失败
            if (delivery.errorClass && delivery.errorClass.startsWith("tx_")) {
              stageErrClass = `delivery_${delivery.errorClass}`;
            }
          }
          void rawEventHash;
        }
      } else if (chatInfo) {
        // ================================================================
        // CHANNEL DISCOVERY) webhook 自动发现频道 + 尝试绑定待发现请求
        // ================================================================
        const chatIdHmac = chatIdIndexKey(chatInfo.chatIdBig);
        const chatIdCipher = encryptChatIdAesGcm(chatInfo.chatIdBig);
        const lastEventAt = chatInfo.dateSec ? new Date(chatInfo.dateSec * 1000) : null;
        const publicUrl = chatInfo.chatUsername ? `https://t.me/${chatInfo.chatUsername}` : null;
        const upsertedChannel = await prisma.adminManagedChannel.upsert({
          where: { chatIdHmac },
          create: {
            chatIdHmac,
            chatIdCiphertextB64: chatIdCipher,
            deprecatedChatIdBig: chatInfo.chatIdBig,
            chatType: chatInfo.chatType,
            title: chatInfo.chatTitle,
            username: chatInfo.chatUsername,
            lastEventAt,
            source: "auto_scan",
            isPrivate: !chatInfo.chatUsername,
            publicUrl,
            botIsAdmin: !!botMembership?.isAdmin,
            botCanPostMessages: !!botMembership?.canPostMessages,
            botCanInviteUsers: !!botMembership?.canInviteUsers,
            botCanRestrictMembers: !!botMembership?.canRestrictMembers,
            lastDiscoveryUpdateType: chatInfo.event,
            discoveryErrorCode: null,
          },
          update: {
            chatIdCiphertextB64: chatIdCipher, // 每次重新加密（nonce 旋转）
            deprecatedChatIdBig: chatInfo.chatIdBig,
            chatType: chatInfo.chatType,
            title: chatInfo.chatTitle || undefined,
            username: chatInfo.chatUsername || undefined,
            lastEventAt: lastEventAt || undefined,
            isPrivate: !chatInfo.chatUsername,
            publicUrl: publicUrl || undefined,
            botIsAdmin: botMembership ? !!botMembership.isAdmin : undefined,
            botCanPostMessages: botMembership ? !!botMembership.canPostMessages : undefined,
            botCanInviteUsers: botMembership ? !!botMembership.canInviteUsers : undefined,
            botCanRestrictMembers: botMembership ? !!botMembership.canRestrictMembers : undefined,
            lastDiscoveryUpdateType: chatInfo.event,
            discoveryErrorCode: null,
          },
        });

        // 自动绑定 discovery request：
        // 1) 公开频道：按 normalizedLink 精确绑定
        // 2) 私密频道：若当前仅有 1 个 awaiting_bot_admin 未绑定请求，则自动绑定；多个并存时保持待人工确认，避免误绑
        if (chatInfo.chatUsername) {
          const normalizedPublic = `https://t.me/${chatInfo.chatUsername}`;
          const pendingPublic = await prisma.adminChannelDiscoveryRequest.findFirst({
            where: {
              linkType: "public_username",
              normalizedLink: normalizedPublic,
              resolvedChannelId: null,
              status: { in: ["pending_public_check", "awaiting_bot_admin", "discovered"] },
            },
            orderBy: { createdAt: "asc" },
          });
          if (pendingPublic) {
            await prisma.adminChannelDiscoveryRequest.update({
              where: { id: pendingPublic.id },
              data: {
                status: pendingPublic.requestedPurpose && pendingPublic.requestedPurpose !== "none" ? "bound" : "discovered",
                resolvedChannelId: upsertedChannel.id,
                discoveredAt: new Date(),
                boundAt: pendingPublic.requestedPurpose && pendingPublic.requestedPurpose !== "none" ? new Date() : null,
                lastErrorCode: null,
                lastErrorNote: null,
              },
            });
            if (pendingPublic.requestedPurpose && pendingPublic.requestedPurpose !== "none") {
              await prisma.adminManagedChannel.update({
                where: { chatIdHmac },
                data: {
                  purpose: pendingPublic.requestedPurpose,
                  packageId: pendingPublic.requestedPurpose === "package_channel" ? pendingPublic.packageId : null,
                },
              });
              if (pendingPublic.requestedPurpose === "package_channel" && pendingPublic.packageId) {
                const encrypted = encryptPackageColsFromPlain(chatInfo.chatIdBig);
                await prisma.contentPackage.update({
                  where: { id: pendingPublic.packageId },
                  data: {
                    channelId: chatInfo.chatIdBig,
                    channelIdCiphertext: encrypted.channelIdCiphertextB64,
                    channelIdHmac: encrypted.channelIdHmac,
                  },
                });
              }
            }
          }
        } else {
          const pendingPrivate = await prisma.adminChannelDiscoveryRequest.findMany({
            where: {
              linkType: "private_invite",
              status: "awaiting_bot_admin",
              resolvedChannelId: null,
            },
            orderBy: { createdAt: "asc" },
            take: 2,
          });
          if (pendingPrivate.length === 1) {
            const reqRow = pendingPrivate[0];
            await prisma.adminChannelDiscoveryRequest.update({
              where: { id: reqRow.id },
              data: {
                status: reqRow.requestedPurpose && reqRow.requestedPurpose !== "none" ? "bound" : "discovered",
                resolvedChannelId: upsertedChannel.id,
                discoveredAt: new Date(),
                boundAt: reqRow.requestedPurpose && reqRow.requestedPurpose !== "none" ? new Date() : null,
                lastErrorCode: null,
                lastErrorNote: null,
              },
            });
            if (reqRow.requestedPurpose && reqRow.requestedPurpose !== "none") {
              await prisma.adminManagedChannel.update({
                where: { chatIdHmac },
                data: {
                  purpose: reqRow.requestedPurpose,
                  packageId: reqRow.requestedPurpose === "package_channel" ? reqRow.packageId : null,
                },
              });
              if (reqRow.requestedPurpose === "package_channel" && reqRow.packageId) {
                const encrypted = encryptPackageColsFromPlain(chatInfo.chatIdBig);
                await prisma.contentPackage.update({
                  where: { id: reqRow.packageId },
                  data: {
                    channelId: chatInfo.chatIdBig,
                    channelIdCiphertext: encrypted.channelIdCiphertextB64,
                    channelIdHmac: encrypted.channelIdHmac,
                  },
                });
              }
            }
          } else if (pendingPrivate.length > 1) {
            await prisma.adminManagedChannel.update({
              where: { chatIdHmac },
              data: { discoveryErrorCode: "multiple_pending_private_requests" },
            });
          }
        }

        if (channelPostMessage && (chatInfo.event === "channel_post" || chatInfo.event === "edited_channel_post")) {
          const ingested = await (prisma as any).telegramChannelMessage.upsert({
            where: {
              managedChannelId_messageId: {
                managedChannelId: upsertedChannel.id,
                messageId: channelPostMessage.messageId,
              },
            },
            create: {
              managedChannelId: upsertedChannel.id,
              messageId: channelPostMessage.messageId,
              mediaKind: channelPostMessage.mediaKind,
              captionFingerprint: channelPostMessage.captionFingerprint,
              postedAt: channelPostMessage.postedAt,
              associationStatus: "unlinked",
            },
            update: {
              mediaKind: channelPostMessage.mediaKind,
              captionFingerprint: channelPostMessage.captionFingerprint,
              postedAt: channelPostMessage.postedAt,
            },
          });
          try {
            const systemAdmin = await prisma.adminUser.findFirst({
              where: { role: "super_admin", status: "active" },
              select: { id: true },
              orderBy: { createdAt: "asc" },
            });
            if (systemAdmin?.id) {
              await prisma.adminAuditLog.create({
                data: {
                  adminId: systemAdmin.id,
                  action: "telegram.channel_message.ingested",
                  objectType: "telegram_channel_message",
                  objectId: ingested.id,
                  beforeValue: null,
                  afterValue: {
                    channelChatHmac: chatIdHmac,
                    messageId: channelPostMessage.messageId.toString(),
                    mediaKind: channelPostMessage.mediaKind,
                    associationStatus: ingested.associationStatus,
                  },
                  reason: "system:webhook_channel_post",
                },
              });
            }
          } catch {
            // 审计失败不影响 webhook 主流程
          }
        }
      }
    } catch (e: any) {
      stageErrClass =
        e?.code === "P2002" ? "unique_conflict" :
        e?.code?.startsWith?.("P") ? `prisma_${e.code}` :
        "webhook_stage_b_failed";
    }
    void STARS_ORDER_EXPIRES_MS;

    // 【Stage C - 短事务：写终态（WHERE status=processing 防并发覆盖）】
    try {
      await prisma.$transaction(async (tx: any) => {
        const finalStatus = stageErrClass ? "failed" : "processed";
        await tx.telegramUpdateLog.updateMany({
          where: { id: logId!, status: "processing" },
          data: {
            status: finalStatus,
            errorClass: stageErrClass,
            endedAt: new Date(),
          },
        });
      });
    } catch {
      // Stage C 失败不影响 Telegram 200；stale cron 下次会重置 processing 再重试
    }

    // 给 Telegram 永远 200，绝不 5xx（否则重复投递风暴）
    return reply.status(200).send({ ok: true, claimed: true, status: stageErrClass ? "failed" : "processed" });
  };

  fastify.post(TELEGRAM_WEBHOOK_CONFIG.fixedPath, handler as any);
  fastify.post(TELEGRAM_WEBHOOK_CONFIG.fixedPath + "/:botSlot", handler as any);
}
