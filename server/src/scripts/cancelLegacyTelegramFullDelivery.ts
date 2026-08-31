/**
 * One-time, idempotent release cleanup.
 *
 * Complete videos are delivered by Samewave controlled playback. Cancel only
 * unsent legacy Telegram full-video jobs; successful historical messages and
 * free-entry promotion jobs are deliberately left untouched.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  const result = await prisma.telegramPublishJob.updateMany({
    where: {
      channelKind: { in: ["membership_full", "package_full"] },
      status: { in: ["queued", "failed", "processing"] },
      sentAt: null,
    },
    data: {
      status: "cancelled",
      cancelledAt: now,
      lastErrorClass: "legacy_full_video_delivery_disabled",
      lastErrorNote: "full_video_delivered_by_platform_playback",
      nextRetryAt: null,
    },
  });
  process.stdout.write(JSON.stringify({ ok: true, cancelled: result.count }) + "\n");
}

main()
  .catch((error) => {
    process.stderr.write(`legacy_delivery_cleanup_failed: ${error instanceof Error ? error.name : "unknown"}\n`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
