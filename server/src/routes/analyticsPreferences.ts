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
const FUNNEL_EVENTS = ["session_started", "content_opened", "unlock_clicked", "order_created", "payment_confirmed"] as const;

function analyticsRange(preset: "7d" | "30d") {
  const to = new Date();
  return { from: new Date(to.getTime() - (preset === "30d" ? 30 : 7) * 24 * 60 * 60 * 1000), to };
}

export default async function analyticsAndPreferenceRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.get("/admin/analytics/overview", { preHandler: [requireAdmin("analytics:view")] }, async (req, reply) => {
    const parsed = ANALYTICS_ADMIN_QUERY.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: "bad_request", message: "统计周期不合法" });
    const { from, to } = analyticsRange(parsed.data.preset);
    const [events, preferences] = await Promise.all([
      prisma.analyticsEvent.findMany({
        where: { occurredAt: { gte: from, lte: to } },
        select: { occurredAt: true, eventName: true, platform: true, sessionIdHmac: true, userIdHmac: true },
        orderBy: { occurredAt: "asc" },
      }),
      prisma.userContentPreference.groupBy({
        by: ["preferenceType", "valueKey"], where: { isEnabled: true }, _count: { _all: true },
        orderBy: { _count: { valueKey: "desc" } }, take: 20,
      }),
    ]);
    const distinctByEvent = new Map<string, Set<string>>();
    const platformTotals = new Map<string, number>();
    const daily = new Map<string, { date: string; sessions: Set<string>; opens: Set<string>; paid: Set<string> }>();
    for (const event of events) {
      const eventSet = distinctByEvent.get(event.eventName) || new Set<string>();
      eventSet.add(event.sessionIdHmac || event.userIdHmac || "unknown");
      distinctByEvent.set(event.eventName, eventSet);
      platformTotals.set(event.platform, (platformTotals.get(event.platform) || 0) + 1);
      const date = event.occurredAt.toISOString().slice(0, 10);
      const bucket = daily.get(date) || { date, sessions: new Set<string>(), opens: new Set<string>(), paid: new Set<string>() };
      const key = event.sessionIdHmac || event.userIdHmac || "unknown";
      if (event.eventName === "session_started") bucket.sessions.add(key);
      if (event.eventName === "content_opened") bucket.opens.add(key);
      if (event.eventName === "payment_confirmed") bucket.paid.add(key);
      daily.set(date, bucket);
    }
    const start = distinctByEvent.get("session_started")?.size || 0;
    const funnel = FUNNEL_EVENTS.map((eventName) => {
      const value = distinctByEvent.get(eventName)?.size || 0;
      return { eventName, value, conversionFromStart: start ? Number(((value / start) * 100).toFixed(1)) : 0 };
    });
    return reply.send({
      period: { preset: parsed.data.preset, from: from.toISOString(), to: to.toISOString() },
      totals: { eventCount: events.length, sessions: start, contentOpened: distinctByEvent.get("content_opened")?.size || 0, paymentsConfirmed: distinctByEvent.get("payment_confirmed")?.size || 0 },
      funnel,
      platforms: Array.from(platformTotals, ([platform, eventCount]) => ({ platform, eventCount })),
      trend: Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({ date: row.date, sessions: row.sessions.size, contentOpened: row.opens.size, paymentsConfirmed: row.paid.size })),
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
