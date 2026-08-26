export type VideoDeliveryMode = "disabled" | "poc" | "enabled";
export type VideoCdnSigningMode = "edge_token" | "signed_cookie";

export type PlaybackConfig = {
  mode: VideoDeliveryMode;
  sessionTtlSeconds: number;
  maxActiveDevices: number;
  heartbeatIntervalSeconds: number;
  pocContentIds: string[];
  pocUserIds: string[];
  cdnBaseUrl: string | null;
  signingMode: VideoCdnSigningMode | null;
  signingKeyConfigured: boolean;
  configured: boolean;
  missingKeys: string[];
};

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseIdList(raw: string | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, idx, items) => items.indexOf(item) === idx);
}

export function loadPlaybackConfig(env: NodeJS.ProcessEnv = process.env): PlaybackConfig {
  const rawMode = String(env.VIDEO_DELIVERY_MODE || "disabled").trim().toLowerCase();
  const mode: VideoDeliveryMode = rawMode === "enabled" ? "enabled" : rawMode === "poc" ? "poc" : "disabled";
  const rawSigningMode = String(env.VIDEO_CDN_SIGNING_MODE || "").trim().toLowerCase();
  const signingMode: VideoCdnSigningMode | null =
    rawSigningMode === "signed_cookie" ? "signed_cookie" : rawSigningMode === "edge_token" ? "edge_token" : null;
  const cdnBaseUrl = String(env.VIDEO_CDN_BASE_URL || "").trim().replace(/\/+$/, "") || null;
  const signingKey = String(env.VIDEO_CDN_SIGNING_KEY || "").trim();
  const pocContentIds = parseIdList(env.PLAYBACK_POC_CONTENT_IDS);
  const pocUserIds = parseIdList(env.PLAYBACK_POC_USER_IDS);
  const missingKeys: string[] = [];

  if (mode !== "disabled") {
    if (!cdnBaseUrl) missingKeys.push("VIDEO_CDN_BASE_URL");
    if (!signingMode) missingKeys.push("VIDEO_CDN_SIGNING_MODE");
    if (!signingKey || signingKey.length < 24) missingKeys.push("VIDEO_CDN_SIGNING_KEY");
    if (mode === "poc") {
      if (pocContentIds.length === 0) missingKeys.push("PLAYBACK_POC_CONTENT_IDS");
      if (pocUserIds.length === 0) missingKeys.push("PLAYBACK_POC_USER_IDS");
    }
  }

  return {
    mode,
    sessionTtlSeconds: clampInt(env.PLAYBACK_SESSION_TTL_SECONDS, 300, 60, 300),
    maxActiveDevices: clampInt(env.PLAYBACK_MAX_ACTIVE_DEVICES, 2, 1, 5),
    heartbeatIntervalSeconds: clampInt(env.PLAYBACK_HEARTBEAT_INTERVAL_SECONDS, 15, 5, 60),
    pocContentIds,
    pocUserIds,
    cdnBaseUrl,
    signingMode,
    signingKeyConfigured: signingKey.length >= 24,
    configured: missingKeys.length === 0,
    missingKeys,
  };
}

export function isPlaybackAllowedForPoc(
  cfg: Pick<PlaybackConfig, "mode" | "pocContentIds" | "pocUserIds">,
  input: { contentId: string; userId: string | null | undefined },
): boolean {
  if (cfg.mode === "enabled") return true;
  if (cfg.mode !== "poc") return false;
  if (!input.userId) return false;
  return cfg.pocContentIds.includes(input.contentId) && cfg.pocUserIds.includes(input.userId);
}

export function playbackConfigErrorClass(cfg: Pick<PlaybackConfig, "mode" | "configured">): string | null {
  if (cfg.mode === "disabled") return "video_delivery_disabled";
  if (!cfg.configured) return "video_delivery_not_configured";
  return null;
}
