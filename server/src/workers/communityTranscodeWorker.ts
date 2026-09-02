import { PrismaClient } from "@prisma/client";
import { loadCommunityMediaConfig, processNextCommunityVideoAsset } from "../services/communityMedia.js";

const prisma = new PrismaClient();
const cfg = loadCommunityMediaConfig();
const pollIntervalMs = Math.min(Math.max(Number.parseInt(String(process.env.COMMUNITY_TRANSCODE_POLL_INTERVAL_MS || "10000"), 10) || 10_000, 1_000), 60_000);

async function main() {
  for (;;) {
    const processed = await processNextCommunityVideoAsset(prisma, cfg).catch(() => null);
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

main().catch(async (error) => {
  console.error("[communityTranscodeWorker] fatal", error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
