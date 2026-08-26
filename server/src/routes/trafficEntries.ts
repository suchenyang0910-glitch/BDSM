import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { resolvePublicWebOrigin } from "./publicSeo.js";

const TRAFFIC_ENTRY_TYPE_VALUES = ["telegram_channel", "telegram_bot", "web", "facebook", "x", "partner"] as const;
const DESTINATION_TYPE_VALUES = ["content", "category", "package", "membership"] as const;
const TRAFFIC_ENTRY_STATUS_VALUES = ["active", "inactive"] as const;
const PRESET_VALUES = ["7d", "30d"] as const;
const TRAFFIC_ENTRY_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const ZTRAFFIC_ENTRY_LIST_QP = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(TRAFFIC_ENTRY_STATUS_VALUES).optional(),
  entryType: z.enum(TRAFFIC_ENTRY_TYPE_VALUES).optional(),
  preset: z.enum(PRESET_VALUES).default("7d"),
});

const ZTRAFFIC_ENTRY_CREATE = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(2).max(64).regex(TRAFFIC_ENTRY_CODE_RE, "渠道代码仅允许小写字母、数字、下划线、短横线"),
  entryType: z.enum(TRAFFIC_ENTRY_TYPE_VALUES),
  destinationType: z.enum(DESTINATION_TYPE_VALUES),
  destinationId: z.string().trim().max(64).optional().nullable(),
  status: z.enum(TRAFFIC_ENTRY_STATUS_VALUES).default("active"),
  note: z.string().trim().max(500).optional().nullable(),
  reason: z.string().trim().max(500).optional(),
});

const ZTRAFFIC_ENTRY_UPDATE = ZTRAFFIC_ENTRY_CREATE;

const ZTRAFFIC_ENTRY_RESOLVE_QP = z.object({
  code: z.string().trim().min(2).max(64),
});

type TrafficEntryRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  entryType: string;
  destinationType: string;
  destinationId: string;
  note: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type TrafficEntryMetricsRow = {
  code: string;
  opens: number;
  contentOpened: number;
  previewStarted: number;
  checkoutOpen: number;
  paymentConfirmed: number;
  playbackStarted: number;
};

function analyticsRange(preset: "7d" | "30d") {
  const to = new Date();
  return { from: new Date(to.getTime() - (preset === "30d" ? 30 : 7) * 24 * 60 * 60 * 1000), to };
}

function resolveTrafficEntryOrigins() {
  return {
    h5: resolvePublicWebOrigin(process.env.PUBLIC_WEB_ORIGIN),
    // The Telegram Mini App stays on its BotFather-configured origin. Never
    // derive either public URL from an admin request Host header.
    miniApp: resolvePublicWebOrigin(process.env.TELEGRAM_MINI_APP_ORIGIN || "https://bdsm.linkx.club"),
  };
}

function normalizeTrafficEntryCode(input: string) {
  return input.trim().toLowerCase();
}

function normalizeTrafficDestinationId(destinationType: string, destinationId: string | null | undefined) {
  if (destinationType === "membership") return "membership";
  return String(destinationId || "").trim();
}

async function validateTrafficEntryDestination(prisma: any, destinationType: string, destinationId: string) {
  if (destinationType === "membership") {
    return { ok: true as const, destinationLabel: "会员页" };
  }
  if (!destinationId) {
    return { ok: false as const, error: "destination_required", message: "请选择落地目标。" };
  }
  if (destinationType === "content") {
    const row = await prisma.content.findUnique({ where: { id: destinationId }, select: { id: true, title: true } });
    if (!row) return { ok: false as const, error: "content_not_found", message: "目标内容不存在。" };
    return { ok: true as const, destinationLabel: row.title };
  }
  if (destinationType === "category") {
    const row = await prisma.category.findUnique({ where: { id: destinationId }, select: { id: true, name: true } });
    if (!row) return { ok: false as const, error: "category_not_found", message: "目标分类不存在。" };
    return { ok: true as const, destinationLabel: row.name };
  }
  if (destinationType === "package") {
    const row = await prisma.contentPackage.findUnique({ where: { id: destinationId }, select: { id: true, title: true } });
    if (!row) return { ok: false as const, error: "package_not_found", message: "目标内容包不存在。" };
    return { ok: true as const, destinationLabel: row.title };
  }
  return { ok: false as const, error: "bad_request", message: "不支持的落地目标。" };
}

function buildTrafficEntryLinks(origins: { h5: string; miniApp: string }, row: Pick<TrafficEntryRow, "code" | "destinationType" | "destinationId">) {
  const build = (baseUrl: string) => {
    const url = new URL("/", baseUrl);
    url.searchParams.set("te", row.code);
    if (row.destinationType === "content") url.searchParams.set("content", row.destinationId);
    else if (row.destinationType === "category") url.searchParams.set("category", row.destinationId);
    else if (row.destinationType === "package") url.searchParams.set("package", row.destinationId);
    else url.searchParams.set("membership", "1");
    return url.toString();
  };
  return {
    h5: build(origins.h5),
    miniApp: build(origins.miniApp),
  };
}

async function loadTrafficEntryDestinationLabels(prisma: any, rows: TrafficEntryRow[]) {
  const contentIds = rows.filter((row) => row.destinationType === "content").map((row) => row.destinationId);
  const categoryIds = rows.filter((row) => row.destinationType === "category").map((row) => row.destinationId);
  const packageIds = rows.filter((row) => row.destinationType === "package").map((row) => row.destinationId);
  const [contents, categories, packages] = await Promise.all([
    contentIds.length
      ? prisma.content.findMany({ where: { id: { in: contentIds } }, select: { id: true, title: true } })
      : Promise.resolve([]),
    categoryIds.length
      ? prisma.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    packageIds.length
      ? prisma.contentPackage.findMany({ where: { id: { in: packageIds } }, select: { id: true, title: true } })
      : Promise.resolve([]),
  ]);
  const labels = new Map<string, string>();
  for (const row of contents) labels.set(`content:${row.id}`, row.title);
  for (const row of categories) labels.set(`category:${row.id}`, row.name);
  for (const row of packages) labels.set(`package:${row.id}`, row.title);
  labels.set("membership:membership", "会员页");
  return labels;
}

async function loadTrafficEntryMetrics(prisma: any, codes: string[], from: Date, to: Date) {
  if (!codes.length) return new Map<string, TrafficEntryMetricsRow>();
  const codeSql = Prisma.join(codes.map((code) => Prisma.sql`${code}`));
  const queryRaw = prisma.$queryRaw.bind(prisma) as (query: Prisma.Sql) => Promise<TrafficEntryMetricsRow[]>;
  const rows = await queryRaw(Prisma.sql`
    SELECT
      "properties_json"->>'trafficEntryCode' AS "code",
      COUNT(DISTINCT CASE WHEN "event_name" = 'traffic_entry_open' THEN "session_id_hmac" END)::int AS "opens",
      COUNT(DISTINCT CASE WHEN "event_name" = 'content_opened' THEN "session_id_hmac" END)::int AS "contentOpened",
      COUNT(DISTINCT CASE WHEN "event_name" = 'preview_started' THEN "session_id_hmac" END)::int AS "previewStarted",
      COUNT(DISTINCT CASE WHEN "event_name" = 'checkout_open' THEN "session_id_hmac" END)::int AS "checkoutOpen",
      COUNT(DISTINCT CASE WHEN "event_name" = 'payment_confirmed' THEN "session_id_hmac" END)::int AS "paymentConfirmed",
      COUNT(DISTINCT CASE WHEN "event_name" = 'playback_started' THEN "session_id_hmac" END)::int AS "playbackStarted"
    FROM "analytics_events"
    WHERE "occurred_at" >= ${from}
      AND "occurred_at" <= ${to}
      AND COALESCE("properties_json"->>'trafficEntryCode', '') IN (${codeSql})
    GROUP BY 1
  `);
  return new Map<string, TrafficEntryMetricsRow>(rows.map((row: TrafficEntryMetricsRow) => [row.code, row]));
}

async function writeTrafficEntryAudit(prisma: any, req: any, action: string, objectId: string, beforeValue: unknown, afterValue: unknown, reason?: string | null) {
  const admin = (req as any).admin;
  if (!admin?.adminId) return;
  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.adminId,
      action,
      objectType: "traffic_entry",
      objectId,
      beforeValue: beforeValue == null ? undefined : beforeValue,
      afterValue: afterValue == null ? undefined : afterValue,
      reason: reason ?? null,
      ipAddress: (req.ip as string) || null,
      userAgent: (req.headers["user-agent"] as string) || null,
    },
  });
}

export default async function trafficEntryRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.get("/traffic-entries/resolve", async (req, reply) => {
    const parsed = ZTRAFFIC_ENTRY_RESOLVE_QP.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: "bad_request", message: "渠道代码不合法。" });
    const code = normalizeTrafficEntryCode(parsed.data.code);
    const row = await prisma.trafficEntry.findUnique({ where: { code } }) as TrafficEntryRow | null;
    if (!row || row.status !== "active") {
      return reply.status(404).send({ error: "traffic_entry_not_found", message: "渠道入口不存在或已停用。" });
    }
    const links = buildTrafficEntryLinks(resolveTrafficEntryOrigins(), row);
    return reply.send({
      ok: true,
      entry: {
        id: row.id,
        code: row.code,
        name: row.name,
        entryType: row.entryType,
        destinationType: row.destinationType,
        destinationId: row.destinationId,
      },
      links,
    });
  });

  fastify.get("/admin/traffic-entries", { preHandler: [requireAdmin("traffic_entry:view")] }, async (req, reply) => {
    const parsed = ZTRAFFIC_ENTRY_LIST_QP.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: "bad_request", message: "查询参数不合法。" });
    const { from, to } = analyticsRange(parsed.data.preset);
    const where: any = {};
    if (parsed.data.status) where.status = parsed.data.status;
    if (parsed.data.entryType) where.entryType = parsed.data.entryType;
    if (parsed.data.q) {
      where.OR = [
        { name: { contains: parsed.data.q, mode: "insensitive" } },
        { code: { contains: parsed.data.q, mode: "insensitive" } },
        { note: { contains: parsed.data.q, mode: "insensitive" } },
      ];
    }
    const rows = await prisma.trafficEntry.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }) as TrafficEntryRow[];
    const [labels, metrics] = await Promise.all([
      loadTrafficEntryDestinationLabels(prisma, rows),
      loadTrafficEntryMetrics(prisma, rows.map((row) => row.code), from, to),
    ]);
    const origins = resolveTrafficEntryOrigins();
    const items = rows.map((row) => {
      const metric = metrics.get(row.code) || {
        code: row.code,
        opens: 0,
        contentOpened: 0,
        previewStarted: 0,
        checkoutOpen: 0,
        paymentConfirmed: 0,
        playbackStarted: 0,
      };
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        entryType: row.entryType,
        destinationType: row.destinationType,
        destinationId: row.destinationId,
        destinationLabel: labels.get(`${row.destinationType}:${row.destinationId}`) || row.destinationId,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        links: buildTrafficEntryLinks(origins, row),
        metrics: {
          opens: metric.opens,
          contentOpened: metric.contentOpened,
          previewStarted: metric.previewStarted,
          checkoutOpen: metric.checkoutOpen,
          paymentConfirmed: metric.paymentConfirmed,
          playbackStarted: metric.playbackStarted,
        },
      };
    });
    return reply.send({
      period: { preset: parsed.data.preset, from: from.toISOString(), to: to.toISOString() },
      summary: {
        total: items.length,
        active: items.filter((item) => item.status === "active").length,
        opens: items.reduce((sum, item) => sum + item.metrics.opens, 0),
        paymentsConfirmed: items.reduce((sum, item) => sum + item.metrics.paymentConfirmed, 0),
      },
      items,
      privacy: "仅展示按渠道代码聚合后的匿名转化，不展示用户身份或原始会话轨迹。",
    });
  });

  fastify.post("/admin/traffic-entries", { preHandler: [requireAdmin("traffic_entry:edit")] }, async (req: any, reply) => {
    const parsed = ZTRAFFIC_ENTRY_CREATE.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "bad_request", message: "渠道配置不合法。" });
    const admin = (req as any).admin;
    const code = normalizeTrafficEntryCode(parsed.data.code);
    const destinationId = normalizeTrafficDestinationId(parsed.data.destinationType, parsed.data.destinationId);
    const destinationCheck = await validateTrafficEntryDestination(prisma, parsed.data.destinationType, destinationId);
    if (!destinationCheck.ok) return reply.status(409).send(destinationCheck);
    const existing = await prisma.trafficEntry.findUnique({ where: { code } });
    if (existing) {
      return reply.status(409).send({ error: "traffic_entry_code_exists", message: "渠道代码已存在，请更换后重试。" });
    }
    const created = await prisma.trafficEntry.create({
      data: {
        code,
        name: parsed.data.name.trim(),
        status: parsed.data.status,
        entryType: parsed.data.entryType,
        destinationType: parsed.data.destinationType,
        destinationId,
        note: parsed.data.note || null,
        createdBy: admin.adminId,
        updatedBy: admin.adminId,
      },
    }) as TrafficEntryRow;
    await writeTrafficEntryAudit(prisma, req, "traffic_entry.create", created.id, null, {
      code: created.code,
      name: created.name,
      status: created.status,
      entryType: created.entryType,
      destinationType: created.destinationType,
      destinationId: created.destinationId,
    }, parsed.data.reason || `创建渠道入口：${created.name}`);
    return reply.send({ ok: true, id: created.id });
  });

  fastify.patch("/admin/traffic-entries/:id", { preHandler: [requireAdmin("traffic_entry:edit")] }, async (req: any, reply) => {
    const id = String(req.params?.id || "").trim();
    const parsed = ZTRAFFIC_ENTRY_UPDATE.safeParse(req.body || {});
    if (!id) return reply.status(400).send({ error: "bad_request", message: "渠道 ID 不合法。" });
    if (!parsed.success) return reply.status(400).send({ error: "bad_request", message: "渠道配置不合法。" });
    const admin = (req as any).admin;
    const before = await prisma.trafficEntry.findUnique({ where: { id } }) as TrafficEntryRow | null;
    if (!before) return reply.status(404).send({ error: "not_found", message: "渠道入口不存在。" });
    const code = normalizeTrafficEntryCode(parsed.data.code);
    const destinationId = normalizeTrafficDestinationId(parsed.data.destinationType, parsed.data.destinationId);
    const destinationCheck = await validateTrafficEntryDestination(prisma, parsed.data.destinationType, destinationId);
    if (!destinationCheck.ok) return reply.status(409).send(destinationCheck);
    const duplicated = await prisma.trafficEntry.findFirst({
      where: {
        code,
        NOT: { id },
      },
      select: { id: true },
    });
    if (duplicated) {
      return reply.status(409).send({ error: "traffic_entry_code_exists", message: "渠道代码已存在，请更换后重试。" });
    }
    const updated = await prisma.trafficEntry.update({
      where: { id },
      data: {
        code,
        name: parsed.data.name.trim(),
        status: parsed.data.status,
        entryType: parsed.data.entryType,
        destinationType: parsed.data.destinationType,
        destinationId,
        note: parsed.data.note || null,
        updatedBy: admin.adminId,
      },
    }) as TrafficEntryRow;
    await writeTrafficEntryAudit(prisma, req, "traffic_entry.update", updated.id, {
      code: before.code,
      name: before.name,
      status: before.status,
      entryType: before.entryType,
      destinationType: before.destinationType,
      destinationId: before.destinationId,
    }, {
      code: updated.code,
      name: updated.name,
      status: updated.status,
      entryType: updated.entryType,
      destinationType: updated.destinationType,
      destinationId: updated.destinationId,
    }, parsed.data.reason || `更新渠道入口：${updated.name}`);
    return reply.send({ ok: true, id: updated.id });
  });
}
