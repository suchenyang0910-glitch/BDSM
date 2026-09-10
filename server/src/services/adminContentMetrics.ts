import { Prisma } from "@prisma/client";
import { hmacSha256Hex } from "../utils/crypto.js";

export type AdminMetricTarget = {
  targetType: "video_content" | "article" | "circle_post";
  targetId: string;
  analyticsKey: string;
};

export type AdminContentMetrics = {
  views: number;
  viewers: number;
  likeCount: number;
  commentCount: number;
  reportCount: number;
};

type AnalyticsMetricRow = { metricKey: string | null; views: number; viewers: number };
type CountMetricRow = { targetType: string; targetId: string; _count: { _all: number } };

const EMPTY_METRICS: AdminContentMetrics = Object.freeze({
  views: 0,
  viewers: 0,
  likeCount: 0,
  commentCount: 0,
  reportCount: 0,
});

function keyOf(targetType: string, targetId: string) {
  return `${targetType}:${targetId}`;
}

function analyticsConfig(targetType: AdminMetricTarget["targetType"]) {
  if (targetType === "video_content") return { eventName: "content_opened", property: "contentIdHmac" };
  if (targetType === "article") return { eventName: "article_opened", property: "articleSlug" };
  return { eventName: "community_post_opened", property: "communityPostIdHmac" };
}

export function videoAnalyticsKey(contentId: string) {
  return hmacSha256Hex(`analytics:content:${contentId}`);
}

export function communityPostAnalyticsKey(postId: string) {
  return hmacSha256Hex(`analytics:community_post:${postId}`);
}

/**
 * Returns only aggregate content-level metrics. It intentionally never exposes
 * individual user, anonymous, or session browsing records to admin lists.
 */
export async function loadAdminContentMetrics(prisma: any, targets: AdminMetricTarget[]) {
  const result = new Map<string, AdminContentMetrics>();
  const deduped = Array.from(new Map(targets.map((target) => [keyOf(target.targetType, target.targetId), target])).values());
  for (const target of deduped) result.set(keyOf(target.targetType, target.targetId), { ...EMPTY_METRICS });
  if (deduped.length === 0) return result;

  const countsByKind = await Promise.all(
    (["like", "comment", "report"] as const).map(async (kind) => {
      const where: any = { OR: deduped.map((target) => ({ targetType: target.targetType, targetId: target.targetId })) };
      if (kind === "like") {
        where.subjectKind = "target";
        return prisma.interactionLike.groupBy({ by: ["targetType", "targetId"], where, _count: { _all: true } }) as Promise<CountMetricRow[]>;
      }
      if (kind === "comment") {
        where.status = "approved";
        return prisma.interactionComment.groupBy({ by: ["targetType", "targetId"], where, _count: { _all: true } }) as Promise<CountMetricRow[]>;
      }
      return prisma.interactionReport.groupBy({ by: ["targetType", "targetId"], where, _count: { _all: true } }) as Promise<CountMetricRow[]>;
    }),
  );

  for (const [index, field] of (["likeCount", "commentCount", "reportCount"] as const).entries()) {
    for (const row of countsByKind[index]) {
      const metrics = result.get(keyOf(row.targetType, row.targetId));
      if (metrics) metrics[field] = row._count._all;
    }
  }

  const analyticsGroups = new Map<string, AdminMetricTarget[]>();
  for (const target of deduped) {
    const config = analyticsConfig(target.targetType);
    const groupKey = `${config.eventName}:${config.property}`;
    analyticsGroups.set(groupKey, [...(analyticsGroups.get(groupKey) || []), target]);
  }
  await Promise.all(Array.from(analyticsGroups.entries()).map(async ([groupKey, groupTargets]) => {
    const [eventName, property] = groupKey.split(":");
    // property is selected exclusively by analyticsConfig; it is never user input.
    const propertyExpr = Prisma.raw(`"properties_json"->>'${property}'`);
    const rows = await prisma.$queryRaw(Prisma.sql`
      SELECT ${propertyExpr} AS "metricKey",
             COUNT(*)::int AS "views",
             COUNT(DISTINCT "session_id_hmac")::int AS "viewers"
      FROM "analytics_events"
      WHERE "event_name" = ${eventName}
        AND ${propertyExpr} IN (${Prisma.join(groupTargets.map((target) => target.analyticsKey))})
      GROUP BY ${propertyExpr}
    `) as AnalyticsMetricRow[];
    const byAnalyticsKey = new Map<string, AnalyticsMetricRow>(rows.map((row: AnalyticsMetricRow) => [row.metricKey || "", row]));
    for (const target of groupTargets) {
      const metrics = result.get(keyOf(target.targetType, target.targetId));
      const row = byAnalyticsKey.get(target.analyticsKey);
      if (metrics && row) {
        metrics.views = Number(row.views) || 0;
        metrics.viewers = Number(row.viewers) || 0;
      }
    }
  }));

  return result;
}

export function adminContentMetricsFor(metrics: Map<string, AdminContentMetrics>, targetType: AdminMetricTarget["targetType"], targetId: string): AdminContentMetrics {
  return metrics.get(keyOf(targetType, targetId)) || { ...EMPTY_METRICS };
}
