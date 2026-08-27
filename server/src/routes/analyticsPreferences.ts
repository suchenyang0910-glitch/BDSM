import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  EVENT_BATCH_SCHEMA,
  analyticsAnonymousIdHmac,
  analyticsSessionIdHmac,
  analyticsUserIdHmac,
  ensureAnalyticsSessionSeed,
  sanitizeAnalyticsEvent,
} from "../services/analytics.js";
import { emitStructuredLog } from "../utils/structuredError.js";
import { shortFingerprint } from "../utils/crypto.js";
import { requireAdmin } from "./admin.js";

const PREFERENCE_SOURCE_SCHEMA = z.enum([
  "guest_onboarding",
  "my_preferences",
  "first_browse_prompt",
  "migration_confirmed",
]);

const PREFERENCE_UPDATE_SCHEMA = z.object({
  topicCategoryIds: z.array(z.string().min(1)).max(5).optional(),
  contentFormats: z.array(z.enum(["curated_on_demand", "creator_interview", "community_discussion", "event_preview"])).max(4).optional(),
  discoveryModes: z.array(z.enum(["latest_first", "featured_first", "following_first"])).max(3).optional(),
  notifications: z.object({
    order_status: z.boolean().optional(),
    entitlement_reminder: z.boolean().optional(),
    public_channel_update: z.boolean().optional(),
    campaign_notice: z.boolean().optional(),
  }).optional(),
  personalizationEnabled: z.boolean().optional(),
  source: PREFERENCE_SOURCE_SCHEMA.optional().default("my_preferences"),
}).strict();

const NOTIFICATION_KEYS = ["order_status", "entitlement_reminder", "public_channel_update", "campaign_notice"] as const;
const FORMAT_KEYS = ["curated_on_demand", "creator_interview", "community_discussion", "event_preview"] as const;
const DISCOVERY_KEYS = ["latest_first", "featured_first", "following_first"] as const;
const PERSONALIZATION_KEY = "personalized_ranking";
const ANALYTICS_ADMIN_QUERY = z.object({ preset: z.enum(["7d", "30d"]).optional().default("7d") }).strict();
const FUNNEL_EVENTS = [
  "session_started",
  "content_opened",
  "preview_started",
  "preview_completed",
  "checkout_open",
  "payment_confirmed",
  "playback_started",
] as const;

function analyticsRange(preset: "7d" | "30d") {
  const to = new Date();
  return { from: new Date(to.getTime() - (preset === "30d" ? 30 : 7) * 24 * 60 * 60 * 1000), to };
}

type EventCountRow = { eventName: string; value: number };
type PlatformCountRow = { platform: string; eventCount: number };
type TrendRow = { date: string; sessions: number; contentOpened: number; paymentsConfirmed: number };
type BucketRow = { bucket: string; value: number };
type QualityTransitionRow = { transition: string; value: number };
type AnalyticsQueryClient = {
  $queryRaw: <T = unknown>(query: Prisma.Sql) => Promise<T>;
};

async function loadAnalyticsOverviewAggregates(prisma: AnalyticsQueryClient, from: Date, to: Date) {
  const queryRaw = prisma.$queryRaw.bind(prisma) as AnalyticsQueryClient["$queryRaw"];
  const funnelEventsSql = Prisma.join(FUNNEL_EVENTS.map((eventName) => Prisma.sql`${eventName}`));
  const [
    totalRows,
    funnelRows,
    platformRows,
    trendRows,
    firstFrameTotalRows,
    firstFrameBucketRows,
    bufferRows,
    bufferBucketRows,
    prefetchRows,
    qualityRows,
  ] = await Promise.all([
    queryRaw<Array<{ eventCount: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "eventCount"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from} AND "occurred_at" <= ${to}
    `),
    queryRaw<EventCountRow[]>(Prisma.sql`
      SELECT "event_name" AS "eventName", COUNT(DISTINCT "session_id_hmac")::int AS "value"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from}
        AND "occurred_at" <= ${to}
        AND "event_name" IN (${funnelEventsSql})
      GROUP BY "event_name"
    `),
    queryRaw<PlatformCountRow[]>(Prisma.sql`
      SELECT "platform"::text AS "platform", COUNT(*)::int AS "eventCount"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from} AND "occurred_at" <= ${to}
      GROUP BY "platform"
      ORDER BY "eventCount" DESC, "platform" ASC
    `),
    queryRaw<TrendRow[]>(Prisma.sql`
      SELECT
        TO_CHAR(("occurred_at" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS "date",
        COUNT(DISTINCT CASE WHEN "event_name" = 'session_started' THEN "session_id_hmac" END)::int AS "sessions",
        COUNT(DISTINCT CASE WHEN "event_name" = 'content_opened' THEN "session_id_hmac" END)::int AS "contentOpened",
        COUNT(DISTINCT CASE WHEN "event_name" = 'payment_confirmed' THEN "session_id_hmac" END)::int AS "paymentsConfirmed"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from} AND "occurred_at" <= ${to}
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT "session_id_hmac")::int AS "total"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from}
        AND "occurred_at" <= ${to}
        AND "event_name" = 'playback_first_frame'
    `),
    queryRaw<BucketRow[]>(Prisma.sql`
      SELECT COALESCE("properties_json"->>'elapsedBucket', 'unknown') AS "bucket", COUNT(*)::int AS "value"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from}
        AND "occurred_at" <= ${to}
        AND "event_name" = 'playback_first_frame'
        AND "properties_json"->>'elapsedBucket' IS NOT NULL
      GROUP BY 1
      ORDER BY "value" DESC, "bucket" ASC
    `),
    queryRaw<Array<{ starts: number; ends: number }>>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE "event_name" = 'playback_buffer_start')::int AS "starts",
        COUNT(*) FILTER (WHERE "event_name" = 'playback_buffer_end')::int AS "ends"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from}
        AND "occurred_at" <= ${to}
        AND "event_name" IN ('playback_buffer_start', 'playback_buffer_end')
    `),
    queryRaw<BucketRow[]>(Prisma.sql`
      SELECT COALESCE("properties_json"->>'bufferDurationBucket', 'unknown') AS "bucket", COUNT(*)::int AS "value"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from}
        AND "occurred_at" <= ${to}
        AND "event_name" IN ('playback_buffer_start', 'playback_buffer_end')
        AND "properties_json"->>'bufferDurationBucket' IS NOT NULL
      GROUP BY 1
      ORDER BY "value" DESC, "bucket" ASC
    `),
    queryRaw<Array<{ hit: number; miss: number; error: number }>>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE "properties_json"->>'result' = 'hit')::int AS "hit",
        COUNT(*) FILTER (WHERE "properties_json"->>'result' = 'miss')::int AS "miss",
        COUNT(*) FILTER (WHERE "properties_json"->>'result' = 'error')::int AS "error"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from}
        AND "occurred_at" <= ${to}
        AND "event_name" = 'playback_prefetch_result'
    `),
    queryRaw<QualityTransitionRow[]>(Prisma.sql`
      SELECT
        CONCAT(
          COALESCE("properties_json"->>'fromQuality', 'auto'),
          '→',
          COALESCE("properties_json"->>'toQuality', 'auto'),
          ' (',
          COALESCE("properties_json"->>'reason', 'auto'),
          ')'
        ) AS "transition",
        COUNT(*)::int AS "value"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from}
        AND "occurred_at" <= ${to}
        AND "event_name" = 'playback_quality_change'
      GROUP BY 1
      ORDER BY "value" DESC, "transition" ASC
      LIMIT 8
    `),
  ]);

  return {
    eventCount: totalRows[0]?.eventCount ?? 0,
    funnelValues: new Map<string, number>(funnelRows.map((row: EventCountRow) => [row.eventName, row.value])),
    platforms: platformRows,
    trend: trendRows,
    playback: {
      firstFrameTotal: firstFrameTotalRows[0]?.total ?? 0,
      firstFrameBuckets: firstFrameBucketRows,
      bufferStarts: bufferRows[0]?.starts ?? 0,
      bufferEnds: bufferRows[0]?.ends ?? 0,
      bufferDurationBuckets: bufferBucketRows,
      prefetch: prefetchRows[0] ?? { hit: 0, miss: 0, error: 0 },
      qualityChanges: qualityRows,
    },
  };
}

export default async function analyticsAndPreferenceRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.get("/admin/analytics/google-integration", { preHandler: [requireAdmin("analytics:view")] }, async (_req, reply) => {
    const measurementId = String(process.env.GA4_MEASUREMENT_ID || "G-7EYN98PSVP").trim();
    const apiSecret = String(process.env.GA4_MEASUREMENT_PROTOCOL_API_SECRET || "").trim();
    return reply.send({
      webTag: { measurementId, configured: /^G-[A-Z0-9]+$/i.test(measurementId) },
      measurementProtocol: {
        configured: apiSecret.length >= 12 && !/^REPLACE_/i.test(apiSecret),
        storage: "server_environment",
      },
      message: "Measurement Protocol 密钥仅保存在服务端环境变量中，后台不会回显、传输或写入数据库。",
    });
  });

  fastify.get("/admin/analytics/overview", { preHandler: [requireAdmin("analytics:view")] }, async (req, reply) => {
    const parsed = ANALYTICS_ADMIN_QUERY.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: "bad_request", message: "统计周期不合法" });
    const { from, to } = analyticsRange(parsed.data.preset);
    const [overview, preferences] = await Promise.all([
      loadAnalyticsOverviewAggregates(prisma, from, to),
      prisma.userContentPreference.groupBy({
        by: ["preferenceType", "valueKey"], where: { isEnabled: true }, _count: { _all: true },
        orderBy: { _count: { valueKey: "desc" } }, take: 20,
      }),
    ]);
    const start = overview.funnelValues.get("session_started") || 0;
    const funnel = FUNNEL_EVENTS.map((eventName) => {
      const value = overview.funnelValues.get(eventName) || 0;
      return { eventName, value, conversionFromStart: start ? Number(((value / start) * 100).toFixed(1)) : 0 };
    });
    const prefetchAttempts = overview.playback.prefetch.hit + overview.playback.prefetch.miss + overview.playback.prefetch.error;
    return reply.send({
      period: { preset: parsed.data.preset, from: from.toISOString(), to: to.toISOString() },
      totals: {
        eventCount: overview.eventCount,
        sessions: start,
        contentOpened: overview.funnelValues.get("content_opened") || 0,
        paymentsConfirmed: overview.funnelValues.get("payment_confirmed") || 0,
      },
      funnel,
      platforms: overview.platforms,
      trend: overview.trend,
      playback: {
        firstFrame: {
          total: overview.playback.firstFrameTotal,
          buckets: overview.playback.firstFrameBuckets,
        },
        buffering: {
          starts: overview.playback.bufferStarts,
          ends: overview.playback.bufferEnds,
          buckets: overview.playback.bufferDurationBuckets,
        },
        prefetch: {
          hit: overview.playback.prefetch.hit,
          miss: overview.playback.prefetch.miss,
          error: overview.playback.prefetch.error,
          hitRate: prefetchAttempts ? Number(((overview.playback.prefetch.hit / prefetchAttempts) * 100).toFixed(1)) : 0,
        },
        qualityChanges: overview.playback.qualityChanges,
      },
      preferences: preferences.map((row: any) => ({ preferenceType: row.preferenceType, valueKey: row.valueKey, selectedUsers: row._count._all })),
      privacy: "仅展示聚合统计；不展示用户身份、内容标题、会话标识或个人浏览轨迹。",
    });
  });

  fastify.post("/analytics/events", async (req, reply) => {
    const parsed = EVENT_BATCH_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "bad_request", message: "埋点请求不合法" });
    }

    const sessionSeed = ensureAnalyticsSessionSeed(req);
    const userId = typeof (req as any).userId === "string" ? (req as any).userId : null;
    if (!userId) {
      return reply.status(401).send({ error: "unauthorized", message: "请先建立账户会话后再提交数据" });
    }
    const anonymousIdHmac = analyticsAnonymousIdHmac(userId, sessionSeed);
    const sessionIdHmac = analyticsSessionIdHmac(sessionSeed);
    const userIdHmac = analyticsUserIdHmac(userId);

    const rows = parsed.data.events.map((event) => {
      const sanitized = sanitizeAnalyticsEvent({
        eventName: event.eventName,
        payload: event.payload,
        platformHint: event.payload?.platform ?? "unknown",
      });
      const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
      return {
        occurredAt,
        eventName: sanitized.eventName,
        userId,
        anonymousIdHmac,
        userIdHmac,
        sessionIdHmac,
        platform: sanitized.platform,
        propertiesJson: sanitized.propertiesJson,
      };
    });

    await prisma.analyticsEvent.createMany({ data: rows });

    emitStructuredLog({
      event: "analytics_events_ingested",
      errorClass: "business",
      retryHint: 0,
      note: `count=${rows.length}`,
      counts: { accepted: rows.length },
    });

    return reply.status(202).send({
      ok: true,
      accepted: rows.length,
      sessionIdHmac: sessionIdHmac.slice(0, 16),
      anonymousIdHmac: anonymousIdHmac.slice(0, 16),
    });
  });

  fastify.get("/me/preferences", async (req, reply) => {
    const userId = typeof (req as any).userId === "string" ? (req as any).userId : null;
    if (!userId) {
      return reply.status(401).send({ error: "unauthorized", message: "请先建立访客或 Telegram 会话" });
    }

    const rows = await prisma.userContentPreference.findMany({
      where: { userId },
      include: { category: { select: { id: true, name: true, status: true } } },
      orderBy: [{ preferenceType: "asc" }, { updatedAt: "desc" }],
    });

    return {
      ok: true,
      personalizationEnabled: !rows.some((row: any) => row.preferenceType === "discovery_mode" && row.valueKey === PERSONALIZATION_KEY && row.isEnabled === false),
      topicCategoryIds: rows
        .filter((row: any) => row.isEnabled && row.preferenceType === "content_topic" && row.categoryId && row.category?.status === "active")
        .map((row: any) => row.categoryId),
      topicCategories: rows
        .filter((row: any) => row.isEnabled && row.preferenceType === "content_topic" && row.categoryId && row.category?.status === "active")
        .map((row: any) => ({ id: row.category.id, name: row.category.name })),
      contentFormats: rows.filter((row: any) => row.isEnabled && row.preferenceType === "content_format").map((row: any) => row.valueKey),
      discoveryModes: rows.filter((row: any) => row.isEnabled && row.preferenceType === "discovery_mode" && row.valueKey !== PERSONALIZATION_KEY).map((row: any) => row.valueKey),
      notifications: Object.fromEntries(NOTIFICATION_KEYS.map((key) => [key, rows.some((row: any) => row.isEnabled && row.preferenceType === "notification" && row.valueKey === key)])),
      updatedAt: rows[0]?.updatedAt?.toISOString?.() ?? null,
    };
  });

  fastify.post("/me/preferences", async (req, reply) => {
    const userId = typeof (req as any).userId === "string" ? (req as any).userId : null;
    if (!userId) {
      return reply.status(401).send({ error: "unauthorized", message: "请先建立访客或 Telegram 会话" });
    }

    const parsed = PREFERENCE_UPDATE_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "bad_request", message: "偏好参数不合法" });
    }
    const body = parsed.data;

    if (body.topicCategoryIds) {
      const distinct = [...new Set(body.topicCategoryIds)];
      const categories = await prisma.category.findMany({
        where: { id: { in: distinct }, status: "active" },
        select: { id: true },
      });
      if (categories.length !== distinct.length) {
        return reply.status(400).send({ error: "bad_request", message: "存在无效或未启用的偏好分类" });
      }
      body.topicCategoryIds = distinct;
    }

    const now = new Date();
    const createRows: any[] = [];

    if (body.topicCategoryIds) {
      for (const categoryId of body.topicCategoryIds) {
        createRows.push({
          userId,
          categoryId,
          preferenceType: "content_topic",
          valueKey: categoryId,
          isEnabled: true,
          source: body.source,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    if (body.contentFormats) {
      for (const valueKey of body.contentFormats) {
        createRows.push({
          userId,
          preferenceType: "content_format",
          valueKey,
          isEnabled: true,
          source: body.source,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    if (body.discoveryModes) {
      for (const valueKey of body.discoveryModes) {
        createRows.push({
          userId,
          preferenceType: "discovery_mode",
          valueKey,
          isEnabled: true,
          source: body.source,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    if (body.personalizationEnabled !== undefined) {
      createRows.push({
        userId,
        preferenceType: "discovery_mode",
        valueKey: PERSONALIZATION_KEY,
        isEnabled: body.personalizationEnabled,
        source: body.source,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (body.notifications) {
      for (const key of NOTIFICATION_KEYS) {
        if (body.notifications[key] === true) {
          createRows.push({
            userId,
            preferenceType: "notification",
            valueKey: key,
            isEnabled: true,
            source: body.source,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }

    await prisma.$transaction(async (tx: any) => {
      if (body.topicCategoryIds) {
        await tx.userContentPreference.deleteMany({ where: { userId, preferenceType: "content_topic" } });
      }
      if (body.contentFormats) {
        await tx.userContentPreference.deleteMany({ where: { userId, preferenceType: "content_format" } });
      }
      if (body.discoveryModes || body.personalizationEnabled !== undefined) {
        await tx.userContentPreference.deleteMany({ where: { userId, preferenceType: "discovery_mode" } });
      }
      if (body.notifications) {
        await tx.userContentPreference.deleteMany({ where: { userId, preferenceType: "notification" } });
      }
      if (createRows.length > 0) {
        await tx.userContentPreference.createMany({ data: createRows });
      }
    });

    emitStructuredLog({
      event: "user_preference_updated",
      errorClass: "business",
      retryHint: 0,
      note: `user_fp=${shortFingerprint("user", userId)}`,
      counts: { selected: createRows.length },
    });

    await prisma.analyticsEvent.create({
      data: {
        occurredAt: now,
        eventName: "preference_saved",
        userId,
        anonymousIdHmac: analyticsAnonymousIdHmac(userId, ensureAnalyticsSessionSeed(req)),
        userIdHmac: analyticsUserIdHmac(userId),
        sessionIdHmac: analyticsSessionIdHmac(ensureAnalyticsSessionSeed(req)),
        platform: "server",
        propertiesJson: {
          selectedCount: createRows.length,
          source: body.source,
        },
      },
    }).catch(() => null);

    return reply.status(200).send({ ok: true, updatedCount: createRows.length });
  });

  fastify.delete("/me/preferences", async (req, reply) => {
    const userId = typeof (req as any).userId === "string" ? (req as any).userId : null;
    if (!userId) {
      return reply.status(401).send({ error: "unauthorized", message: "请先建立访客或 Telegram 会话" });
    }

    const deleted = await prisma.userContentPreference.deleteMany({ where: { userId } });
    emitStructuredLog({
      event: "user_preference_cleared",
      errorClass: "business",
      retryHint: 0,
      note: `user_fp=${shortFingerprint("user", userId)}`,
      counts: { deleted: deleted.count },
    });
    return reply.status(200).send({ ok: true, deletedCount: deleted.count });
  });
}
