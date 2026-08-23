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
import { userIdIndexKey, chatIdIndexKey, shortFingerprint } from "../utils/crypto.js";
import { emitSafetyEvent, emitStructuredLog } from "../utils/structuredError.js";
import { normalizeStoredXtrAmountToStars } from "../utils/currency.js";
import { notifyPaymentSuccess } from "../services/paymentSuccessNotifier.js";
import { computePaymentAddressIntegrityMac, verifyAndFreezePaymentAddressIntegrity } from "../services/paymentAddressIntegrity.js";

const TRON_BASE58_ADDRESS_RE = /^T[A-Za-z0-9]{8,63}$/;

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

const STARS_CONTINUE_WINDOW_MS = Math.min(STARS_ORDER_EXPIRES_MS, 30 * 60 * 1000); // 续付窗口（30min，不超过订单本身过期时间）

/**
 * A product can keep its canonical Stars price while exposing an independent
 * USDT-TRC20 checkout price. Legacy USDT-only products remain supported.
 */
function resolveUsdtPriceMinor(product: { priceMinor: bigint; currency?: string | null; usdtPriceMinor?: bigint | null }): bigint | null {
  if (product.usdtPriceMinor != null) {
    const alternative = BigInt(product.usdtPriceMinor.toString());
    return alternative > 0n ? alternative : null;
  }
  if (String(product.currency || "").toUpperCase() !== "USDT") return null;
  const legacy = BigInt(product.priceMinor.toString());
  return legacy > 0n ? legacy : null;
}

function orderResponse(o: any, opts?: { exposeInvoiceIfOwnedBy?: string | null; exposeUsdtPaymentIfOwnedBy?: string | null }) {
  const out: any = {
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
          usdtPriceMinor: o.product.usdtPriceMinor?.toString() ?? null,
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
  // 安全暴露 invoiceLink：
  //   - 订单本人
  //   - 支付方式 telegram_stars
  //   - 当前状态 pending/processing
  //   - 创建时间 <= 30min
  //   - 列非空
  if (
    opts?.exposeInvoiceIfOwnedBy &&
    typeof o.userId === "string" &&
    o.userId === opts.exposeInvoiceIfOwnedBy &&
    (o.paymentMethod === "telegram_stars" || o.paymentProvider === "telegram_stars") &&
    (o.status === "pending" || o.status === "processing") &&
    typeof o.telegramStarsInvoiceLink === "string" &&
    o.telegramStarsInvoiceLink.length > 0 &&
    Date.now() - new Date(o.createdAt).getTime() < STARS_CONTINUE_WINDOW_MS
  ) {
    out.invoiceLink = o.telegramStarsInvoiceLink;
    out.invoiceVia = o.telegramStarsInvoiceVia ?? null;
  }
  // H5 刷新或重新打开待支付订单时，必须能继续取得该订单的收款地址。
  // 地址只返回给订单本人，且仅限仍可支付的 USDT 订单，避免在通用订单列表泄露。
  if (
    opts?.exposeUsdtPaymentIfOwnedBy &&
    typeof o.userId === "string" &&
    o.userId === opts.exposeUsdtPaymentIfOwnedBy &&
    o.currency === "USDT" &&
    (o.status === "pending" || o.status === "processing") &&
    typeof o.usdtPaymentAddress?.address === "string" &&
    o.usdtPaymentAddress.address.length > 0
  ) {
    const finalAmountMinor = o.amountMinor?.toString() ?? null;
    const baseAmountMinor = resolveUsdtPriceMinor(o.product)?.toString() ?? finalAmountMinor;
    out.usdtPayment = {
      network: "tron_trc20",
      toAddress: o.usdtPaymentAddress.address,
      amountMinor: finalAmountMinor,
      baseAmountMinor,
      displayAmountDecimal: finalAmountMinor ? (Number(finalAmountMinor) / 1_000_000).toFixed(6) : null,
      confirmationsTarget: USDT_CONFIRMATIONS_TARGET_DEFAULT,
    };
  }
  return out;
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
    const productPriceStored = BigInt(product.priceMinor.toString());
    const amountMinor = normalizeStoredXtrAmountToStars(productPriceStored);
    if (amountMinor <= 0n) {
      return reply.status(400).send({ error: "bad_request", message: "商品价格无效（Telegram Stars 金额必须为正整数）" });
    }

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

    // 生成 Stars Invoice（createInvoiceLink）
    const title = product.title?.slice(0, 128) || "InTune 数字内容";
    const descLines: string[] = [];
    if (product.type === "membership" && product.durationDays) descLines.push(`会员时长：${product.durationDays} 天`);
    else if (product.type === "package") descLines.push("类型：内容包");
    else if (product.type === "single") descLines.push("类型：单条内容");
    descLines.push("支付后自动解锁对应内容或私密频道访问权（20 分钟内未支付则订单失效）。");
    const description = descLines.join(" · ").slice(0, 255);
    const prices = [{ label: product.title?.slice(0, 60) || "数字内容", amount: Number(amountMinor) }];

    // ============= P0-#1-C FIX：强制 createInvoiceLink，禁止 DM 模式返回占位 =============
    // telegramBot.ts 内部会：若传了 sendToTelegramUserId，则「额外」私信一张发票给用户（仅提醒，不影响主链接）；
    // 这里只调用一次 createStarsInvoice，并在路由层再校验前缀 https://t.me/ 以 Fail-Closed。
    let inv: CreateStarsInvoiceResult;
    try {
      inv = await createStarsInvoice({
        title,
        description,
        payload: payloadPlain,
        currency: "XTR",
        prices,
        sendToTelegramUserId: tgid ?? undefined, // 仅作额外私信提醒，不决定 invoiceLink
      });
    } catch (e: any) {
      inv = { ok: false, errorClass: "stars_invoice_unexpected_exception", reason: e?.message || String(e) };
    }

    const base: any = orderResponse(order);
    base.expiresAt = expiresAt.toISOString();
    base.paymentMethod = "telegram_stars";

    // 路由层二次 Fail-Closed 校验：链接必须是 https://t.me/
    if (!inv.ok || typeof (inv as any).invoiceLink !== "string" || !(inv as any).invoiceLink.startsWith("https://t.me/")) {
      const reason = inv.ok
        ? `stars_invoice_link_malformed:len=${(inv as any).invoiceLink?.length || 0}`
        : (inv as any).reason?.slice?.(0, 120) || "create_stars_invoice_failed";
      emitSafetyEvent(
        {
          event: "stars_create_invoice_failed",
          errorClass: "business",
          userId: uid,
          productId: product.id,
          orderNo,
          note: reason,
          counts: { attempt: 1 },
        },
      );
      return reply.status(503).send({
        ...base,
        ok: false,
        error: "stars_invoice_service_unavailable",
        userError: "stars_invoice_service_unavailable",
        message: "Stars 发票服务暂时不可用（Bot 未配置或 API 失败），请稍后重试或联系运营。",
      });
    }

    // 保存 invoiceLink 到 DB，保证 /api/user/orders 返回的本人待支付订单包含 invoiceLink（续付用）
    try {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          telegramStarsInvoiceLink: inv.invoiceLink,
          telegramStarsInvoiceVia: inv.via || null,
        },
      });
    } catch (e) {
      emitSafetyEvent(
        {
          event: "stars_save_invoice_failed",
          errorClass: "db_error",
          prismaCode: (e as any)?.code,
          orderNo,
          userId: uid,
        },
        e,
      );
      // 不中断主流程：返回 invoiceLink 给前端（但列表就查不到续付了，所以失败需要告警）
    }

    const withInvoice = { ...base, invoiceLink: inv.invoiceLink, invoiceVia: inv.via || null };

    return reply.status(201).send({
      ok: true,
      paymentMethod: "telegram_stars",
      created: withInvoice,       // <=== 前端 created.invoiceLink 主读取
      invoice: {                 // <=== 向后兼容
        via: inv.via,
        invoiceLink: inv.invoiceLink,
      },
      expiresAt: expiresAt.toISOString(),
      tip: "请在 Telegram Mini App 中使用 tg.openInvoice(invoiceLink) 完成 Stars 支付；若在站外 H5，请点击提供的发票链接跳转支付。",
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
    const baseAmountMinor = resolveUsdtPriceMinor(productPre);
    if (baseAmountMinor == null) {
      return reply.status(400).send({
        error: "usdt_price_not_configured",
        message: "该商品尚未配置 USDT-TRC20 价格，请选择 Telegram Stars 或联系平台运营。",
      });
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
              currency: "USDT",
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
        include: { product: true, entitlements: true, usdtPaymentAddress: true },
      }),
    ]);

    return {
      items: rows.map((o: any) => orderResponse(o, { exposeInvoiceIfOwnedBy: uid, exposeUsdtPaymentIfOwnedBy: uid })),
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
      include: { product: true, entitlements: true, usdtPaymentAddress: true },
    });
    if (!order || order.userId !== uid) return reply.status(404).send({ error: "not_found" });
    return orderResponse(order, { exposeInvoiceIfOwnedBy: uid, exposeUsdtPaymentIfOwnedBy: uid });
  });

  // ============================================================
  // P0 修复：Stars 订单「安全续付」接口
  // 严格前置校验（任何一条不满足立即返回结构化中文错误，绝不新建订单）：
  //   1) 本人 (req.userId === order.userId)
  //   2) 支付方式 telegram_stars
  //   3) 状态 pending / processing
  //   4) 创建时间 <= STARS_CONTINUE_WINDOW_MS (30min，不超过订单本身 expiresAt)
  //   5) telegramStarsInvoiceLink 非空
  //   6) 订单本身 expiresAt 未过期
  // 命中则返回 { ok:true, order:{ invoiceLink }, orderNo, remainMs }
  // 未命中按下列业务错误码（已在前端 CLIENT_ERROR_ZH/H5_ERROR_ZH 对应用户友好中文）：
  //   stars_continue_not_pending / stars_continue_expired / stars_continue_no_invoice / not_found / forbidden
  // ============================================================
  fastify.post<{ Params: { orderNo: string } }>("/orders/:orderNo/continue-stars", async (req, reply) => {
    const uid = (req as any).userId as string | undefined;
    if (!uid) return reply.status(401).send({ error: "unauthorized", message: "请先在 Telegram Mini App 或 H5 登录后再续付订单" });

    const orderNo = req.params.orderNo;
    const order = await prisma.order.findUnique({
      where: { orderNo },
      include: { product: true, entitlements: true },
    });
    if (!order) return reply.status(404).send({ error: "not_found", userError: "stars_continue_not_found", message: "未找到该订单（可能已被删除或订单号错误）" });
    if (order.userId !== uid) return reply.status(403).send({ error: "forbidden", userError: "stars_continue_not_owner", message: "该订单不是你的，无法续付（可在 Mini App 或 H5 中发起新单）" });

    const isStars = order.paymentMethod === "telegram_stars" || order.paymentProvider === "telegram_stars" || (order.currency || "").toUpperCase() === "XTR";
    if (!isStars) return reply.status(409).send({ error: "stars_continue_not_stars", userError: "stars_continue_not_stars", message: "该订单不是 Telegram Stars 支付，不能使用 Stars 续付接口（你可能需要使用 USDT 支付通道）" });
    if (order.status !== "pending" && order.status !== "processing") {
      const zhMap: Record<string, string> = {
        paid: "该订单已支付完成，无需再次续付（可直接进入「我的频道」）。",
        expired: "该订单已超过支付窗口，请重新创建订单。",
        cancelled: "该订单已取消，不能续付。",
        refunded: "该订单已退款，不能续付。",
        failed: "该订单支付失败，请重新创建订单。",
      };
      return reply.status(409).send({
        error: "stars_continue_not_pending",
        userError: "stars_continue_not_pending",
        message: zhMap[order.status as string] || "该订单已不处于待支付状态，请重新创建订单。",
      });
    }

    const ageMs = Date.now() - new Date(order.createdAt).getTime();
    if (ageMs > STARS_CONTINUE_WINDOW_MS) {
      return reply.status(409).send({ error: "stars_continue_expired", userError: "stars_continue_expired", message: "Stars 续付窗口（30 分钟）已过，请重新创建订单（旧单将在订单本身过期时间后自动标记为过期）。" });
    }
    if (order.expiresAt && Date.now() > new Date(order.expiresAt).getTime()) {
      return reply.status(409).send({ error: "payment_expired", userError: "payment_expired", message: "订单已过期，请重新创建订单。" });
    }
    if (!order.telegramStarsInvoiceLink || typeof order.telegramStarsInvoiceLink !== "string" || order.telegramStarsInvoiceLink.length === 0) {
      return reply.status(409).send({ error: "stars_continue_no_invoice", userError: "stars_continue_no_invoice", message: "该旧单未保存发票链接（可能是旧版本创建的订单），请重新创建订单。" });
    }

    // ============= P0-#1-C FIX：脏数据兼容 + 强校验前缀 =============
    // 若旧订单存的是 tg:invoice 占位（之前 sendInvoice 模式的 bug 产物），立刻重开一张 createInvoiceLink 并更新 DB。
    // 所有返回必须是 https://t.me/ 开头的真实链接。
    let useInvoiceLink = order.telegramStarsInvoiceLink;
    let useVia: "createInvoiceLink" | null = order.telegramStarsInvoiceVia === "createInvoiceLink" ? "createInvoiceLink" : null;
    if (!useInvoiceLink.startsWith("https://t.me/")) {
      const product = order.product as any;
      const amtMinor = normalizeStoredXtrAmountToStars(order.amountMinor || "0").toString();
      const ttlTitle = product?.title?.slice?.(0, 128) || "InTune 数字内容";
      const payloadPlain = (order as any).telegramStarsPayload || `${order.orderNo}:${amtMinor}:${uid}`;
      const pricesArr = [{ label: (product?.title || "数字内容").slice(0, 60), amount: Number(amtMinor) }];
      const tgid: bigint | null = order.user ? (order.user as any).telegramUserId : null;
      const reinv: CreateStarsInvoiceResult = await createStarsInvoice({
        title: ttlTitle,
        description: `旧单 ${order.orderNo} 续付（已重新生成真实发票链接）`,
        payload: payloadPlain,
        currency: "XTR",
        prices: pricesArr,
        sendToTelegramUserId: tgid ?? undefined,
      });
      if (!reinv.ok || !reinv.invoiceLink.startsWith("https://t.me/")) {
        emitSafetyEvent({
          event: "stars_continue_re_invoice_failed",
          errorClass: "business",
          userId: uid,
          productId: order.productId,
          orderNo,
          note: (reinv as any).reason?.slice?.(0, 120) || "recreate_stars_invoice_failed",
        });
        return reply.status(503).send({
          ok: false,
          orderNo: order.orderNo,
          error: "stars_invoice_service_unavailable",
          userError: "stars_invoice_service_unavailable",
          message: "Stars 续付服务暂时不可用（旧单占位发票重开失败），请稍后重试。",
        });
      }
      useInvoiceLink = reinv.invoiceLink;
      useVia = "createInvoiceLink";
      try {
        await prisma.order.update({
          where: { id: order.id },
          data: { telegramStarsInvoiceLink: useInvoiceLink, telegramStarsInvoiceVia: useVia },
        });
      } catch (e: any) {
        emitSafetyEvent({
          event: "stars_continue_save_re_invoice_failed",
          errorClass: "db_error",
          prismaCode: e?.code,
          orderNo,
          userId: uid,
        }, e);
        // 保存失败不影响返回前端（返回新链接即可）
      }
    }

    emitStructuredLog({
      event: "stars_continue_hit",
      userId: uid,
      orderNo: order.orderNo,
      productId: order.productId,
      counts: { remainMs: Math.max(0, STARS_CONTINUE_WINDOW_MS - ageMs) },
    });

    // 用经校验的新链接包装订单响应：在 orderResponse 基础上覆盖 invoiceLink 字段（确保 exposeInvoiceIfOwnedBy 已允许后，强制用真实链接）
    const baseOrder = orderResponse(order, { exposeInvoiceIfOwnedBy: uid }) as any;
    if (typeof baseOrder === "object" && baseOrder !== null) {
      baseOrder.invoiceLink = useInvoiceLink;
      baseOrder.invoiceVia = useVia || baseOrder.invoiceVia;
    }

    return reply.status(200).send({
      ok: true,
      orderNo: order.orderNo,
      order: baseOrder,
      remainMs: Math.max(0, STARS_CONTINUE_WINDOW_MS - ageMs),
      tip: "请在 Telegram Mini App 中打开返回的 invoiceLink，完成 Stars 支付；若在站外 H5，请点击提供的发票链接跳转支付。",
    });
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
            usdtPaymentAddress: true,
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
        if (!result.idempotent) {
          await notifyPaymentSuccess({
            orderNo: result.order.orderNo,
            paymentMethod: "manual",
            amountMinor: result.order.amountMinor,
            currency: result.order.currency,
            productTitle: result.order.product?.title,
            userDisplayName: result.order.user?.displayName,
          });
        }
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
                chargeFingerprint: shortFingerprint("telegram_charge", chargeId),
                viaUserFingerprint: tgid ? shortFingerprint("telegram_user", tgid) : null,
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
        starsRefund: { confirmed: true },
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
    status: z.enum(["pending_approval", "available", "assigned", "retired"]).optional(),
    network: z.string().max(32).optional(),
    addressKeyword: z.string().max(64).optional(),
  }).strict();
  const createAddressSchema = z.object({
    address: z.string().min(8).max(64),
    network: z.string().min(3).max(32).default("tron_trc20"),
  }).strict();
  const approveAddressSchema = z.object({
    reason: z.string().min(2).max(128).default("super_admin 批准收款地址投入使用"),
  }).strict();
  const retireAddressSchema = z.object({
    reason: z.string().min(2).max(128),
    forceReleaseAssigned: z.boolean().default(false),
    forceCancelActiveOrder: z.boolean().default(false),
  }).strict();

  fastify.get(
    "/admin/payment-addresses/monitor-status",
    { preHandler: [requireAdmin("finance.view")] },
    async (_req, reply) => {
      const [grouped, runtime] = await Promise.all([
        prisma.paymentAddress.groupBy({
          by: ["status"],
          _count: { id: true },
        }),
        prisma.usdtMonitorRuntimeState.findUnique({
          where: { workerName: "usdt_trc20_monitor_v1" },
        }),
      ]);

      const counts = {
        pendingApproval: 0,
        available: 0,
        assigned: 0,
        retired: 0,
      };
      for (const row of grouped as any[]) {
        if (row.status === "pending_approval") counts.pendingApproval = row._count.id;
        if (row.status === "available") counts.available = row._count.id;
        if (row.status === "assigned") counts.assigned = row._count.id;
        if (row.status === "retired") counts.retired = row._count.id;
      }

      const lastSuccessMs = runtime?.lastSuccessAt ? new Date(runtime.lastSuccessAt).getTime() : 0;
      const ageMs = lastSuccessMs > 0 ? Date.now() - lastSuccessMs : Number.POSITIVE_INFINITY;
      let status: "normal" | "delayed" | "unavailable" = "unavailable";
      if (runtime?.consecutiveFailures && runtime.consecutiveFailures >= 3) {
        status = "unavailable";
      } else if (Number.isFinite(ageMs) && ageMs <= 90_000) {
        status = "normal";
      } else if (Number.isFinite(ageMs) && ageMs <= 2 * 60_000) {
        status = "delayed";
      } else if (runtime?.lastSuccessAt) {
        status = "unavailable";
      }

      return reply.send({
        ok: true,
        counts,
        availableLow: counts.available < 3,
        monitor: {
          workerName: runtime?.workerName ?? "usdt_trc20_monitor_v1",
          status,
          lastCycleAt: runtime?.lastCycleAt ? new Date(runtime.lastCycleAt).toISOString() : null,
          lastSuccessAt: runtime?.lastSuccessAt ? new Date(runtime.lastSuccessAt).toISOString() : null,
          lastBlockNumber: runtime?.lastBlockNumber != null ? runtime.lastBlockNumber.toString() : null,
          lastScannedAddressCount: runtime?.lastScannedAddressCount ?? 0,
          lastDiscoveredTxCount: runtime?.lastDiscoveredTxCount ?? 0,
          lastConfirmedCount: runtime?.lastConfirmedCount ?? 0,
          lastRejectedCount: runtime?.lastRejectedCount ?? 0,
          consecutiveFailures: runtime?.consecutiveFailures ?? 0,
          lastErrorClass: runtime?.lastErrorClass ?? null,
          lastProviderStatus: runtime?.lastProviderStatus ?? null,
        },
      });
    },
  );

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
          approvedAt: r.approvedAt ? new Date(r.approvedAt).toISOString() : null,
          activationReadyAt: r.activationReadyAt ? new Date(r.activationReadyAt).toISOString() : null,
          autoCreditFrozenAt: r.autoCreditFrozenAt ? new Date(r.autoCreditFrozenAt).toISOString() : null,
          autoCreditFreezeReason: r.autoCreditFreezeReason || null,
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
        await verifyAndFreezePaymentAddressIntegrity(tx, row, "reveal");
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
      if (network === "tron_trc20" && !TRON_BASE58_ADDRESS_RE.test(trimmed)) {
        return reply.status(400).send({ error: "bad_request", message: "仅支持 T 开头的 TRON Base58 收款地址，请勿填写私钥、助记词或其他链地址。" });
      }
      try {
        const row = await prisma.$transaction(async (tx: any) => {
          const created: any = await tx.paymentAddress.create({
            data: {
              network,
              address: trimmed,
              addressMasked: addressMasked(trimmed),
              status: "pending_approval",
              createdBy: admin.adminId,
            },
          });
          const integrityMac = computePaymentAddressIntegrityMac(created);
          const finalized: any = await tx.paymentAddress.update({
            where: { id: created.id },
            data: { integrityMac },
          });
          await tx.adminAuditLog.create({
            data: {
              adminId: admin.adminId,
              action: "payment_address.create_pending_approval",
              objectType: "payment_address",
              objectId: String(created.id),
              reason: "finance: 新增 USDT 收款地址，待 super_admin 复核",
              ipAddress: (req.ip as string) || null,
              userAgent: (req.headers["user-agent"] as string) || null,
              afterValue: { network, addressMasked: addressMasked(trimmed), status: "pending_approval" },
            },
          });
          return finalized;
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
    "/admin/payment-addresses/:id/approve",
    { preHandler: [requireAdmin("*")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      if (admin.role !== "super_admin") {
        return reply.status(403).send({ error: "forbidden", message: "仅 super_admin 可批准收款地址" });
      }
      const body = approveAddressSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });
      const id = req.params.id;
      const done = await prisma.$transaction(async (tx: any) => {
        const row: any = await tx.paymentAddress.findUnique({ where: { id } });
        if (!row) return { notFound: true };
        if (row.status === "available") return { idempotent: true, row };
        if (row.status !== "pending_approval") return { conflict: "bad_status", row };
        if (row.createdBy && row.createdBy === admin.adminId) return { conflict: "self_approval_forbidden" };
        const verify = await verifyAndFreezePaymentAddressIntegrity(tx, row, "assign");
        if (!verify.ok) return { conflict: "integrity_failed" };
        const activationReadyAt = new Date(Date.now() + 10 * 60 * 1000);
        const updated: any = await tx.paymentAddress.update({
          where: { id },
          data: {
            status: "available",
            approvedBy: admin.adminId,
            approvedAt: new Date(),
            activationReadyAt,
            lastIntegrityCheckAt: new Date(),
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: "payment_address.approve",
            objectType: "payment_address",
            objectId: String(id),
            reason: body.data.reason,
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
            beforeValue: { status: row.status, createdBy: row.createdBy || null },
            afterValue: { status: updated.status, activationReadyAt: activationReadyAt.toISOString() },
          },
        });
        return { ok: true, row: updated };
      });
      if ((done as any).notFound) return reply.status(404).send({ error: "not_found" });
      if ((done as any).conflict === "self_approval_forbidden") {
        return reply.status(409).send({ error: "self_approval_forbidden", message: "同一管理员不能申请并批准同一收款地址。" });
      }
      if ((done as any).conflict === "bad_status") {
        return reply.status(409).send({ error: "bad_status", message: "当前地址状态不允许批准。" });
      }
      if ((done as any).conflict === "integrity_failed") {
        return reply.status(409).send({ error: "payment_address_integrity_failed", message: "地址完整性校验失败，已冻结自动入账。" });
      }
      return reply.send({
        ok: true,
        idempotent: !!(done as any).idempotent,
        id,
        status: (done as any).row.status,
        activationReadyAt: (done as any).row.activationReadyAt ? new Date((done as any).row.activationReadyAt).toISOString() : null,
      });
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
          const verify = await verifyAndFreezePaymentAddressIntegrity(tx, row, "retire");
          if (!verify.ok) return { conflict: "integrity_failed" };
          if (row.status === "retired") return { idempotent: true, row };
          if (row.status === "pending_approval") {
            return { conflict: "pending_approval", detail: "address_still_pending_approval" };
          }
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
        if ((done as any).conflict === "integrity_failed") {
          return reply.status(409).send({ error: "payment_address_integrity_failed", message: "地址完整性校验失败，已冻结自动入账。" });
        }
        if ((done as any).conflict === "pending_approval") {
          return reply.status(409).send({ error: "pending_approval", message: "地址仍处于待批准状态，不能停用或投入使用。" });
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
            usdtPaymentAddress: true,
          },
        }),
      ]);

      return reply.send({
        items: rows.map((o: any) => orderResponse(o, { exposeInvoiceIfOwnedBy: uid, exposeUsdtPaymentIfOwnedBy: uid })),
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
