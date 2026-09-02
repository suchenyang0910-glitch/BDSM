import { PrismaClient } from "@prisma/client";
import { loadCommunityMediaConfig, processNextCommunityVideoAsset } from "../services/communityMedia.js";
import { loadCommunityFeatureConfig } from "../services/communityConfig.js";
import { emitSafetyEvent, emitStructuredLog } from "../utils/structuredError.js";

const prisma = new PrismaClient();
const cfg = loadCommunityMediaConfig();
const featureConfig = loadCommunityFeatureConfig(process.env);
const pollIntervalMs = Math.min(Math.max(Number.parseInt(String(process.env.COMMUNITY_TRANSCODE_POLL_INTERVAL_MS || "10000"), 10) || 10_000, 1_000), 60_000);

async function main() {
  if (!featureConfig.enabled || !featureConfig.videoUploadEnabled) {
    emitStructuredLog({
      event: "community_transcode_worker_disabled",
      errorClass: "business",
      note: `community_enabled=${featureConfig.enabled ? 1 : 0} video_upload_enabled=${featureConfig.videoUploadEnabled ? 1 : 0}`,
    });
    return;
  }
  emitStructuredLog({
    event: "community_transcode_worker_started",
    errorClass: "business",
    counts: { pollIntervalMs },
  });
  for (;;) {
    const processed = await processNextCommunityVideoAsset(prisma, cfg).catch((error) => {
      emitSafetyEvent({ event: "community_transcode_worker_iteration_failed", errorClass: "unknown", note: "process_next_asset_failed" }, error);
      return null;
    });
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

main().catch(async (error) => {
  emitSafetyEvent({ event: "community_transcode_worker_fatal", errorClass: "unknown", note: "worker_main_fatal" }, error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
