import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  generateOrderNo,
  markOrderPaid,
  cancelOrder,
  refundOrder,
  STARS_ORDER_EXPIRES_MS,
  USDT_ORDER_EXPIRES_MS,
  starsPaymentPayloadForOrder,
  parseStarsPayloadPlain,
} from "../services/orders.js";
import { requireAdmin } from "./admin.js";
import {
  createStarsInvoice,
  refundStarsPayment,
  type CreateStarsInvoiceResult,
} from "../services/telegramBot.js";
import {
  assignUsdtTrc20Address,
  generateUsdtUniqueAmountForAddress,
  addressMasked,
  releaseExpiredUsdtAddresses,
  USDT_CONFIRMATIONS_TARGET_DEFAULT,
  USDT_TRON_TOKEN_CONTRACT_DEFAULT,
  type AssignUsdtAddressResult,
} from "../services/usdtPool.js";
import { userIdIndexKey, chatIdIndexKey } from "../utils/crypto.js";
import { emitSafetyEvent, emitStructuredLog } from "../utils/structuredError.js";

const createOrderSchema = z.object({
  productId: z.string().min(1),
});

const adminMarkPaidSchema = z.object({
  reason: z.string().min(2, { message: "到账说明至少 2 个字符" }).max(1000),
});

const ordersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(["pending", "processing", "paid", "failed", "refunded", "cancelled", "expired"]).optional(),
});

const adminOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["pending", "processing", "paid", "failed", "refunded", "cancelled", "expired"]).optional(),
  orderNo: z.string().min(1).max(32).optional(),
  telegramUserId: z.coerce.bigint().optional(),
  productId: z.string().min(1).optional(),
});

function orderResponse(o: any) {
  return {
    id: o.id,
    orderNo: o.orderNo,
    status: o.status,
    product: o.product
      ? {
          id: o.product.id,
          type: o.product.type,
          title: o.product.title,
          priceMinor: o.product.priceMinor?.toString(),
          currency: o.product.currency,
          durationDays: o.product.durationDays ?? null,
        }
      : null,
    amountMinor: o.amountMinor?.toString(),
    currency: o.currency,
    paymentMethod: o.paymentMethod ?? null,
    paymentProvider: o.paymentProvider,
    providerOrderId: o.providerOrderId ?? null,
    expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null,
    rejectReason: typeof o.rejectReason === "string" ? o.rejectReason.slice(0, 400) : null,
    paidAt: o.paidAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
    transactionsSummary: Array.isArray(o.paymentTransactions)
      ? o.paymentTransactions.map((t: any) => ({
          id: t.id,
          provider: t.provider,
          status: t.status,
          confirmations: typeof t.confirmations === "number" ? t.confirmations : null,
          receivedAt: t.receivedAt ? t.receivedAt.toISOString() : null,
        }))
      : [],
    entitlements: o.entitlements
      ? o.entitlements.map((e: any) => ({
          id: e.id,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          status: e.status,
          startsAt: e.startsAt.toISOString(),
          expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
        }))
      : [],
  };
}

function adminOrderResponse(o: any) {
  const base: any = orderResponse(o);
  base.user = o.user
    ? {
        id: o.user.id,
        telegramUserId: o.user.telegramUserId?.toString() ?? null,
        username: o.user.username ?? null,
        displayName: o.user.displayName,
        status: o.user.status,
      }
    : null;
  // 后台专属：展示 providerChargeId（前台隐藏）、rejectReason 完整文本、confirmedAt / refundedAt
  base.paymentTransactions = Array.isArray(o.paymentTransactions)
    ? o.paymentTransactions.map((t: any) => ({
        id: t.id,
        provider: t.provider,
        providerChargeId: t.providerChargeId ?? null,
        status: t.status,
        network: t.network ?? null,
        tokenContract: t.tokenContract ?? null,
        currency: t.currency,
        amountMinor: t.amountMinor?.toString(),
        fromAddress: t.fromAddress ?? null,
        toAddress: t.toAddress ?? null,
        confirmations: typeof t.confirmations === "number" ? t.confirmations : null,
        blockNumber: t.blockNumber ?? null,
        rejectReason: t.rejectReason ?? null,
        receivedAt: t.receivedAt ? t.receivedAt.toISOString() : null,
        confirmedAt: t.confirmedAt ? t.confirmedAt.toISOString() : null,
        rejectedAt: t.rejectedAt ? t.rejectedAt.toISOString() : null,
        refundedAt: t.refundedAt ? t.refundedAt.toISOString() : null,
      }))
    : [];
  base.telegramUserIdHmac = o.telegramUserIdHmac ?? null;
  return base;
}

export default async function orderRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.post("/orders", async (req, reply) => {
    const uid = (req as any).userId as string | undefined;
    if (!uid) return reply.status(401).send({ error: "unauthorized" });

    const parse = createOrderSchema.safeParse(req.body);
    if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });

    const product = await prisma.product.findUnique({
      where: { id: parse.data.productId },
    });
    if (!product || product.status !== "active") {
      return reply.status(404).send({ error: "product_not_found", message: "商品不存在或已下架" });
    }

    let orderNo = generateOrderNo();
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await prisma.order.count({ where: { orderNo } });
      if (exists === 0) break;
      orderNo = generateOrderNo();
    }

    const order = await prisma.order.create({
      data: {
        orderNo,
        userId: uid,
        productId: product.id,
        amountMinor: product.priceMinor,
        currency: product.currency,
        status: "pending",
      },
      include: { product: true, entitlements: true },
    });

    return reply.status(201).send(orderResponse(order));
  });

  // ============================================================
  // Sprint 3 V2 P0: POST /api/orders/stars → 创建 Stars 订单 + 生成 Mini App Invoice Link
  // 安全：
  //   - payload 不可猜测，只用 payloadPlain 作为 createInvoiceLink 的 Telegram payload
  //   - payloadHmac 写 DB 唯一索引（防止 payload 重放）
  //   - 响应只返回 invoiceLink（给前端 tg.openInvoice），不返回 Bot Token / HMAC 密钥
  // ============================================================
  fastify.post("/orders/stars", async (req, reply) => {
    const uid = (req as any).userId as string | undefined;
    if (!uid) return reply.status(401).send({ error: "unauthorized", message: "请先在 Telegram Mini App 登录" });
    const parse = createOrderSchema.safeParse(req.body);
    if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });

    const product = await prisma.product.findUnique({ where: { id: parse.data.productId } });
    if (!product || product.status !== "active") {
      return reply.status(404).send({ error: "product_not_found", message: "商品不存在或已下架" });
    }
    if (!product.currency || product.currency.toUpperCase() !== "XTR") {
      return reply.status(400).send({ error: "bad_request", message: `该商品币种 ${product.currency || "未知"} 不是 XTR (Telegram Stars)，请使用正确的支付方式` });
    }
    const amountMinor = BigInt(product.priceMinor.toString());
    if (amountMinor <= 0n) return reply.status(400).send({ error: "bad_request", message: "商品价格无效（XTR 最小单位必须为正整数）" });

    // 查当前用户的 telegramUserId 用于可选 DM（失败时回退到 Mini App Invoice Link）
    const userRow = await prisma.user.findUnique({ where: { id: uid }, select: { telegramUserId: true } });
    const tgid = userRow?.telegramUserId ? BigInt(userRow.telegramUserId.toString()) : null;

    // 生成订单号 & payload 指纹
    let orderNo = generateOrderNo();
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await prisma.order.count({ where: { orderNo } });
      if (exists === 0) break;
      orderNo = generateOrderNo();
    }
    const { payloadPlain, payloadHmac } = starsPaymentPayloadForOrder({ orderNo, userId: uid, amountMinor });
    const expiresAt = new Date(Date.now() + STARS_ORDER_EXPIRES_MS);
    const telegramUserIdHmac = tgid ? userIdIndexKey(tgid) : null;

    // DB 创建订单（含 payloadHmac 唯一；若唯一冲突则重新生成 payloadPlain 再试）
    let order: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        order = await prisma.order.create({
          data: {
            orderNo,
            userId: uid,
            productId: product.id,
            amountMinor,
            currency: product.currency.toUpperCase(),
            paymentMethod: "telegram_stars",
            paymentProvider: "telegram_stars",
            paymentPayloadHmac: payloadHmac,
            telegramUserIdHmac,
            expiresAt,
            status: "pending",
          },
          include: { product: true, entitlements: true },
        });
        break;
      } catch (e: any) {
        if (e?.code === "P2002" && attempt < 2) continue;
        throw e;
      }
    }
    if (!order) return reply.status(500).send({ error: "order_create_failed", message: "订单创建冲突，请稍后重试" });

    // 生成 Stars Invoice：优先 Mini App createInvoiceLink
    const title = product.title?.slice(0, 128) || "InTune 数字内容";
    const descLines: string[] = [];
    if (product.type === "membership" && product.durationDays) descLines.push(`会员时长：${product.durationDays} 天`);
    else if (product.type === "package") descLines.push("类型：内容包");
    else if (product.type === "single") descLines.push("类型：单条内容");
    descLines.push("支付后自动解锁对应内容或私密频道访问权（20 分钟内未支付则订单失效）。");
    const description = descLines.join(" · ").slice(0, 255);
    const prices = [{ label: product.title?.slice(0, 60) || "数字内容", amount: Number(amountMinor) }];

    let inv: CreateStarsInvoiceResult | null = null;
    // DM 模式优先（Bot sendInvoice 直接推到 Telegram 聊天）
    if (tgid) {
      const r = await createStarsInvoice({
        title, description, payload: payloadPlain, currency: "XTR", prices,
        sendToTelegramUserId: tgid,
      });
      inv = r;
    }
    // 如果不发 DM 或 DM 失败（比如用户还没发过 /start），回退 createInvoiceLink（Mini App 内部 tg.openInvoice）
    if (!inv || !inv.ok) {
      inv = await createStarsInvoice({ title, description, payload: payloadPlain, currency: "XTR", prices });
    }

    const base: any = orderResponse(order);
    base.expiresAt = expiresAt.toISOString();
    base.paymentMethod = "telegram_stars";

    if (!inv.ok) {
      // 503: Bot 配置错导致无法开发票（返回语义化错误，非泛化 500）
      return reply.status(503).send({
        ...base,
        ok: false,
        error: "service_unavailable",
        detail: { errorClass: inv.errorClass, reason: inv.reason, doc: "https://core.telegram.org/bots/payments-stars" },
      });
    }
    return reply.status(201).send({
      ...base,
      ok: true,
      invoice: {
        via: inv.via,
        invoiceLink: inv.invoiceLink,
      },
      expiresAt: expiresAt.toISOString(),
      tip: inv.via === "sendInvoice"
        ? "发票已发送到您与 Bot 的私信会话，请在 Telegram 内打开完成支付。"
        : "请在 Mini App 中使用 tg.openInvoice(invoiceLink) 完成 Stars 支付。",
    });
  });

  // ============================================================
  // Sprint 3 V2 P1: POST /api/orders/usdt → USDT-TRC20 站外订单
  //   · 分配地址池地址（轮询+窗口锁定）
  //   · 标价加唯一尾数（0.xx USDT，小数位 0-99，同一地址窗口内不重复）
  //   · 返回收款地址 + 精确金额，不返回 Telegram 内支付引导（PRD §2.2 硬规则）
  // ============================================================
  fastify.post("/orders/usdt", async (req, reply) => {
    const uid = (req as any).userId as string | undefined;
    if (!uid) return reply.status(401).send({ error: "unauthorized", message: "请先登录" });
    const parse = createOrderSchema.safeParse(req.body);
    if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });

    const productPre = await prisma.product.findUnique({ where: { id: parse.data.productId } });
    if (!productPre || productPre.status !== "active") {
      return reply.status(404).send({ error: "product_not_found", message: "商品不存在或已下架" });
    }
    if (!productPre.currency || productPre.currency.toUpperCase() !== "USDT") {
      return reply.status(400).send({
        error: "bad_request",
        message: `该商品币种 ${productPre.currency || "未知"} 不是 USDT，请使用正确的支付方式`,
      });
    }
    const baseAmountMinor = BigInt(productPre.priceMinor.toString());
    if (baseAmountMinor <= 0n) {
      return reply.status(400).send({ error: "bad_request", message: "商品价格无效（USDT 最小单位必须为正整数，单位 1e-6 USDT）" });
    }

    let orderNo = generateOrderNo();
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await prisma.order.count({ where: { orderNo } });
      if (exists === 0) break;
      orderNo = generateOrderNo();
    }
    const expiresAt = new Date(Date.now() + USDT_ORDER_EXPIRES_MS);

    // ============================================================
    // PRD §4.1 原子建单 + §4.3 尾数空间耗尽切换可用地址
    //   外层循环：最多尝试 MAX_ATTEMPTS 个不同的可用地址（每次尝试是独立 interactive transaction，失败整体回滚，再挑下一个地址继续）
    //   退出条件：
    //     - 成功建单 → 201 返回
    //     - assignUsdtTrc20Address 返回 pool_empty / db_error → 立即退出循环返回 503/500 通用错误
    //     - generateUsdtUniqueAmountForAddress 抛 _class=tail_exhausted → 本轮地址尾数占满，回滚并进入下一轮换地址
    //     - MAX_ATTEMPTS 用尽 → 视为池耗尽 503
    // ============================================================
    const MAX_ATTEMPTS = 16;
    const SKIP_ADDRESS_IDS = new Set<string>();
    type CreateUsdtOrderTxOk = {
      order: any;
      finalAmountMinor: bigint;
      actualTailMinor: bigint;
      uniqueDeltaMinor: bigint;
      address: string;
      addressMaskedOut: string;
      attemptIdx: number;
    };
    let final: CreateUsdtOrderTxOk | null = null;
    let lastFatal:
      | null
      | {
          kind: "pool_empty" | "assign_db_error" | "other";
          httpStatus: number;
          userError: string;
          userMessage: string;
          raw?: unknown;
        } = null;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        final = await prisma.$transaction(async (tx: any): Promise<CreateUsdtOrderTxOk> => {
          // 事务内一致性校验 product
          const product = await tx.product.findUnique({ where: { id: parse.data.productId } });
          if (!product || product.status !== "active") throw Object.assign(new Error("product_gone"), { _kind: "bad_request_product" });
          // 1. 占位订单
          const placeholder = await tx.order.create({
            data: {
              orderNo,
              userId: uid,
              productId: product.id,
              amountMinor: baseAmountMinor,
              currency: product.currency!.toUpperCase(),
              paymentMethod: "usdt_trc20_external",
              paymentProvider: "tron_trc20_external",
              status: "pending",
              expiresAt,
            },
          });
          // 2. 分配地址（同一 tx，SKIP LOCKED 会自动跳过被锁的；再额外排除之前尾数耗尽过的地址 id 避免快速撞同一个）
          const assigned = await assignUsdtTrc20Address(tx, placeholder.id, expiresAt, Array.from(SKIP_ADDRESS_IDS));
          if (!assigned.ok) {
            if (assigned.errorClass === "db_error") {
              throw Object.assign(new Error("assign_db_error"), { _kind: "assign_db_error", assignResult: assigned });
            }
            // pool_empty 或其他未分类业务耗尽 → 直接抛给外层走 503
            throw Object.assign(new Error("pool_empty"), { _kind: "pool_empty", assignResult: assigned });
          }
          // 如果 assignUsdtTrc20Address 选中的这个地址恰好在之前几轮已经尾数耗尽了，直接抛 tail_exhausted 进入下一轮（避免事务内再读已占满的 100 条 takenActualTails 白浪费 IO）
          if (SKIP_ADDRESS_IDS.has(assigned.addressId)) {
            const skipErr = new Error("usdt_tail_exhausted") as Error & { _class?: "tail_exhausted"; taken?: number; skipAddressId?: string };
            (skipErr as any)._class = "tail_exhausted";
            (skipErr as any).taken = 100;
            (skipErr as any).skipAddressId = assigned.addressId;
            throw skipErr;
          }
          // 3. 生成唯一尾数；若 takenActualTails.size>=100 会抛 _class=tail_exhausted，事务自动回滚，下一轮换地址
          const gen = await generateUsdtUniqueAmountForAddress(tx, assigned.addressId, baseAmountMinor);
          // 4. 最终写入订单
          const order = await tx.order.update({
            where: { id: placeholder.id },
            data: { amountMinor: gen.finalAmountMinor, usdtPaymentAddressId: assigned.addressId },
            include: { product: true, usdtPaymentAddress: true, entitlements: true },
          });
          return {
            order,
            finalAmountMinor: gen.finalAmountMinor,
            actualTailMinor: gen.actualTailMinor,
            uniqueDeltaMinor: gen.uniqueDeltaMinor,
            address: order.usdtPaymentAddress ? order.usdtPaymentAddress.address : assigned.address,
            addressMaskedOut: addressMasked(order.usdtPaymentAddress ? order.usdtPaymentAddress.address : assigned.address),
            attemptIdx: i,
          };
        }, { timeout: 30_000 } as any);
        // 成功：跳出循环
        break;
      } catch (e: any) {
        // ===== 分类处理本轮事务抛错 =====
        if (e?.code === "P2002") {
          lastFatal = {
            kind: "other",
            httpStatus: 409,
            userError: "conflict",
            userMessage: "订单号或地址分配唯一约束冲突，请重试。",
            raw: e,
          };
          break;
        }
        if (e?._kind === "bad_request_product") {
          lastFatal = {
            kind: "other",
            httpStatus: 404,
            userError: "product_not_found",
            userMessage: "商品不存在或已下架",
            raw: e,
          };
          break;
        }
        if (e?._kind === "pool_empty") {
          lastFatal = {
            kind: "pool_empty",
            httpStatus: 503,
            userError: "usdt_address_pool_exhausted",
            userMessage: "当前没有可用的 USDT 收款地址，请稍后重试或联系客服。",
            raw: e,
          };
          break;
        }
        if (e?._kind === "assign_db_error") {
          try {
            emitSafetyEvent(
              {
                event: "usdt_assign_failed",
                errorClass: "db_error",
                orderNo,
                userId: uid,
                productId: parse.data.productId,
                retryHint: 1,
                note: "assignUsdtTrc20Address: structured_db_err",
                counts: { attempt: i, maxAttempts: MAX_ATTEMPTS },
              },
              e?.raw ?? e,
            );
          } catch {}
          lastFatal = {
            kind: "assign_db_error",
            httpStatus: 500,
            userError: "usdt_assign_failed",
            userMessage: "地址分配服务暂不可用，请稍后重试。",
            raw: e,
          };
          break;
        }
        if ((e as any)?._class === "tail_exhausted") {
          // 当前地址的 100 个实际尾数全部占满 → 记录该地址 id 避免再分配，继续下一轮循环换一个可用地址
          const skipId = String((e as any).skipAddressId ?? (e as any).addressId ?? "");
          if (skipId) SKIP_ADDRESS_IDS.add(skipId);
          try {
            emitStructuredLog({
              event: "usdt_tail_exhausted_retry_next",
              errorClass: "exhausted",
              orderNo,
              userId: uid,
              productId: parse.data.productId,
              retryHint: 1,
              note: "address_exhausted_switching_to_next",
              counts: { attempt: i, maxAttempts: MAX_ATTEMPTS, skipIds: SKIP_ADDRESS_IDS.size, taken: Number((e as any).taken ?? 100) },
            });
          } catch {}
          continue;
        }
        // 其他未分类异常：视为 DB / 内部故障，停止重试（避免循环打爆）
        try {
          emitSafetyEvent(
            {
              event: "usdt_create_order_unhandled",
              errorClass: "db_error",
              orderNo,
              userId: uid,
              productId: parse.data.productId,
              retryHint: 0,
              note: "create_usdt_order_unhandled_exception",
              counts: { attempt: i, maxAttempts: MAX_ATTEMPTS },
            },
            e,
          );
        } catch {}
        lastFatal = {
          kind: "other",
          httpStatus: 500,
          userError: "usdt_unique_tail_query_failed",
          userMessage: "唯一尾数分配或地址池写入失败，请稍后重试。",
          raw: e,
        };
        break;
      }
    }

    // ============================================================
    // 循环结束
    // ============================================================
    if (!final) {
      // 要么是 lastFatal 明确错误，要么是 MAX_ATTEMPTS 次都命中尾数耗尽
      if (lastFatal) {
        // 幂等补偿：极端罕见 ROLLBACK 之后仍残留 pending 订单/地址绑定 → 同一事务兜底清掉（PRD §4.1 不得残留脏状态）
        if (lastFatal.httpStatus >= 500 || lastFatal.userError === "conflict") {
          try {
            await prisma.$transaction(async (tx: any) => {
              const dangling = await tx.order.findUnique({ where: { orderNo }, select: { id: true, usdtPaymentAddressId: true, status: true } });
              if (dangling && dangling.status === "pending") {
                // PRD §4.4：rejectReason 字段也不写原始 DB message/SQL，只用结构化错误码
                await tx.order.update({
                  where: { id: dangling.id },
                  data: { status: "failed", rejectedAt: new Date(), rejectReason: lastFatal.userError },
                });
                if (dangling.usdtPaymentAddressId) {
                  await tx.paymentAddress.update({
                    where: { id: dangling.usdtPaymentAddressId },
                    data: { assignedOrderId: null, assignedAt: null, releaseAt: null, status: "available" },
                  });
                }
              }
            });
          } catch {}
        }
        return reply.status(lastFatal.httpStatus).send({ error: lastFatal.userError, message: lastFatal.userMessage });
      }
      // MAX_ATTEMPTS 次全是 tail_exhausted：视为整体池耗尽，503 通用
      try {
        emitStructuredLog({
          event: "usdt_pool_exhausted_after_retries",
          errorClass: "exhausted",
          orderNo,
          userId: uid,
          productId: parse.data.productId,
          retryHint: 1,
          note: "max_address_attempts_reached",
          counts: { maxAttempts: MAX_ATTEMPTS, skipIds: SKIP_ADDRESS_IDS.size },
        });
      } catch {}
      return reply.status(503).send({
        error: "usdt_address_pool_exhausted",
        message: "当前没有可用的 USDT 收款地址，请稍后重试或联系客服。",
      });
    }

    // 成功返回（PRD §4.2 字段）
    const base: any = orderResponse(final.order);
    base.expiresAt = expiresAt.toISOString();
    base.paymentMethod = "usdt_trc20_external";
    base.usdtPayment = {
      network: "tron_trc20",
      toAddress: final.address,
      toAddressMasked: final.addressMaskedOut,
      amountMinor: final.finalAmountMinor.toString(),
      currency: "USDT",
      displayAmountDecimal: (Number(final.finalAmountMinor) / 1_000_000).toFixed(6),
      baseAmountMinor: baseAmountMinor.toString(),
      finalAmountMinor: final.finalAmountMinor.toString(),
      actualTailMinor: Number(final.actualTailMinor),
      uniqueDeltaMinor: Number(final.uniqueDeltaMinor),
      /** @deprecated 兼容旧调用方，= actualTailMinor */
      uniqueTailMinor: Number(final.actualTailMinor),
      expiresAt: expiresAt.toISOString(),
      confirmationsTarget: USDT_CONFIRMATIONS_TARGET_DEFAULT,
      tokenContract: USDT_TRON_TOKEN_CONTRACT_DEFAULT,
    };
    return reply.status(201).send({
      ...base,
      ok: true,
      tip:
        "请在 20 分钟内从您的 TRON 钱包（T开头地址）向上面的收款地址，精确转款 " +
        base.usdtPayment.displayAmountDecimal +
        " USDT-TRC20。必须使用 TRC-20 网络，正确小数尾数，否则系统无法自动识别到账。",
      warnings: [
        "仅接受 TRC-20 (TRON 网络) 的 USDT，其他网络（ERC-20/BEP-20 等）将不自动认单，需人工审核。",
        "尾数唯一机制：实际应付金额比标价多位小数，尾数范围 0-99 单位 0.000001 USDT。错误尾数系统无法自动匹配订单。",
        "19 个区块确认后自动认单；可使用订单详情接口轮询订单状态。",
      ],
    });
  });

  fastify.get("/orders", async (req, reply) => {
    const uid = (req as any).userId as string | undefined;
    if (!uid) return reply.status(401).send({ error: "unauthorized" });

    const query = ordersQuerySchema.parse(req.query as any);
    const where: any = { userId: uid };
    if (query.status) where.status = query.status;

    const skip = (query.page - 1) * query.pageSize;
    const take = query.pageSize;

    const [total, rows] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip,
        take,
        include: { product: true, entitlements: true },
      }),
    ]);

    return {
      items: rows.map(orderResponse),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  });

  fastify.get<{ Params: { orderNo: string } }>("/orders/:orderNo", async (req, reply) => {
    const uid = (req as any).userId as string | undefined;
    if (!uid) return reply.status(401).send({ error: "unauthorized" });

    const order = await prisma.order.findUnique({
      where: { orderNo: req.params.orderNo },
      include: { product: true, entitlements: true },
    });
    if (!order || order.userId !== uid) return reply.status(404).send({ error: "not_found" });
    return orderResponse(order);
  });

  fastify.get(
    "/admin/orders",
    { preHandler: [requireAdmin("order:view")] },
    async (req, reply) => {
      const query = adminOrdersQuerySchema.parse(req.query ?? {});
      const where: any = {};
      if (query.status) where.status = query.status;
      if (query.orderNo) where.orderNo = { contains: query.orderNo };
      if (query.productId) where.productId = query.productId;
      if (query.telegramUserId !== undefined) {
        where.user = { telegramUserId: BigInt(query.telegramUserId) };
      }

      const skip = (query.page - 1) * query.pageSize;
      const take = query.pageSize;

      const [total, rows] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          skip,
          take,
          include: {
            user: true,
            product: true,
            entitlements: true,
            paymentTransactions: {
              take: 10,
              orderBy: [{ createdAt: "desc" }],
            },
          },
        }),
      ]);

      return reply.send({
        items: rows.map(adminOrderResponse),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      });
    },
  );

  fastify.get<{ Params: { orderNo: string } }>(
    "/admin/orders/:orderNo",
    { preHandler: [requireAdmin("order:view")] },
    async (req, reply) => {
      const order = await prisma.order.findUnique({
        where: { orderNo: req.params.orderNo },
        include: {
          user: true,
          product: true,
          entitlements: true,
          paymentTransactions: {
            take: 30,
            orderBy: [{ createdAt: "desc" }],
          },
        },
      });
      if (!order) return reply.status(404).send({ error: "not_found", message: "订单不存在" });
      return reply.send(adminOrderResponse(order));
    },
  );

  fastify.post<{ Params: { orderNo: string } }>(
    "/admin/orders/:orderNo/mark-paid",
    { preHandler: [requireAdmin("order:mark_paid")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const bodyParse = adminMarkPaidSchema.safeParse(req.body ?? {});
      if (!bodyParse.success) {
        return reply.status(400).send({ error: "bad_request", details: bodyParse.error.issues });
      }
      try {
        const result = await markOrderPaid(prisma, req.params.orderNo, {
          adminId: admin.adminId,
          reason: bodyParse.data.reason,
          ipAddress: (req.ip as string) || null,
          userAgent: (req.headers["user-agent"] as string) || null,
        });
        return {
          orderNo: result.order.orderNo,
          status: result.order.status,
          paidAt: result.order.paidAt?.toISOString() || null,
          idempotent: result.idempotent,
          entitlements: result.entitlements.map((e) => ({
            id: e.id,
            resourceType: e.resourceType,
            resourceId: e.resourceId,
            status: e.status,
            expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
          })),
        };
      } catch (err: any) {
        if (err?.code === "NOT_FOUND") return reply.status(404).send({ error: "not_found", message: "订单不存在" });
        if (err?.code === "CONFLICT") return reply.status(409).send({ error: "conflict", message: err.message });
        if (err?.code === "ADMIN_UNAUTHORIZED") return reply.status(401).send({ error: "admin_unauthorized", message: err.message });
        if (err?.code === "BAD_REQUEST") return reply.status(400).send({ error: "bad_request", message: err.message });
        throw err;
      }
    },
  );

  const adminReasonSchema = z.object({
    reason: z.string().min(2).max(1000),
  });

  fastify.post<{ Params: { orderNo: string } }>(
    "/admin/orders/:orderNo/cancel",
    { preHandler: [requireAdmin("order:cancel")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const bodyParse = adminReasonSchema.safeParse(req.body ?? {});
      if (!bodyParse.success) return reply.status(400).send({ error: "bad_request", details: bodyParse.error.issues });
      try {
        const result = await cancelOrder(prisma, req.params.orderNo, {
          adminId: admin.adminId,
          reason: bodyParse.data.reason,
          ipAddress: (req.ip as string) || null,
          userAgent: (req.headers["user-agent"] as string) || null,
        });
        return {
          orderNo: result.order.orderNo,
          status: result.order.status,
          idempotent: result.idempotent,
        };
      } catch (err: any) {
        if (err?.code === "NOT_FOUND") return reply.status(404).send({ error: "not_found", message: "订单不存在" });
        if (err?.code === "CONFLICT") return reply.status(409).send({ error: "conflict", message: err.message });
        if (err?.code === "BAD_REQUEST") return reply.status(400).send({ error: "bad_request", message: err.message });
        throw err;
      }
    },
  );

  fastify.post<{ Params: { orderNo: string } }>(
    "/admin/orders/:orderNo/refund",
    { preHandler: [requireAdmin("order:refund")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const bodyParse = adminReasonSchema.safeParse(req.body ?? {});
      if (!bodyParse.success) return reply.status(400).send({ error: "bad_request", details: bodyParse.error.issues });
      try {
        const result = await refundOrder(prisma, req.params.orderNo, {
          adminId: admin.adminId,
          reason: bodyParse.data.reason,
          ipAddress: (req.ip as string) || null,
          userAgent: (req.headers["user-agent"] as string) || null,
        });
        return {
          orderNo: result.order.orderNo,
          status: result.order.status,
          idempotent: result.idempotent,
          revokedEntitlements: result.revokedEntitlements.map((e) => ({
            id: e.id,
            resourceType: e.resourceType,
            resourceId: e.resourceId,
            status: e.status,
          })),
          channelKicks: result.channelKicks,
          userNotified: result.userNotified,
          notifyError: result.notifyError || null,
        };
      } catch (err: any) {
        if (err?.code === "NOT_FOUND") return reply.status(404).send({ error: "not_found", message: "订单不存在" });
        if (err?.code === "CONFLICT") return reply.status(409).send({ error: "conflict", message: err.message });
        if (err?.code === "BAD_REQUEST") return reply.status(400).send({ error: "bad_request", message: err.message });
        throw err;
      }
    },
  );

  // ================================================================
  // Sprint 3 V2 P0: 后台 finance Stars 退款
  // 安全：
  //   - 仅 finance 以上（order:refund 权限）
  //   - 先调 Telegram refundStarPayment（Bot API，带 350ms 节流），拿到 {ok:true} 后才写本地事务
  //   - 本地事务：order.status=refunded + paymentTransaction.status=refunded + refundedAt + adminAuditLog
  //   - 幂等：订单已 refunded 直接 return {idempotent:true}
  // ================================================================
  const adminStarsRefundSchema = z.object({
    reason: z.string().min(2).max(1000),
  });

  fastify.post<{ Params: { orderNo: string } }>(
    "/admin/orders/:orderNo/refund-stars",
    { preHandler: [requireAdmin("order:refund")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const bodyParse = adminStarsRefundSchema.safeParse(req.body ?? {});
      if (!bodyParse.success) return reply.status(400).send({ error: "bad_request", details: bodyParse.error.issues });

      const order = await prisma.order.findUnique({
        where: { orderNo: req.params.orderNo },
        include: {
          user: { select: { id: true, telegramUserId: true } },
          paymentTransactions: {
            where: { provider: "telegram", status: "confirmed" },
            orderBy: [{ createdAt: "asc" }],
            take: 1,
          },
        },
      });
      if (!order) return reply.status(404).send({ error: "not_found", message: "订单不存在" });
      if ((order as any).paymentMethod && (order as any).paymentMethod !== "telegram_stars") {
        return reply.status(400).send({
          error: "bad_request",
          message: `该订单支付方式为 ${(order as any).paymentMethod || "unknown"}，不是 Stars，不能走此退款接口。`,
        });
      }
      if (!order.paymentProvider || order.paymentProvider !== "telegram_stars") {
        return reply.status(400).send({ error: "bad_request", message: "该订单支付 provider 不是 telegram_stars，不能走 Stars 退款。" });
      }
      if (order.status === "refunded") {
        return reply.send({ ok: true, idempotent: true, orderNo: order.orderNo, status: order.status, tip: "该订单已处于退款完成状态。" });
      }
      if (order.status !== "paid") {
        return reply.status(409).send({
          error: "conflict",
          message: `当前订单状态为 ${order.status}，只有已支付(paid)订单可退款。`,
        });
      }
      const chargeId = order.providerOrderId
        ? String(order.providerOrderId)
        : order.paymentTransactions?.[0]?.providerChargeId
          ? String(order.paymentTransactions[0].providerChargeId)
          : null;
      if (!chargeId) {
        return reply.status(409).send({
          error: "conflict",
          message: "该 Stars 订单未记录 telegram_payment_charge_id，无法发起链上退款，走通用 /admin/orders/:no/refund 人工流程。",
        });
      }
      const tgid = order.user?.telegramUserId ? BigInt(order.user.telegramUserId.toString()) : null;

      // ① 先调 Bot API（函数级，不写库，350ms 节流）
      const refundResult = await refundStarsPayment({
        forUserIdPlain: tgid ?? undefined,
        telegramPaymentChargeId: chargeId,
      });
      if (!refundResult.ok) {
        return reply.status(502).send({
          ok: false,
          error: "stars_refund_api_failed",
          detail: {
            errorClass: refundResult.errorClass,
            reason: refundResult.reason,
            doc: "https://core.telegram.org/method/payments.refundStarsTransaction",
          },
          tip: "Stars 退款 API 调用失败，未扣减 Stars，本地订单状态未变更。",
        });
      }

      // ② API 成功 → 本地事务：订单 refunded + transaction refunded + 审计
      const now = new Date();
      const metaReason = bodyParse.data.reason;
      let finalResult: any;
      try {
        finalResult = await prisma.$transaction(async (tx: any) => {
          // 幂等 CAS：在事务里再查一次 status（怕并发退款）
          const fresh = await tx.order.findUnique({ where: { id: order.id } });
          if (!fresh) throw Object.assign(new Error("order_gone"), { code: "NOT_FOUND" });
          if (fresh.status === "refunded") {
            return { idempotent: true, order: fresh, txRow: null };
          }
          if (fresh.status !== "paid") {
            throw Object.assign(new Error(`status_${fresh.status}_not_paid`), { code: "CONFLICT" });
          }

          // 写 order refunded 行
          const refundedOrder = await tx.order.update({
            where: { id: fresh.id },
            data: {
              status: "refunded",
              refundedAt: now,
              refundReason: metaReason.slice(0, 1000),
              refundAdminId: admin.adminId,
            },
          });

          // 更新对应 confirmed paymentTransaction 为 refunded
          let refundedTx: any = null;
          const targetTx = order.paymentTransactions?.[0];
          if (targetTx) {
            refundedTx = await tx.paymentTransaction.update({
              where: { id: targetTx.id },
              data: {
                status: "refunded",
                refundedAt: now,
                refundAdminId: admin.adminId,
                refundReason: metaReason.slice(0, 1000),
              },
            });
          }

          // 审计
          await tx.adminAuditLog.create({
            data: {
              adminId: admin.adminId,
              action: "order.refund_stars",
              objectType: "order",
              objectId: fresh.orderNo,
              reason: metaReason.slice(0, 1000),
              ipAddress: (req.ip as string) || null,
              userAgent: (req.headers["user-agent"] as string) || null,
              afterValue: {
                chargeId: chargeId,
                viaUserId: tgid ? String(tgid) : null,
                provider: "telegram_stars",
                txId: refundedTx?.id ?? null,
                refundOrderAmountMinor: String(fresh.amountMinor),
                refundOrderCurrency: fresh.currency,
              },
            },
          });

          return { idempotent: false, order: refundedOrder, txRow: refundedTx };
        });
      } catch (e: any) {
        if (e?.code === "NOT_FOUND") return reply.status(404).send({ error: "not_found", message: "订单不存在" });
        if (e?.code === "CONFLICT") {
          return reply.status(409).send({
            error: "conflict",
            message: e?.message || "订单状态已变更，无法执行退款。",
          });
        }
        throw e;
      }

      return reply.send({
        ok: true,
        idempotent: !!finalResult.idempotent,
        orderNo: order.orderNo,
        status: finalResult.order?.status || order.status,
        refundedAt: now.toISOString(),
        starsRefund: {
          chargeId,
          viaUserId: tgid ? String(tgid) : null,
        },
        tip: finalResult.idempotent
          ? "Stars 退款已幂等成功（之前已完成）。"
          : "Stars 退款已完成：Telegram 侧退还 Stars，本地订单与交易行已同步为 refunded，审计已写入。",
      });
    },
  );

  // ============================================================
  // Sprint 3 V2 P1: USDT 地址池管理端点（仅 finance / super_admin）
  //   · GET  /api/admin/payment-addresses        列表 + 统计
  //   · POST /api/admin/payment-addresses        新增地址（私钥绝不入库，仅 T 开头地址）
  //   · POST /api/admin/payment-addresses/:id/retire   人工停用（已 assigned 的先释放再 retire）
  // ============================================================
  const paymentAddressListQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30),
    status: z.enum(["available", "assigned", "retired"]).optional(),
    network: z.string().max(32).optional(),
    addressKeyword: z.string().max(64).optional(),
  });
  const createAddressSchema = z.object({
    address: z.string().min(8).max(64),
    network: z.string().min(3).max(32).default("tron_trc20"),
  });
  const retireAddressSchema = z.object({
    reason: z.string().min(2).max(128),
    forceReleaseAssigned: z.boolean().default(false),
    forceCancelActiveOrder: z.boolean().default(false),
  });

  fastify.get(
    "/admin/payment-addresses",
    { preHandler: [requireAdmin("finance.view")] },
    async (req, reply) => {
      const q = paymentAddressListQuery.parse(req.query ?? {});
      const where: any = {};
      if (q.status) where.status = q.status;
      if (q.network) where.network = q.network;
      if (q.addressKeyword) where.address = { contains: q.addressKeyword.slice(0, 64) };
      const skip = (q.page - 1) * q.pageSize;
      const [total, rows, summary] = await Promise.all([
        prisma.paymentAddress.count({ where }),
        prisma.paymentAddress.findMany({
          where,
          orderBy: [{ status: "asc" }, { assignedAt: "asc" }, { id: "asc" }],
          skip,
          take: q.pageSize,
        }),
        prisma.paymentAddress.groupBy({
          by: ["status", "network"],
          _count: { id: true },
        }),
      ]);
      return reply.send({
        items: rows.map((r: any) => ({
          id: r.id,
          network: r.network,
          addressMasked: r.addressMasked || addressMasked(r.address),
          status: r.status,
          assignedOrderId: r.assignedOrderId || null,
          assignedAt: r.assignedAt ? new Date(r.assignedAt).toISOString() : null,
          releaseAt: r.releaseAt ? new Date(r.releaseAt).toISOString() : null,
          retiredAt: r.retiredAt ? new Date(r.retiredAt).toISOString() : null,
          retireReason: r.retireReason || null,
          createdAt: new Date(r.createdAt).toISOString(),
        })),
        summary: {
          countsByStatusNetwork: summary.map((g: any) => ({
            status: g.status, network: g.network, count: g._count.id,
          })),
        },
        pagination: {
          page: q.page, pageSize: q.pageSize, total,
          totalPages: Math.ceil(total / q.pageSize),
        },
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/payment-addresses/:id/reveal",
    { preHandler: [requireAdmin("*")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      if (admin.role !== "super_admin") {
        return reply.status(403).send({ error: "forbidden", message: "仅 super_admin 可查看完整收款地址明文" });
      }
      const id = req.params.id;
      const done = await prisma.$transaction(async (tx: any) => {
        const row: any = await tx.paymentAddress.findUnique({ where: { id } });
        if (!row) return { notFound: true };
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: "payment_address.reveal_plaintext",
            objectType: "payment_address",
            objectId: String(row.id),
            reason: "super_admin 短时一次性查看收款地址明文",
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
            beforeValue: {
              status: row.status,
              assigned: !!row.assignedOrderId,
              addressMasked: row.addressMasked || addressMasked(row.address),
            },
            afterValue: {
              // 仅审计记录本次查看触发的动作，明文不存储在 afterValue 中避免审计表泄露
              revealedAt: new Date().toISOString(),
              addressMasked: row.addressMasked || addressMasked(row.address),
              network: row.network,
            },
          },
        });
        return { ok: true, row };
      });
      if ((done as any).notFound) return reply.status(404).send({ error: "not_found" });
      return reply.send({
        ok: true,
        id: (done as any).row.id,
        network: (done as any).row.network,
        address: (done as any).row.address,
        addressMasked: (done as any).row.addressMasked || addressMasked((done as any).row.address),
        status: (done as any).row.status,
        warning: "USDT 明文收款地址已记录审计，请勿截图或外传。",
      });
    },
  );

  fastify.post(
    "/admin/payment-addresses",
    { preHandler: [requireAdmin("finance.manage_pools")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const body = createAddressSchema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });
      const { address, network } = body.data;
      const trimmed = address.trim();
      if (network === "tron_trc20" && !trimmed.startsWith("T")) {
        return reply.status(400).send({ error: "bad_request", message: "TRON 地址必须以 T 开头" });
      }
      try {
        const row = await prisma.$transaction(async (tx: any) => {
          const created: any = await tx.paymentAddress.create({
            data: {
              network,
              address: trimmed,
              addressMasked: addressMasked(trimmed),
              status: "available",
            },
          });
          await tx.adminAuditLog.create({
            data: {
              adminId: admin.adminId,
              action: "payment_address.add",
              objectType: "payment_address",
              objectId: String(created.id),
              reason: "finance: 新增 USDT 收款地址",
              ipAddress: (req.ip as string) || null,
              userAgent: (req.headers["user-agent"] as string) || null,
              afterValue: { network, addressMasked: addressMasked(trimmed) },
            },
          });
          return created;
        });
        return reply.status(201).send({ ok: true, id: row.id, addressMasked: row.addressMasked, status: row.status });
      } catch (e: any) {
        if (e?.code === "P2002") {
          return reply.status(409).send({ error: "conflict", message: "该地址已存在于地址池，请勿重复添加。" });
        }
        throw e;
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/payment-addresses/:id/retire",
    { preHandler: [requireAdmin("finance.manage_pools")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const body = retireAddressSchema.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });
      const { reason, forceReleaseAssigned, forceCancelActiveOrder } = body.data;
      const id = req.params.id;

      try {
        const done = await prisma.$transaction(async (tx: any) => {
          const row: any = await tx.paymentAddress.findUnique({ where: { id } });
          if (!row) return { notFound: true };
          if (row.status === "retired") return { idempotent: true, row };
          let activeOrder: any = null;
          if (row.assignedOrderId) {
            activeOrder = await tx.order.findUnique({ where: { id: row.assignedOrderId } });
          }
          const orderIsActive = activeOrder
            ? (["pending", "processing"].includes(String(activeOrder.status))
                && (!activeOrder.expiresAt || new Date(activeOrder.expiresAt).getTime() >= Date.now()))
            : false;
          if (row.status === "assigned" && !forceReleaseAssigned) {
            return { conflict: "address_assigned_need_force", detail: orderIsActive ? "has_active_order" : "only_assigned" };
          }
          if (row.status === "assigned" && forceReleaseAssigned && orderIsActive) {
            if (!forceCancelActiveOrder) {
              return {
                conflict: "active_order_requires_cancel",
                detail: {
                  orderNo: activeOrder.orderNo,
                  orderStatus: activeOrder.status,
                  message: "assigned 地址仍关联未过期的 pending/processing 订单，需要取消订单后才能释放；或传入 forceCancelActiveOrder=true 自动取消。",
                },
              };
            }
            await tx.order.update({
              where: { id: activeOrder.id },
              data: {
                status: "cancelled",
                rejectedAt: new Date(),
              },
            });
            await tx.paymentAddress.update({
              where: { id },
              data: {
                assignedOrderId: null,
                assignedAt: null,
                releaseAt: null,
              },
            });
          } else if (row.status === "assigned" && forceReleaseAssigned) {
            await tx.paymentAddress.update({
              where: { id },
              data: {
                assignedOrderId: null,
                assignedAt: null,
                releaseAt: null,
              },
            });
          }
          const retired: any = await tx.paymentAddress.update({
            where: { id },
            data: {
              status: "retired",
              retiredAt: new Date(),
              retireReason: reason.slice(0, 128),
            },
          });
          await tx.adminAuditLog.create({
            data: {
              adminId: admin.adminId,
              action: "payment_address.retire",
              objectType: "payment_address",
              objectId: String(retired.id),
              reason: reason.slice(0, 1000),
              ipAddress: (req.ip as string) || null,
              userAgent: (req.headers["user-agent"] as string) || null,
              beforeValue: {
                oldStatus: row.status,
                assignedOrderId: row.assignedOrderId,
                forceReleaseAssigned,
                forceCancelActiveOrder,
                cancelledActiveOrderNo: forceCancelActiveOrder && orderIsActive ? activeOrder?.orderNo : null,
              },
            },
          });
          return {
            ok: true,
            row: retired,
            releasedAssigned: row.status === "assigned" && forceReleaseAssigned,
            cancelledActiveOrderNo: forceCancelActiveOrder && orderIsActive ? activeOrder?.orderNo : null,
          };
        });

        if ((done as any).notFound) return reply.status(404).send({ error: "not_found", message: "地址不存在" });
        if ((done as any).conflict === "address_assigned_need_force") {
          return reply.status(409).send({
            error: "conflict",
            code: "address_assigned_need_force",
            message: "该地址当前正被订单占用，请先等待订单窗口结束或显式传入 forceReleaseAssigned=true 强制释放。",
          });
        }
        if ((done as any).conflict === "active_order_requires_cancel") {
          const d = (done as any).detail;
          return reply.status(409).send({
            error: "conflict",
            code: "active_order_requires_cancel",
            orderNo: d?.orderNo,
            orderStatus: d?.orderStatus,
            message: d?.message,
          });
        }
        return reply.send({
          ok: true,
          idempotent: !!(done as any).idempotent,
          id,
          status: (done as any).row.status,
          retiredAt: (done as any).row.retiredAt ? new Date((done as any).row.retiredAt).toISOString() : null,
          releasedAssigned: !!(done as any).releasedAssigned,
          cancelledActiveOrderNo: (done as any).cancelledActiveOrderNo || null,
        });
      } catch (e: any) {
        if (e?.code === "P2002") {
          return reply.status(409).send({ error: "conflict", message: "审计或地址写入唯一约束冲突，请重试。" });
        }
        throw e;
      }
    },
  );

  fastify.post(
    "/admin/payment-addresses/_release-expired-now",
    { preHandler: [requireAdmin("finance.manage_pools")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const r = await prisma.$transaction(async (tx: any) => {
        // P0-2：releaseExpiredUsdtAddresses 现在接受 tx，所有 UPDATE 用同一事务连接；异常向外冒泡时，后续 tx.adminAuditLog 也不会跑，整体 ROLLBACK，「业务+审计」真正原子提交
        const result = await releaseExpiredUsdtAddresses(tx);
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: "payment_address.release_expired_now",
            objectType: "payment_address",
            objectId: "ALL",
            reason: "finance 手动触发地址池过期回收",
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
            afterValue: { released: result.released, errors: result.errors, triggeredAt: new Date().toISOString() },
          },
        });
        return result;
      });
      return reply.send({ ok: true, released: r.released, errors: r.errors });
    },
  );

  fastify.get<{ Params: { orderNo: string } }>(
    "/admin/orders/:orderNo/audit-logs",
    { preHandler: [requireAdmin("order:view")] },
    async (req, reply) => {
      const logs = await prisma.adminAuditLog.findMany({
        where: {
          objectType: "order",
          objectId: req.params.orderNo,
        },
        orderBy: { createdAt: "asc" },
        include: {
          admin: {
            select: {
              id: true,
              email: true,
              displayName: true,
              role: true,
            },
          },
        },
      });
      return reply.send({
        items: logs.map((l: any) => ({
          id: l.id,
          action: l.action,
          reason: l.reason,
          ipAddress: l.ipAddress,
          userAgent: l.userAgent,
          createdAt: l.createdAt.toISOString(),
          admin: l.admin
            ? {
                id: l.admin.id,
                email: l.admin.email,
                displayName: l.admin.displayName,
                role: l.admin.role,
              }
            : null,
        })),
      });
    },
  );

  function requireUser(req: any, reply: any, done: any) {
    const uid = req.userId as string | undefined;
    if (!uid) return reply.status(401).send({ error: "unauthorized", message: "请先在 Telegram Mini App 登录" });
    done();
  }

  fastify.get(
    "/user/orders",
    { preHandler: [requireUser] },
    async (req, reply) => {
      const uid = (req as any).userId as string;
      const parse = ordersQuerySchema.safeParse(req.query ?? {});
      if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });
      const query = parse.data;

      const where: any = { userId: uid };
      if (query.status) where.status = query.status;

      const skip = (query.page - 1) * query.pageSize;
      const take = query.pageSize;

      const orderBy = [{ createdAt: "desc" as const }];
      const [total, rows] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy,
          skip,
          take,
          include: {
            product: true,
            entitlements: true,
          },
        }),
      ]);

      return reply.send({
        items: rows.map(orderResponse),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      });
    },
  );

  fastify.get(
    "/user/entitlements",
    { preHandler: [requireUser] },
    async (req, reply) => {
      const uid = (req as any).userId as string;
      const now = new Date();
      const rows = await prisma.entitlement.findMany({
        where: { userId: uid },
        orderBy: [{ status: "asc" }, { expiresAt: "desc" }],
        include: { sourceOrder: { select: { orderNo: true } } },
      });

      const memberships: any[] = [];
      const packages: any[] = [];
      const contents: any[] = [];
      const others: any[] = [];
      rows.forEach((e: any) => {
        const item = {
          id: e.id,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          status: e.status,
          startsAt: e.startsAt.toISOString(),
          expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
          orderNo: e.sourceOrder?.orderNo || null,
        };
        if (e.resourceType === "membership_channel") memberships.push(item);
        else if (e.resourceType === "package") packages.push(item);
        else if (e.resourceType === "content") contents.push(item);
        else others.push(item);
      });

      const pkgIds = packages.map((e) => e.resourceId);
      const pkgMeta: Record<string, { title: string | null; coverUrl: string | null; itemsCount: number; itemTitles: string[] }> = {};
      if (pkgIds.length > 0) {
        const pkgRows = await prisma.contentPackage.findMany({
          where: { id: { in: pkgIds } },
          select: {
            id: true,
            title: true,
            coverUrl: true,
            _count: { select: { contents: true } },
            contents: { take: 20, select: { title: true } },
          },
        });
        pkgRows.forEach((pkg: any) => {
          pkgMeta[pkg.id] = {
            title: pkg.title || null,
            coverUrl: pkg.coverUrl || null,
            itemsCount: pkg._count.contents,
            itemTitles: pkg.contents.map((c: any) => c.title).filter(Boolean),
          };
        });
      }

      const contentIds = contents.map((e) => e.resourceId);
      const contentMeta: Record<string, { title: string | null; coverUrl: string | null; durationSeconds: number | null }> = {};
      if (contentIds.length > 0) {
        const cRows = await prisma.content.findMany({
          where: { id: { in: contentIds } },
          select: { id: true, title: true, coverUrl: true, durationSeconds: true },
        });
        cRows.forEach((c: any) => {
          contentMeta[c.id] = {
            title: c.title || null,
            coverUrl: c.coverUrl || null,
            durationSeconds: c.durationSeconds,
          };
        });
      }

      const activeMembership = memberships.find(
        (m) => m.status === "active" && (!m.expiresAt || new Date(m.expiresAt).getTime() >= now.getTime()),
      );
      const latestMembership = memberships[0] || null;
      return reply.send({
        summary: {
          membership: activeMembership
            ? { status: "active", expiresAt: activeMembership.expiresAt }
            : latestMembership && !activeMembership
            ? { status: latestMembership.status, expiresAt: latestMembership.expiresAt }
            : { status: "none", expiresAt: null },
          totalEntitlements: rows.length,
        },
        memberships,
        packages: packages.map((p) => ({ ...p, meta: pkgMeta[p.resourceId] || null })),
        contents: contents.map((c) => ({ ...c, meta: contentMeta[c.resourceId] || null })),
        others,
      });
    },
  );
}
