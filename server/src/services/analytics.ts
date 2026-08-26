import { randomBytes } from "node:crypto";
import { z } from "zod";
import { hmacSha256Hex } from "../utils/crypto.js";

export const ANALYTICS_EVENT_NAMES = [
  "session_started",
  "page_viewed",
  "content_impression",
  "content_opened",
  "preview_started",
  "preview_completed",
  "preview_upgrade_shown",
  "unlock_clicked",
  "order_created",
  "payment_confirmed",
  "entitlement_activated",
  "channel_access_delivered",
  "preference_saved",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export const ANALYTICS_PLATFORM_VALUES = ["h5", "telegram_mini_app", "server", "unknown"] as const;
export type AnalyticsPlatformValue = (typeof ANALYTICS_PLATFORM_VALUES)[number];

export const EVENT_BATCH_SCHEMA = z.object({
  events: z.array(
    z.object({
      eventName: z.enum(ANALYTICS_EVENT_NAMES),
      occurredAt: z.string().datetime().optional(),
      payload: z.record(z.any()).optional().default({}),
    }),
  ).min(1).max(50),
}).strict();

const ENTRY_SOURCE_RE = /^[a-z0-9_\-]{1,32}$/i;
const SOURCE_MODULE_RE = /^[a-z0-9_\-]{1,32}$/i;
const PAGE_NAME_VALUES = ["home", "discover", "membership", "orders", "me", "detail"] as const;
const PAYMENT_METHOD_VALUES = ["telegram_stars", "usdt_trc20", "manual"] as const;
const RESOURCE_TYPE_VALUES = ["content", "package", "membership_channel"] as const;
const DELIVERY_TYPE_VALUES = ["redirect_302", "telegram_dm", "manual"] as const;
const PREFERENCE_SOURCE_VALUES = ["guest_onboarding", "my_preferences", "first_browse_prompt", "migration_confirmed"] as const;

function normalizeSmallString(input: unknown, max = 64): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value || value.length > max) return null;
  return value;
}

function toPositiveInt(input: unknown, max = 10_000): number | null {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0 || value > max) return null;
  return value;
}

function normalizePageName(input: unknown): string | null {
  const value = normalizeSmallString(input, 24);
  if (!value) return null;
  return (PAGE_NAME_VALUES as readonly string[]).includes(value) ? value : null;
}

function normalizePlatform(input: unknown): AnalyticsPlatformValue {
  const value = normalizeSmallString(input, 32);
  if (!value) return "unknown";
  return (ANALYTICS_PLATFORM_VALUES as readonly string[]).includes(value) ? (value as AnalyticsPlatformValue) : "unknown";
}

function normalizeEnumValue(input: unknown, allowed: readonly string[], max = 64): string | null {
  const value = normalizeSmallString(input, max);
  if (!value) return null;
  return allowed.includes(value) ? value : null;
}

function analyticsIdHmac(kind: string, raw: unknown): string | null {
  const value = normalizeSmallString(raw, 128);
  if (!value) return null;
  return hmacSha256Hex(`analytics:${kind}:${value}`);
}

export function ensureAnalyticsSessionSeed(req: any): string {
  const sess = (req.session as any) || {};
  if (!sess.analyticsSessionSeed) {
    sess.analyticsSessionSeed = randomBytes(16).toString("hex");
    try { req.session?.save?.(); } catch {}
  }
  return String(sess.analyticsSessionSeed);
}

export function analyticsSessionIdHmac(seed: string): string {
  return hmacSha256Hex(`analytics_session:${seed}`);
}

export function analyticsAnonymousIdHmac(userId: string | null | undefined, sessionSeed: string): string {
  if (userId) return hmacSha256Hex(`analytics_anon_user:${userId}`);
  return hmacSha256Hex(`analytics_anon_session:${sessionSeed}`);
}

export function analyticsUserIdHmac(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return hmacSha256Hex(`analytics_user:${userId}`);
}

export function sanitizeAnalyticsEvent(input: {
  eventName: AnalyticsEventName;
  payload?: Record<string, unknown>;
  platformHint?: unknown;
}): {
  eventName: AnalyticsEventName;
  platform: AnalyticsPlatformValue;
  propertiesJson: Record<string, unknown>;
} {
  const payload = (input.payload || {}) as Record<string, unknown>;
  const platform = normalizePlatform(payload.platform ?? input.platformHint);

  switch (input.eventName) {
    case "session_started": {
      const entrySource = normalizeSmallString(payload.entrySource, 32);
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          entrySource: entrySource && ENTRY_SOURCE_RE.test(entrySource) ? entrySource : "unknown",
        },
      };
    }
    case "page_viewed": {
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          pageName: normalizePageName(payload.pageName) ?? "home",
          contentIdHmac: analyticsIdHmac("content", payload.contentId),
        },
      };
    }
    case "content_impression": {
      const sourceModule = normalizeSmallString(payload.sourceModule, 32);
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          contentIdHmac: analyticsIdHmac("content", payload.contentId),
          position: toPositiveInt(payload.position, 1000),
          sourceModule: sourceModule && SOURCE_MODULE_RE.test(sourceModule) ? sourceModule : "unknown",
        },
      };
    }
    case "content_opened": {
      const sourceModule = normalizeSmallString(payload.sourceModule, 32);
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          contentIdHmac: analyticsIdHmac("content", payload.contentId),
          sourceModule: sourceModule && SOURCE_MODULE_RE.test(sourceModule) ? sourceModule : "unknown",
        },
      };
    }
    case "preview_started":
    case "preview_completed":
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          contentIdHmac: analyticsIdHmac("content", payload.contentId),
        },
      };
    case "preview_upgrade_shown":
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          contentIdHmac: analyticsIdHmac("content", payload.contentId),
          accessType: normalizeEnumValue(payload.accessType, ["membership", "package"]) ?? "membership",
        },
      };
    case "unlock_clicked":
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          productIdHmac: analyticsIdHmac("product", payload.productId),
          paymentMethod: normalizeEnumValue(payload.paymentMethod, PAYMENT_METHOD_VALUES) ?? "manual",
        },
      };
    case "order_created":
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          orderNoHmac: analyticsIdHmac("order", payload.orderNo),
          productIdHmac: analyticsIdHmac("product", payload.productId),
          paymentMethod: normalizeEnumValue(payload.paymentMethod, PAYMENT_METHOD_VALUES) ?? "manual",
        },
      };
    case "payment_confirmed":
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          orderNoHmac: analyticsIdHmac("order", payload.orderNo),
          productIdHmac: analyticsIdHmac("product", payload.productId),
          paymentMethod: normalizeEnumValue(payload.paymentMethod, PAYMENT_METHOD_VALUES) ?? "manual",
        },
      };
    case "entitlement_activated":
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          resourceType: normalizeEnumValue(payload.resourceType, RESOURCE_TYPE_VALUES) ?? "content",
          resourceIdHmac: analyticsIdHmac("resource", payload.resourceId),
        },
      };
    case "channel_access_delivered":
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          deliveryType: normalizeEnumValue(payload.deliveryType, DELIVERY_TYPE_VALUES) ?? "redirect_302",
          resourceType: normalizeEnumValue(payload.resourceType, RESOURCE_TYPE_VALUES) ?? "content",
        },
      };
    case "preference_saved":
      return {
        eventName: input.eventName,
        platform,
        propertiesJson: {
          selectedCount: toPositiveInt(payload.selectedCount, 100) ?? 0,
          source: normalizeEnumValue(payload.source, PREFERENCE_SOURCE_VALUES) ?? "my_preferences",
        },
      };
  }
}
