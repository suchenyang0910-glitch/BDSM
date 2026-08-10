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
} from "../services/telegramBot.js";
import { encryptChatIdAesGcm, chatIdIndexKey, hmacSha256Hex } from "../utils/crypto.js";
import {
  parseStarsPayloadPlain,
  rawEventHashForTelegram,
  deliverStarsSuccessfulPayment,
  STARS_ORDER_EXPIRES_MS,
} from "../services/orders.js";

const STALE_PROCESSING_MS = 10 * 60 * 1000; // processing 超过 10 分钟视为卡住，下一轮重置

type UpdateChatInfo = {
  chatIdBig: bigint;
  chatType: string;
  chatTitle: string | null;
  dateSec: number | null;
  event: string;
};

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
      const pcq = (body as any).pre_checkout_query;
      if (pcq && typeof pcq === "object" && typeof pcq.id === "string") {
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
        // FALLBACK) Phase 0 原逻辑：adminManagedChannel 入库
        // ================================================================
        const chatIdHmac = chatIdIndexKey(chatInfo.chatIdBig);
        const chatIdCipher = encryptChatIdAesGcm(chatInfo.chatIdBig);
        const lastEventAt = chatInfo.dateSec ? new Date(chatInfo.dateSec * 1000) : null;
        // 独立事务，不与 processing 状态事务绑定
        await prisma.adminManagedChannel.upsert({
          where: { chatIdHmac },
          create: {
            chatIdHmac,
            chatIdCiphertextB64: chatIdCipher,
            deprecatedChatIdBig: chatInfo.chatIdBig,
            chatType: chatInfo.chatType,
            title: chatInfo.chatTitle,
            lastEventAt,
            source: "auto_scan",
            isPrivate: !chatInfo.chatTitle ? true : undefined,
          },
          update: {
            chatIdCiphertextB64: chatIdCipher, // 每次重新加密（nonce 旋转）
            deprecatedChatIdBig: chatInfo.chatIdBig,
            chatType: chatInfo.chatType,
            title: chatInfo.chatTitle || undefined,
            lastEventAt: lastEventAt || undefined,
          },
        });
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
