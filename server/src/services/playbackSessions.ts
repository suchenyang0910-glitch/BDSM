import crypto from "node:crypto";

import type { PlaybackConfig } from "./playbackConfig.js";
import { isPlaybackAllowedForPoc } from "./playbackConfig.js";

type PlaybackCreateError =
  | "unauthorized"
  | "user_suspended"
  | "content_not_found"
  | "content_not_published"
  | "video_delivery_disabled"
  | "video_not_ready"
  | "entitlement_required"
  | "entitlement_expired"
  | "playback_device_limit"
  | "video_delivery_not_configured";

type PlaybackAccessOk = {
  ok: true;
  content: any;
  entitlementId: string | null;
  deliveryVariant: "preview" | "full";
};

type PlaybackAccessFail = {
  ok: false;
  error: PlaybackCreateError;
};

export type PlaybackAccessResult = PlaybackAccessOk | PlaybackAccessFail;

function normalizeSignal(raw: unknown, maxLen = 120): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[0-9]+/g, "0")
    .replace(/\s+/g, " ")
    .slice(0, maxLen);
}

export function derivePlaybackDeviceHash(input: {
  userId: string;
  userAgent?: string | null;
  acceptLanguage?: string | null;
  platform?: string | null;
  signingKey: string;
  now?: Date;
}): string {
  const now = input.now || new Date();
  const yearWeek = `${now.getUTCFullYear()}-${Math.ceil((now.getUTCDate() + now.getUTCMonth() * 31) / 7)}`;
  const normalized = [
    input.userId,
    normalizeSignal(input.userAgent),
    normalizeSignal(input.acceptLanguage, 32),
    normalizeSignal(input.platform, 32),
    yearWeek,
  ].join("|");
  return crypto.createHmac("sha256", Buffer.from(input.signingKey, "utf8")).update(normalized).digest("hex");
}

function hasReadyFullRenditions(content: any): boolean {
  const asset = content?.fullVideoAsset;
  if (!asset || asset.status !== "verified") return false;
  const items = Array.isArray(asset.renditions) ? asset.renditions : [];
  const fullItems = items.filter((row: any) => row.kind !== "preview");
  if (fullItems.length === 0) return false;
  return fullItems.every((row: any) => row.status === "ready");
}

function hasPreviewAsset(content: any): boolean {
  if (content?.previewEnabled === false) return false;
  const items = Array.isArray(content?.fullVideoAsset?.renditions) ? content.fullVideoAsset.renditions : [];
  return items.some((row: any) => row.kind === "preview" && row.status === "ready");
}

export async function getPlaybackStatusSummary(
  prisma: any,
  cfg: PlaybackConfig,
  input: { contentId: string; userId?: string | null },
) {
  const now = new Date();
  const content = await prisma.content.findUnique({
    where: { id: input.contentId },
    include: {
      fullVideoAsset: {
        include: {
          renditions: true,
        },
      },
    },
  });
  if (!content) return { httpStatus: 404, body: { error: "content_not_found", message: "内容不存在" } };
  if (content.status !== "published") {
    return { httpStatus: 403, body: { error: "content_not_published", message: "内容未发布" } };
  }

  const previewAvailable = hasPreviewAsset(content);
  const modeError = !content.platformPlaybackEnabled
    ? "video_delivery_disabled"
    : cfg.mode === "disabled"
      ? "video_delivery_disabled"
      : !cfg.configured
        ? "video_delivery_not_configured"
        : cfg.mode === "poc" && !isPlaybackAllowedForPoc(cfg, { contentId: content.id, userId: input.userId })
          ? "video_delivery_disabled"
          : null;

  if (modeError) {
    return {
      httpStatus: 200,
      body: {
        contentId: content.id,
        previewAvailable,
        fullPlaybackAvailable: false,
        action: previewAvailable ? "preview" : "disabled",
        errorClass: modeError,
        entitlement: "none",
      },
    };
  }

  if (!input.userId) {
    return {
      httpStatus: 200,
      body: {
        contentId: content.id,
        previewAvailable,
        fullPlaybackAvailable: false,
        action: "login",
        errorClass: "unauthorized",
        entitlement: "none",
      },
    };
  }

  const entitlement = await resolvePlaybackEntitlement(prisma, {
    userId: input.userId,
    content,
    now,
  });
  if (!entitlement.ok && previewAvailable) {
    return {
      httpStatus: 200,
      body: {
        contentId: content.id,
        previewAvailable,
        fullPlaybackAvailable: false,
        action: "preview",
        errorClass: null,
        entitlement: "none",
        deliveryVariant: "preview",
      },
    };
  }
  if (!hasReadyFullRenditions(content)) {
    return {
      httpStatus: 200,
      body: {
        contentId: content.id,
        previewAvailable,
        fullPlaybackAvailable: false,
        action: previewAvailable ? "preview" : "processing",
        errorClass: "video_not_ready",
        entitlement: entitlement.ok ? "granted" : "none",
        deliveryVariant: previewAvailable ? "preview" : null,
      },
    };
  }
  if (!entitlement.ok) {
    return {
      httpStatus: 200,
      body: {
        contentId: content.id,
        previewAvailable,
        fullPlaybackAvailable: false,
        action: content.accessType === "membership" ? "subscribe" : "purchase",
        errorClass: entitlement.error,
        entitlement: "none",
        deliveryVariant: previewAvailable ? "preview" : null,
      },
    };
  }

  return {
    httpStatus: 200,
    body: {
      contentId: content.id,
      previewAvailable,
      fullPlaybackAvailable: true,
      action: "play_full",
      errorClass: null,
      entitlement: "granted",
      deliveryVariant: "full",
    },
  };
}

export async function resolvePlaybackEntitlement(
  prisma: any,
  input: { userId: string; content: any; now?: Date },
): Promise<PlaybackAccessResult> {
  const now = input.now || new Date();
  const content = input.content;
  if (content.accessType === "public") {
    return { ok: false, error: "entitlement_required" };
  }

  const relevantFilters: any[] = [{ resourceType: "content", resourceId: content.id }];
  if (content.packageId) relevantFilters.push({ resourceType: "package", resourceId: content.packageId });
  if (content.accessType === "membership") relevantFilters.push({ resourceType: "membership_channel", resourceId: "membership-main" });

  const active = await prisma.entitlement.findFirst({
    where: {
      userId: input.userId,
      status: "active",
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
        { OR: relevantFilters },
      ],
    },
    orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }],
  });
  if (active) {
    return { ok: true, content, entitlementId: active.id, deliveryVariant: "full" };
  }

  const latest = await prisma.entitlement.findFirst({
    where: {
      userId: input.userId,
      OR: relevantFilters,
    },
    orderBy: [{ expiresAt: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }],
  });
  if (!latest) return { ok: false, error: "entitlement_required" };
  if (latest.status !== "active" || (latest.expiresAt && latest.expiresAt.getTime() < now.getTime())) {
    return { ok: false, error: "entitlement_expired" };
  }
  return { ok: false, error: "entitlement_required" };
}

export async function resolvePlaybackCreateAccess(
  prisma: any,
  cfg: PlaybackConfig,
  input: { contentId: string; userId?: string | null },
): Promise<PlaybackAccessResult> {
  if (!input.userId) return { ok: false, error: "unauthorized" };
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { status: true },
  });
  if (!user || user.status !== "active") return { ok: false, error: "user_suspended" };
  const content = await prisma.content.findUnique({
    where: { id: input.contentId },
    include: {
      fullVideoAsset: {
        include: {
          renditions: true,
        },
      },
    },
  });
  if (!content) return { ok: false, error: "content_not_found" };
  if (content.status !== "published") return { ok: false, error: "content_not_published" };
  if (!content.platformPlaybackEnabled || cfg.mode === "disabled") return { ok: false, error: "video_delivery_disabled" };
  if (!cfg.configured) return { ok: false, error: "video_delivery_not_configured" };
  if (cfg.mode === "poc" && !isPlaybackAllowedForPoc(cfg, { contentId: content.id, userId: input.userId })) {
    return { ok: false, error: "video_delivery_disabled" };
  }
  const entitlement = await resolvePlaybackEntitlement(prisma, { userId: input.userId, content });
  if (entitlement.ok) {
    if (!hasReadyFullRenditions(content)) return { ok: false, error: "video_not_ready" };
    return { ...entitlement, deliveryVariant: "full" };
  }
  if (hasPreviewAsset(content)) {
    return {
      ok: true,
      content,
      entitlementId: null,
      deliveryVariant: "preview",
    };
  }
  return entitlement;
}

export async function cleanupExpiredPlaybackSessions(prisma: any, now = new Date()) {
  await prisma.playbackSession.updateMany({
    where: {
      status: "active",
      expiresAt: { lt: now },
    },
    data: {
      status: "expired",
      revokedAt: now,
    },
  });
}

export async function enforcePlaybackDeviceLimit(
  prisma: any,
  input: { userId: string; currentDeviceHash: string; maxActiveDevices: number; now?: Date },
) {
  const now = input.now || new Date();
  await cleanupExpiredPlaybackSessions(prisma, now);
  const activeRows = await prisma.playbackSession.findMany({
    where: {
      userId: input.userId,
      status: "active",
      expiresAt: { gt: now },
    },
    select: { deviceHash: true },
  });
  const activeDevices = Array.from(new Set(activeRows.map((row: any) => row.deviceHash)));
  if (activeDevices.includes(input.currentDeviceHash)) {
    return { ok: true as const };
  }
  if (activeDevices.length >= input.maxActiveDevices) {
    return { ok: false as const, error: "playback_device_limit" as const };
  }
  return { ok: true as const };
}

export function applyPlaybackProgress(input: {
  positionSec: number;
  durationSec: number | null;
  eventName: "progress" | "pause" | "complete" | "leave";
}) {
  const durationSec = input.durationSec && Number.isFinite(input.durationSec)
    ? Math.max(0, Math.min(86_400, Math.floor(input.durationSec)))
    : null;
  const positionSec = Math.max(0, Math.min(86_400, Math.floor(input.positionSec)));
  const capped = durationSec != null ? Math.min(positionSec, durationSec) : positionSec;
  const completed = input.eventName === "complete"
    || (!!durationSec && (durationSec - capped < 30 || capped / durationSec >= 0.95));
  return {
    durationSec,
    positionSec: capped,
    completed,
  };
}
