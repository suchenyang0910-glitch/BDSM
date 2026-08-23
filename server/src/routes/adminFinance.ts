import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";

const QUERY_SCHEMA = z.object({
  preset: z.enum(["today", "7d", "30d", "custom"]).optional().default("30d"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  paymentMethod: z.enum(["telegram_stars", "usdt_trc20", "manual"]).optional(),
  status: z.enum(["pending", "processing", "paid", "failed", "refunded", "cancelled", "expired"]).optional(),
  productType: z.enum(["single", "package", "membership"]).optional(),
}).strict();

const EXPORT_KIND_SCHEMA = z.enum(["overview", "orders", "reconciliation"]).default("overview");

function resolveDateRange(query: z.infer<typeof QUERY_SCHEMA>) {
  const now = new Date();
  if (query.preset === "today") {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    return { from, to: now };
  }
  if (query.preset === "7d") {
    return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), to: now };
  }
  if (query.preset === "custom" && query.from && query.to) {
    return { from: new Date(query.from), to: new Date(query.to) };
  }
  return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), to: now };
}

function normalizeMethod(input: string | null | undefined): "telegram_stars" | "usdt_trc20" | "manual" {
  if (input === "telegram_stars") return "telegram_stars";
  if (input === "usdt_trc20_external" || input === "usdt_trc20") return "usdt_trc20";
  return "manual";
}

function amountBucket() {
  return {
    telegram_stars: "0",
    usdt_trc20: "0",
    manual: "0",
  };
}

function addAmount(current: string, add: bigint): string {
  return (BigInt(current) + add).toString();
}

function diffMs(start: Date | null | undefined, end: Date | null | undefined): number | null {
  if (!start || !end) return null;
  const ms = end.getTime() - start.getTime();
  return ms >= 0 ? ms : null;
}

function averageMs(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

function dayKey(input: Date | null | undefined): string {
  if (!input) return "";
  return input.toISOString().slice(0, 10);
}

function csvEscape(value: unknown): string {
  const raw = value == null ? "" : String(value);
  if (!/[",\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
}

async function writeFinancialExportAudit(prisma: any, req: any, kind: string, filters: Record<string, unknown>) {
  const admin = (req as any).admin;
  if (!admin?.adminId) return;
  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.adminId,
      action: "admin.financial.export",
      objectType: "finance_export",
      objectId: kind,
      afterValue: filters,
      ipAddress: (req.ip as string) || null,
      userAgent: (req.headers["user-agent"] as string) || null,
    },
  }).catch(() => null);
}

export default async function adminFinanceRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  async function loadFinanceData(queryRaw: unknown) {
    const query = QUERY_SCHEMA.parse(queryRaw || {});
    const { from, to } = resolveDateRange(query);
    const where: any = {
      createdAt: { gte: from, lte: to },
    };
    if (query.status) where.status = query.status;
    if (query.paymentMethod) {
      where.paymentMethod = query.paymentMethod === "usdt_trc20" ? "usdt_trc20_external" : query.paymentMethod;
    }
    if (query.productType) {
      where.product = { type: query.productType };
    }

    const orders = await prisma.order.findMany({
      where,
      select: {
        id: true,
        orderNo: true,
        userId: true,
        amountMinor: true,
        currency: true,
        paymentMethod: true,
        status: true,
        createdAt: true,
        paidAt: true,
        refundedAt: true,
        product: { select: { type: true, title: true } },
        usdtPaymentAddress: { select: { addressMasked: true } },
        paymentTransactions: {
          select: {
            status: true,
            receivedAt: true,
            confirmedAt: true,
            rejectReason: true,
          },
        },
        entitlements: {
          select: {
            id: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const runtime = await prisma.usdtMonitorRuntimeState.findUnique({
      where: { workerName: "usdt_trc20_monitor_v1" },
    }).catch(() => null);

    return { query, from, to, orders, runtime };
  }

  fastify.get("/admin/finance/overview", { preHandler: [requireAdmin("finance.view")] }, async (req, reply) => {
    const { query, from, to, orders } = await loadFinanceData(req.query);

    const confirmedGmv = amountBucket();
    const refundedAmount = amountBucket();
    const netRevenue = amountBucket();
    const paidUsers = new Set<string>();
    let paidOrderCount = 0;
    let pendingOrderCount = 0;
    let expiredOrderCount = 0;
    let refundedOrderCount = 0;
    let pendingUsdtAmount = 0n;

    const usdtConfirmDurations: Array<number | null> = [];
    const starsSuccessDurations: Array<number | null> = [];

    for (const order of orders) {
      const method = normalizeMethod(order.paymentMethod);
      const amount = BigInt(order.amountMinor.toString());
      if (order.status === "paid") {
        confirmedGmv[method] = addAmount(confirmedGmv[method], amount);
        netRevenue[method] = addAmount(netRevenue[method], amount);
        paidOrderCount += 1;
        paidUsers.add(order.userId);
        if (method === "usdt_trc20") {
          const confirmedTx = order.paymentTransactions.find((tx: any) => tx.status === "confirmed");
          usdtConfirmDurations.push(diffMs(confirmedTx?.receivedAt, confirmedTx?.confirmedAt));
        }
        if (method === "telegram_stars") {
          starsSuccessDurations.push(diffMs(order.createdAt, order.paidAt));
        }
      }
      if (order.status === "refunded") {
        refundedAmount[method] = addAmount(refundedAmount[method], amount);
        netRevenue[method] = (BigInt(netRevenue[method]) - amount).toString();
        refundedOrderCount += 1;
      }
      if (order.status === "pending" || order.status === "processing") {
        pendingOrderCount += 1;
        if (method === "usdt_trc20") pendingUsdtAmount += amount;
      }
      if (order.status === "expired") expiredOrderCount += 1;
    }

    const totalOrders = orders.length;
    const paidOrderCountByMethod = { telegram_stars: 0, usdt_trc20: 0, manual: 0 };
    for (const order of orders) {
      if (order.status === "paid") paidOrderCountByMethod[normalizeMethod(order.paymentMethod)] += 1;
    }

    return reply.send({
      ok: true,
      filters: {
        preset: query.preset,
        from: from.toISOString(),
        to: to.toISOString(),
        paymentMethod: query.paymentMethod ?? null,
        status: query.status ?? null,
        productType: query.productType ?? null,
      },
      metrics: {
        confirmedGmv,
        refundedAmount,
        netRevenue,
        // XTR 与 USDT 是不同计价单位，严禁合并为“总金额”。
        paidOrderCount,
        paidUserCount: paidUsers.size,
        paidOrderCountByMethod,
        averageOrderValueByMethod: {
          telegram_stars: paidOrderCountByMethod.telegram_stars > 0 ? (BigInt(confirmedGmv.telegram_stars) / BigInt(paidOrderCountByMethod.telegram_stars)).toString() : "0",
          usdt_trc20: paidOrderCountByMethod.usdt_trc20 > 0 ? (BigInt(confirmedGmv.usdt_trc20) / BigInt(paidOrderCountByMethod.usdt_trc20)).toString() : "0",
          manual: paidOrderCountByMethod.manual > 0 ? (BigInt(confirmedGmv.manual) / BigInt(paidOrderCountByMethod.manual)).toString() : "0",
        },
        paymentSuccessRateBps: totalOrders > 0 ? Math.round((paidOrderCount / totalOrders) * 10000) : 0,
        pendingUsdtAmount: pendingUsdtAmount.toString(),
        pendingOrderCount,
        expiredOrderCount,
        refundedOrderCount,
        usdtAverageConfirmMs: averageMs(usdtConfirmDurations),
        starsAverageSuccessMs: averageMs(starsSuccessDurations),
      },
    });
  });

  fastify.get("/admin/finance/trends", { preHandler: [requireAdmin("finance.view")] }, async (req, reply) => {
    const { from, to, orders } = await loadFinanceData(req.query);
    const buckets = new Map<string, any>();

    for (const order of orders) {
      const key = dayKey(order.createdAt);
      if (!buckets.has(key)) {
        buckets.set(key, {
          date: key,
          orderCount: 0,
          confirmedAmount: amountBucket(),
          refundedAmount: amountBucket(),
          netRevenue: amountBucket(),
        });
      }
      const row = buckets.get(key);
      const method = normalizeMethod(order.paymentMethod);
      row.orderCount += 1;
      const amount = BigInt(order.amountMinor.toString());
      if (order.status === "paid") {
        row.confirmedAmount[method] = addAmount(row.confirmedAmount[method], amount);
        row.netRevenue[method] = addAmount(row.netRevenue[method], amount);
      }
      if (order.status === "refunded") {
        row.refundedAmount[method] = addAmount(row.refundedAmount[method], amount);
        row.netRevenue[method] = (BigInt(row.netRevenue[method]) - amount).toString();
      }
    }

    return reply.send({
      ok: true,
      from: from.toISOString(),
      to: to.toISOString(),
      rows: [...buckets.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    });
  });

  fastify.get("/admin/finance/address-pool", { preHandler: [requireAdmin("finance.view")] }, async (_req, reply) => {
    const runtime = await prisma.usdtMonitorRuntimeState.findUnique({
      where: { workerName: "usdt_trc20_monitor_v1" },
    }).catch(() => null);

    const rows = await prisma.paymentAddress.findMany({
      orderBy: [{ createdAt: "desc" }],
      include: {
        monitorCursor: true,
        assignedOrders: {
          select: {
            status: true,
            createdAt: true,
            paidAt: true,
            refundedAt: true,
          },
        },
      },
    });

    const now = Date.now();
    const alertLowAvailable = rows.filter((row: any) => row.status === "available" && !row.autoCreditFrozenAt).length < 3;
    const alertMonitorStale = !runtime?.lastSuccessAt || (now - new Date(runtime.lastSuccessAt).getTime()) > 24 * 60 * 60 * 1000;

    return reply.send({
      ok: true,
      globalAlerts: {
        lowAvailableAddresses: alertLowAvailable,
        monitorScanStale24h: alertMonitorStale,
        runtimeLastSuccessAt: runtime?.lastSuccessAt?.toISOString?.() ?? null,
        runtimeConsecutiveFailures: runtime?.consecutiveFailures ?? 0,
      },
      rows: rows.map((row: any) => {
        const assignedOrderCount = row.assignedOrders.length;
        const confirmedOrderCount = row.assignedOrders.filter((order: any) => order.status === "paid").length;
        const confirmingOrderCount = row.assignedOrders.filter((order: any) => order.status === "pending" || order.status === "processing").length;
        const expiredReleasedCount = row.assignedOrders.filter((order: any) => order.status === "expired").length;
        const refundedCount = row.assignedOrders.filter((order: any) => order.status === "refunded").length;
        const lastUsedAt = row.assignedOrders
          .map((order: any) => order.paidAt || order.createdAt)
          .filter(Boolean)
          .sort((a: Date, b: Date) => b.getTime() - a.getTime())[0];
        const abnormalFlags = [
          row.autoCreditFrozenAt ? "auto_credit_frozen" : null,
          (row.monitorCursor?.consecutiveFailures ?? 0) >= 3 ? "monitor_failures_high" : null,
          row.status === "retired" ? "retired" : null,
        ].filter(Boolean);
        return {
          id: row.id,
          addressMasked: row.addressMasked,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: lastUsedAt ? lastUsedAt.toISOString() : null,
          assignedOrderCount,
          confirmedOrderCount,
          confirmingOrderCount,
          expiredReleasedCount,
          refundedCount,
          lastMonitorSuccessAt: row.monitorCursor?.lastSuccessAt?.toISOString?.() ?? null,
          monitorConsecutiveFailures: row.monitorCursor?.consecutiveFailures ?? 0,
          abnormalFlags,
        };
      }),
    });
  });

  fastify.get("/admin/finance/reconciliation", { preHandler: [requireAdmin("finance.view")] }, async (req, reply) => {
    const { from, to, orders } = await loadFinanceData(req.query);
    const reasons = {
      paid_without_confirmed_tx: { count: 0, amount: "0" },
      confirmed_tx_without_paid_order: { count: 0, amount: "0" },
      paid_without_active_entitlement: { count: 0, amount: "0" },
      refunded_without_refunded_tx: { count: 0, amount: "0" },
    };

    let confirmedTxCount = 0;
    let confirmedTxAmount = 0n;
    let activeEntitlementCount = 0;

    for (const order of orders) {
      const amount = BigInt(order.amountMinor.toString());
      const confirmedTx = order.paymentTransactions.filter((tx: any) => tx.status === "confirmed");
      const refundedTx = order.paymentTransactions.filter((tx: any) => tx.status === "refunded");
      const activeEntitlements = order.entitlements.filter((row: any) => row.status === "active");
      confirmedTxCount += confirmedTx.length;
      if (confirmedTx.length > 0) confirmedTxAmount += amount;
      activeEntitlementCount += activeEntitlements.length;

      if (order.status === "paid" && confirmedTx.length === 0) {
        reasons.paid_without_confirmed_tx.count += 1;
        reasons.paid_without_confirmed_tx.amount = addAmount(reasons.paid_without_confirmed_tx.amount, amount);
      }
      if (order.status !== "paid" && confirmedTx.length > 0) {
        reasons.confirmed_tx_without_paid_order.count += 1;
        reasons.confirmed_tx_without_paid_order.amount = addAmount(reasons.confirmed_tx_without_paid_order.amount, amount);
      }
      if (order.status === "paid" && activeEntitlements.length === 0) {
        reasons.paid_without_active_entitlement.count += 1;
        reasons.paid_without_active_entitlement.amount = addAmount(reasons.paid_without_active_entitlement.amount, amount);
      }
      if (order.status === "refunded" && refundedTx.length === 0) {
        reasons.refunded_without_refunded_tx.count += 1;
        reasons.refunded_without_refunded_tx.amount = addAmount(reasons.refunded_without_refunded_tx.amount, amount);
      }
    }

    return reply.send({
      ok: true,
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        orderCount: orders.length,
        paidOrderCount: orders.filter((order: any) => order.status === "paid").length,
        confirmedTransactionCount: confirmedTxCount,
        confirmedTransactionAmount: confirmedTxAmount.toString(),
        activeEntitlementCount,
      },
      differences: reasons,
      rows: orders.slice(-200).map((order: any) => {
        const method = normalizeMethod(order.paymentMethod);
        const confirmedTx = order.paymentTransactions.find((tx: any) => tx.status === "confirmed");
        const confirmedMs = method === "usdt_trc20"
          ? diffMs(confirmedTx?.receivedAt, confirmedTx?.confirmedAt)
          : diffMs(order.createdAt, order.paidAt);
        const reasonCodes = [
          order.status === "paid" && !confirmedTx ? "paid_without_confirmed_tx" : null,
          order.status === "paid" && order.entitlements.filter((row: any) => row.status === "active").length === 0 ? "paid_without_active_entitlement" : null,
          order.status === "refunded" && order.paymentTransactions.every((tx: any) => tx.status !== "refunded") ? "refunded_without_refunded_tx" : null,
        ].filter(Boolean);
        return {
          orderNoMasked: order.orderNo.slice(0, 4) + "..." + order.orderNo.slice(-4),
          paymentMethod: method,
          orderStatus: order.status,
          orderAmountMinor: order.amountMinor.toString(),
          currency: order.currency,
          confirmedAt: order.paidAt?.toISOString?.() ?? null,
          confirmDurationMs: confirmedMs,
          addressMasked: order.usdtPaymentAddress?.addressMasked ?? null,
          reasonCodes,
        };
      }),
    });
  });

  fastify.get("/admin/finance/export", { preHandler: [requireAdmin("finance.view")] }, async (req, reply) => {
    const kindParsed = EXPORT_KIND_SCHEMA.safeParse((req.query as any)?.kind || "overview");
    if (!kindParsed.success) return reply.status(400).send({ error: "bad_request", message: "无效导出类型" });
    const kind = kindParsed.data;
    const { query, from, to, orders } = await loadFinanceData(req.query);
    await writeFinancialExportAudit(prisma, req, kind, {
      from: from.toISOString(),
      to: to.toISOString(),
      paymentMethod: query.paymentMethod ?? null,
      status: query.status ?? null,
      productType: query.productType ?? null,
    });

    const header = ["order_no_masked", "payment_method", "status", "amount_minor", "currency", "created_at", "paid_at"];
    const lines = [
      header.join(","),
      ...orders.map((order: any) => [
        csvEscape(order.orderNo.slice(0, 4) + "..." + order.orderNo.slice(-4)),
        csvEscape(normalizeMethod(order.paymentMethod)),
        csvEscape(order.status),
        csvEscape(order.amountMinor.toString()),
        csvEscape(order.currency),
        csvEscape(order.createdAt.toISOString()),
        csvEscape(order.paidAt?.toISOString?.() ?? ""),
      ].join(",")),
    ];

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename=\"finance-${kind}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv\"`);
    return reply.send(lines.join("\n"));
  });
}
