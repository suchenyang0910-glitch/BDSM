function parseBooleanFlag(raw: string | undefined, fallback: boolean) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseIntWithBounds(raw: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export type CommunityFeatureConfig = {
  enabled: boolean;
  postingEnabled: boolean;
  videoUploadEnabled: boolean;
  maxImagesPerPost: number;
  maxImageBytesPerAsset: bigint;
  maxImageTotalBytesPerPost: bigint;
  maxVideoBytesPerAsset: bigint;
  maxVideoUploadsPerDay: number;
  minVideoDurationSeconds: number;
  maxVideoDurationSeconds: number;
  maxVideoWidth: number;
  maxVideoHeight: number;
  maxVideoLongestEdge: number;
};

export function loadCommunityFeatureConfig(env: NodeJS.ProcessEnv = process.env): CommunityFeatureConfig {
  const maxImagesPerPost = parseIntWithBounds(env.COMMUNITY_MAX_IMAGES_PER_POST, 9, 1, 9);
  const maxImageBytesPerAsset = BigInt(parseIntWithBounds(env.COMMUNITY_MAX_IMAGE_BYTES, 10 * 1024 * 1024, 1, 100 * 1024 * 1024));
  return {
    enabled: parseBooleanFlag(env.COMMUNITY_ENABLED, false),
    postingEnabled: parseBooleanFlag(env.COMMUNITY_POSTING_ENABLED, false),
    videoUploadEnabled: parseBooleanFlag(env.COMMUNITY_VIDEO_UPLOAD_ENABLED, false),
    maxImagesPerPost,
    maxImageBytesPerAsset,
    maxImageTotalBytesPerPost: BigInt(parseIntWithBounds(
      env.COMMUNITY_MAX_IMAGE_TOTAL_BYTES_PER_POST,
      Number(maxImageBytesPerAsset) * maxImagesPerPost,
      1,
      900 * 1024 * 1024,
    )),
    maxVideoBytesPerAsset: BigInt(parseIntWithBounds(env.COMMUNITY_MAX_VIDEO_BYTES, 300 * 1024 * 1024, 1, 2 * 1024 * 1024 * 1024)),
    maxVideoUploadsPerDay: parseIntWithBounds(env.COMMUNITY_MAX_VIDEO_UPLOADS_PER_DAY, 1, 1, 20),
    minVideoDurationSeconds: parseIntWithBounds(env.COMMUNITY_MIN_VIDEO_DURATION_SECONDS, 3, 1, 600),
    maxVideoDurationSeconds: parseIntWithBounds(env.COMMUNITY_MAX_VIDEO_DURATION_SECONDS, 180, 1, 3600),
    maxVideoWidth: parseIntWithBounds(env.COMMUNITY_MAX_VIDEO_WIDTH, 1920, 64, 4096),
    maxVideoHeight: parseIntWithBounds(env.COMMUNITY_MAX_VIDEO_HEIGHT, 1920, 64, 4096),
    maxVideoLongestEdge: parseIntWithBounds(env.COMMUNITY_MAX_VIDEO_LONGEST_EDGE, 1920, 64, 4096),
  };
}

export function isCommunityReadEnabled(env: NodeJS.ProcessEnv = process.env) {
  return loadCommunityFeatureConfig(env).enabled;
}

export function isCommunityWriteEnabled(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadCommunityFeatureConfig(env);
  return cfg.enabled && cfg.postingEnabled;
}

export function isCommunityVideoUploadEnabled(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadCommunityFeatureConfig(env);
  return cfg.enabled && cfg.postingEnabled && cfg.videoUploadEnabled;
}

export function startOfCurrentUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}
