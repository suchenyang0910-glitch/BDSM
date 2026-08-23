import type { FastifyInstance } from "fastify";
import { requireAdmin } from "./admin.js";
import type { PrismaClient } from "@prisma/client";

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function addDays(d: Date, days: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function minorToDisplayStr(v: bigint | number | null, currency: string = "XTR"): string {
  if (v == null) return "0";
  const n = typeof v === "bigint" ? v : BigInt(v);
  const divisor = currency === "USDT" ? BigInt(1_000_000) : BigInt(1_000_000_000);
  const whole = n / divisor;
  const frac = n % divisor;
  const fracStr = frac.toString().padStart(currency === "USDT" ? 6 : 9, "0").replace(/0+$/, "");
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

export default async function adminDashboardRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma as PrismaClient;

  fastify.get(
    "/admin/dashboard/summary",
    { preHandler: [requireAdmin("dashboard:view") as any] },
    async (_req: any, reply: any) => {
      const now = new Date();
      const mStart = startOfMonth(now);
      const mEnd = endOfMonth(now);

      const paidOrders = await prisma.order.findMany({
        where: { status: "paid", paidAt: { gte: mStart, lte: mEnd } },
        select: {
          id: true, userId: true, paymentMethod: true, amountMinor: true, currency: true,
          refundedAt: true,
          product: { select: { id: true, type: true } },
        },
      });

      const totalPaidOrders = paidOrders.length;
      const paidUserIds = new Set(paidOrders.map((o) => o.userId));
      const payingUserCount = paidUserIds.size;

      type GmvByMethod = Record<string, { amountMinor: bigint; count: number; currency: string }>;
      const gmvByMethod: GmvByMethod = {};
      let packagePaidCount = 0;
      let refundedPaidCount = 0;
      for (const o of paidOrders) {
        const key = o.paymentMethod as string;
        if (!gmvByMethod[key]) gmvByMethod[key] = { amountMinor: BigInt(0), count: 0, currency: o.currency };
        gmvByMethod[key].amountMinor += o.amountMinor;
        gmvByMethod[key].count += 1;
        if (o.product?.type === "package") packagePaidCount += 1;
        if (o.refundedAt != null) refundedPaidCount += 1;
      }
      const gmvByMethodDisplay = Object.fromEntries(
        Object.entries(gmvByMethod).map(([k, v]) => [
          k,
          {
            amountDisplay: minorToDisplayStr(v.amountMinor, v.currency === "USDT" ? "USDT" : "XTR"),
            amountMinor: v.amountMinor.toString(),
            count: v.count,
            currency: v.currency,
          },
        ]),
      );

      const thisMonthMembershipStart = addDays(mStart, -7);
      const thisMonthMembershipEnd = addDays(mEnd, 7);
      const expiringMemberships = await prisma.entitlement.findMany({
        where: {
          resourceType: "membership_channel",
          expiresAt: { gte: mStart, lte: mEnd },
        },
        select: { userId: true, expiresAt: true, id: true, status: true },
      });
      const expiringUserIds = [...new Set(expiringMemberships.map((e) => e.userId))];
      let renewedCount = 0;
      if (expiringUserIds.length > 0) {
        const renewedRows = await prisma.entitlement.findMany({
          where: {
            resourceType: "membership_channel",
            userId: { in: expiringUserIds },
            OR: [
              { startsAt: { gte: thisMonthMembershipStart, lte: thisMonthMembershipEnd } },
              { createdAt: { gte: thisMonthMembershipStart, lte: thisMonthMembershipEnd } },
            ],
          },
          select: { userId: true },
        });
        renewedCount = new Set(renewedRows.map((r) => r.userId)).size;
      }
      const membershipRenewalRate =
        expiringUserIds.length > 0 ? Number(((renewedCount / expiringUserIds.length) * 100).toFixed(1)) : 0;

      const inviteDeliveriesThisMonth = await prisma.telegramInvite.count({
        where: { createdAt: { gte: mStart, lte: mEnd } },
      });
      const deliverySuccessRate =
        totalPaidOrders > 0
          ? Number(Math.min(100, (inviteDeliveriesThisMonth / totalPaidOrders) * 100).toFixed(1))
          : 0;

      const activeTicketsThisMonth = await prisma.supportTicket.count({
        where: {
          createdAt: { gte: mStart, lte: mEnd },
          status: { notIn: ["closed", "resolved"] as any },
        },
      });
      const refundAndTicketRatio =
        totalPaidOrders > 0
          ? Number((((refundedPaidCount + activeTicketsThisMonth) / totalPaidOrders) * 100).toFixed(2))
          : 0;

      const packagePurchaseRate =
        totalPaidOrders > 0 ? Number(((packagePaidCount / totalPaidOrders) * 100).toFixed(1)) : 0;

      return reply.send({
        period: {
          startsAt: mStart.toISOString(),
          endsAt: mEnd.toISOString(),
          asOf: now.toISOString(),
          label: `${now.getFullYear()}年${now.getMonth() + 1}月`,
        },
        cards: {
          payingUsers: {
            value: payingUserCount,
            unit: "人",
            description: "当月至少 1 笔有效支付订单的去重用户数",
          },
          monthlyGmv: {
            byMethod: gmvByMethodDisplay,
            totalPaidOrders,
            description: "当月状态为 paid 的订单实付总额；按支付方式拆分",
          },
          membershipRenewal: {
            expiringMembershipUsers: expiringUserIds.length,
            renewedWithin7dUsers: renewedCount,
            ratePercent: membershipRenewalRate,
            description: "本月到期会员中，到期前后 7 天内续费会员数 / 本月到期会员数",
          },
          packagePurchase: {
            packagePaidOrders: packagePaidCount,
            allPaidOrders: totalPaidOrders,
            ratePercent: packagePurchaseRate,
            description: "内容包付费订单 / 所有付费订单",
          },
          inviteDelivery: {
            inviteCreated: inviteDeliveriesThisMonth,
            paidOrders: totalPaidOrders,
            successRatePercent: deliverySuccessRate,
            description: "当月成功创建 Telegram 邀请记录数 / 当月成功支付订单数（近似）",
          },
          supportAndRefund: {
            refundedPaidOrders: refundedPaidCount,
            openTickets: activeTicketsThisMonth,
            ratioPercent: refundAndTicketRatio,
            description: "(当月退款订单数 + 当月未关闭/未解决的有效工单数) / 当月付费订单数",
          },
        },
        stage2Readiness: {
          stablePaidMembershipThreshold: 100,
          monthlyGmvUsdtThreshold: 1500,
          note: "阶段二独立 VOD 立项：付费会员 ≥100 或 月 GMV ≥1500 USDT 等 4 项满足任意 2 项进入技术预研；当前仅展示数据，不自动触发。",
        },
      });
    },
  );
}
