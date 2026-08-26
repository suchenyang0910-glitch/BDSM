import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";

const CAMPAIGN_STATUS_VALUES = ["draft", "scheduled", "active", "paused", "archived"] as const;
const CAMPAIGN_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const ZCAMPAIGN_LIST_QP = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(CAMPAIGN_STATUS_VALUES).optional(),
});

const ZCAMPAIGN_MUTATION = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(2).max(64).regex(CAMPAIGN_CODE_RE, "活动代码仅允许小写字母、数字、下划线、短横线"),
  status: z.enum(CAMPAIGN_STATUS_VALUES).default("draft"),
  summary: z.string().trim().max(500).optional().nullable(),
  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  bannerIds: z.array(z.string().trim().min(1).max(64)).max(12).default([]),
  trafficEntryIds: z.array(z.string().uuid()).max(24).default([]),
  reason: z.string().trim().max(500).optional(),
});

type CampaignRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  summary: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  bannerIds: string[];
  trafficEntryIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

async function writeCampaignAudit(prisma: any, req: any, action: string, objectId: string, beforeValue: unknown, afterValue: unknown, reason?: string | null) {
  const admin = (req as any).admin;
  if (!admin?.adminId) return;
  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.adminId,
      action,
      objectType: "operation_campaign",
      objectId,
      beforeValue: beforeValue == null ? undefined : beforeValue,
      afterValue: afterValue == null ? undefined : afterValue,
      reason: reason ?? null,
      ipAddress: (req.ip as string) || null,
      userAgent: (req.headers["user-agent"] as string) || null,
    },
  });
}

function normalizeCode(code: string) {
  return code.trim().toLowerCase();
}

function toIsoOrNull(input: Date | null) {
  return input ? input.toISOString() : null;
}

async function validateCampaignRefs(prisma: any, bannerIds: string[], trafficEntryIds: string[]) {
  const [bannerCount, trafficEntryCount] = await Promise.all([
    bannerIds.length ? prisma.banner.count({ where: { id: { in: bannerIds } } }) : Promise.resolve(0),
    trafficEntryIds.length ? prisma.trafficEntry.count({ where: { id: { in: trafficEntryIds } } }) : Promise.resolve(0),
  ]);
  if (bannerCount !== bannerIds.length) {
    return { ok: false as const, error: "invalid_banner_refs", message: "活动绑定了不存在的 Banner。" };
  }
  if (trafficEntryCount !== trafficEntryIds.length) {
    return { ok: false as const, error: "invalid_traffic_entry_refs", message: "活动绑定了不存在的流量入口。" };
  }
  return { ok: true as const };
}

async function loadCampaignReferenceMaps(prisma: any, rows: CampaignRow[]) {
  const bannerIds = [...new Set(rows.flatMap((row) => row.bannerIds || []))];
  const trafficEntryIds = [...new Set(rows.flatMap((row) => row.trafficEntryIds || []))];
  const [banners, entries] = await Promise.all([
    bannerIds.length ? prisma.banner.findMany({ where: { id: { in: bannerIds } }, select: { id: true, title: true, status: true } }) : Promise.resolve([]),
    trafficEntryIds.length ? prisma.trafficEntry.findMany({ where: { id: { in: trafficEntryIds } }, select: { id: true, code: true, name: true, status: true } }) : Promise.resolve([]),
  ]);
  return {
    bannerMap: new Map<string, { id: string; title: string; status: string }>(banners.map((row: any) => [row.id, row])),
    entryMap: new Map<string, { id: string; code: string; name: string; status: string }>(entries.map((row: any) => [row.id, row])),
  };
}

async function loadTrafficEntryMetricsMap(prisma: any, entryIds: string[]) {
  const rows = entryIds.length
    ? await prisma.trafficEntry.findMany({
        where: { id: { in: entryIds } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, code: true },
      })
    : [];
  const codeMap = new Map<string, string>(rows.map((row: any) => [row.id, row.code]));
  const codeList = [...new Set(rows.map((row: any) => row.code))];
  if (!codeList.length) return new Map<string, any>();

  const queryRaw = prisma.$queryRaw.bind(prisma) as (query: Prisma.Sql) => Promise<Array<{
    code: string;
    opens: number;
    contentOpened: number;
    checkoutOpen: number;
    paymentConfirmed: number;
    playbackStarted: number;
  }>>;
  const metricsRows = await queryRaw(Prisma.sql`
    SELECT
      "properties_json"->>'trafficEntryCode' AS "code",
      COUNT(DISTINCT CASE WHEN "event_name" = 'traffic_entry_open' THEN "session_id_hmac" END)::int AS "opens",
      COUNT(DISTINCT CASE WHEN "event_name" = 'content_opened' THEN "session_id_hmac" END)::int AS "contentOpened",
      COUNT(DISTINCT CASE WHEN "event_name" = 'checkout_open' THEN "session_id_hmac" END)::int AS "checkoutOpen",
      COUNT(DISTINCT CASE WHEN "event_name" = 'payment_confirmed' THEN "session_id_hmac" END)::int AS "paymentConfirmed",
      COUNT(DISTINCT CASE WHEN "event_name" = 'playback_started' THEN "session_id_hmac" END)::int AS "playbackStarted"
    FROM "analytics_events"
    WHERE COALESCE("properties_json"->>'trafficEntryCode', '') IN (${Prisma.join(codeList.map((code) => Prisma.sql`${code}`))})
    GROUP BY 1
  `);
  const byCode = new Map<string, any>(metricsRows.map((row) => [row.code, row]));
  const byEntryId = new Map<string, any>();
  for (const [entryId, code] of codeMap) {
    byEntryId.set(entryId, byCode.get(code) || {
      opens: 0,
      contentOpened: 0,
      checkoutOpen: 0,
      paymentConfirmed: 0,
      playbackStarted: 0,
    });
  }
  return byEntryId;
}

export default async function campaignRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.get("/admin/campaigns", { preHandler: [requireAdmin("campaign:view")] }, async (req, reply) => {
    const parsed = ZCAMPAIGN_LIST_QP.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: "bad_request", message: "查询条件不合法。" });
    const where: any = {};
    if (parsed.data.status) where.status = parsed.data.status;
    if (parsed.data.q) {
      where.OR = [
        { name: { contains: parsed.data.q, mode: "insensitive" } },
        { code: { contains: parsed.data.q, mode: "insensitive" } },
        { summary: { contains: parsed.data.q, mode: "insensitive" } },
      ];
    }
    const rows = await prisma.operationCampaign.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }) as CampaignRow[];
    const { bannerMap, entryMap } = await loadCampaignReferenceMaps(prisma, rows);
    const metricsMap = await loadTrafficEntryMetricsMap(prisma, [...new Set(rows.flatMap((row) => row.trafficEntryIds || []))]);

    const items = rows.map((row) => {
      const trafficEntries = (row.trafficEntryIds || []).map((id) => entryMap.get(id)).filter(Boolean);
      const banners = (row.bannerIds || []).map((id) => bannerMap.get(id)).filter(Boolean);
      const totals = (row.trafficEntryIds || []).reduce((acc, id) => {
        const metric = metricsMap.get(id) || {};
        acc.opens += metric.opens || 0;
        acc.contentOpened += metric.contentOpened || 0;
        acc.checkoutOpen += metric.checkoutOpen || 0;
        acc.paymentConfirmed += metric.paymentConfirmed || 0;
        acc.playbackStarted += metric.playbackStarted || 0;
        return acc;
      }, { opens: 0, contentOpened: 0, checkoutOpen: 0, paymentConfirmed: 0, playbackStarted: 0 });
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        summary: row.summary,
        startsAt: toIsoOrNull(row.startsAt),
        endsAt: toIsoOrNull(row.endsAt),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        banners,
        trafficEntries,
        metrics: totals,
      };
    });

    return reply.send({
      items,
      summary: {
        total: items.length,
        active: items.filter((item) => item.status === "active").length,
        scheduled: items.filter((item) => item.status === "scheduled").length,
        paymentsConfirmed: items.reduce((sum, item) => sum + item.metrics.paymentConfirmed, 0),
      },
    });
  });

  fastify.post("/admin/campaigns", { preHandler: [requireAdmin("campaign:edit")] }, async (req: any, reply) => {
    const parsed = ZCAMPAIGN_MUTATION.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "bad_request", message: "活动配置不合法。" });
    const body = parsed.data;
    if (body.startsAt && body.endsAt && new Date(body.startsAt) > new Date(body.endsAt)) {
      return reply.status(400).send({ error: "bad_request", message: "活动开始时间不能晚于结束时间。" });
    }
    const code = normalizeCode(body.code);
    const duplicated = await prisma.operationCampaign.findUnique({ where: { code } });
    if (duplicated) return reply.status(409).send({ error: "campaign_code_exists", message: "活动代码已存在。" });
    const refs = await validateCampaignRefs(prisma, body.bannerIds, body.trafficEntryIds);
    if (!refs.ok) return reply.status(409).send(refs);
    const admin = (req as any).admin;
    const created = await prisma.operationCampaign.create({
      data: {
        code,
        name: body.name,
        status: body.status,
        summary: body.summary || null,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        bannerIds: body.bannerIds,
        trafficEntryIds: body.trafficEntryIds,
        createdBy: admin.adminId,
        updatedBy: admin.adminId,
      },
    }) as CampaignRow;
    await writeCampaignAudit(prisma, req, "campaign.create", created.id, null, {
      code: created.code,
      name: created.name,
      status: created.status,
      bannerIds: created.bannerIds,
      trafficEntryIds: created.trafficEntryIds,
    }, body.reason || `创建活动：${created.name}`);
    return reply.send({ ok: true, id: created.id });
  });

  fastify.patch("/admin/campaigns/:id", { preHandler: [requireAdmin("campaign:edit")] }, async (req: any, reply) => {
    const id = String(req.params?.id || "").trim();
    if (!id) return reply.status(400).send({ error: "bad_request", message: "活动 ID 不合法。" });
    const parsed = ZCAMPAIGN_MUTATION.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "bad_request", message: "活动配置不合法。" });
    const body = parsed.data;
    if (body.startsAt && body.endsAt && new Date(body.startsAt) > new Date(body.endsAt)) {
      return reply.status(400).send({ error: "bad_request", message: "活动开始时间不能晚于结束时间。" });
    }
    const before = await prisma.operationCampaign.findUnique({ where: { id } }) as CampaignRow | null;
    if (!before) return reply.status(404).send({ error: "not_found", message: "活动不存在。" });
    const code = normalizeCode(body.code);
    const duplicated = await prisma.operationCampaign.findFirst({ where: { code, NOT: { id } }, select: { id: true } });
    if (duplicated) return reply.status(409).send({ error: "campaign_code_exists", message: "活动代码已存在。" });
    const refs = await validateCampaignRefs(prisma, body.bannerIds, body.trafficEntryIds);
    if (!refs.ok) return reply.status(409).send(refs);
    const admin = (req as any).admin;
    const after = await prisma.operationCampaign.update({
      where: { id },
      data: {
        code,
        name: body.name,
        status: body.status,
        summary: body.summary || null,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        bannerIds: body.bannerIds,
        trafficEntryIds: body.trafficEntryIds,
        updatedBy: admin.adminId,
      },
    }) as CampaignRow;
    await writeCampaignAudit(prisma, req, "campaign.update", after.id, {
      code: before.code,
      name: before.name,
      status: before.status,
      bannerIds: before.bannerIds,
      trafficEntryIds: before.trafficEntryIds,
    }, {
      code: after.code,
      name: after.name,
      status: after.status,
      bannerIds: after.bannerIds,
      trafficEntryIds: after.trafficEntryIds,
    }, body.reason || `更新活动：${after.name}`);
    return reply.send({ ok: true, id: after.id });
  });
}
