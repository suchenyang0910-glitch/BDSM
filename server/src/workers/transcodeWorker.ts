import { PrismaClient } from "@prisma/client";
import { emitSafetyEvent } from "../utils/structuredError.js";

import {
  claimNextTranscodeJob,
  createTranscodeRunner,
  loadTranscodeWorkerConfig,
  processClaimedTranscodeJob,
  requeueExpiredTranscodeJobs,
  sleep,
} from "../services/transcodeWorker.js";

async function main() {
  const cfg = loadTranscodeWorkerConfig(process.env);
  if (!cfg.enabled) {
    console.log(`[transcode-worker] disabled worker=${cfg.workerId}`);
    return;
  }

  const prisma = new PrismaClient({ errorFormat: "minimal" });
  const runner = createTranscodeRunner(cfg);

  try {
    await prisma.$connect();
    console.log(`[transcode-worker] started worker=${cfg.workerId} poll=${cfg.pollIntervalMs}ms lease=${cfg.leaseSeconds}s`);
    while (true) {
      await requeueExpiredTranscodeJobs(prisma, { maxAttempts: cfg.maxAttempts }, new Date());
      const job = await claimNextTranscodeJob(prisma, { workerId: cfg.workerId, leaseSeconds: cfg.leaseSeconds }, new Date());
      if (job) {
        const result = await processClaimedTranscodeJob(prisma, { job, cfg, runner });
        console.log(`[transcode-worker] job=${result.jobId} content=${result.contentId} asset=${result.assetId} ok=${result.ok} err=${result.errorClass || "none"}`);
      } else {
        await sleep(cfg.pollIntervalMs);
      }
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  emitSafetyEvent(
    {
      event: "transcode_worker_fatal",
      errorClass: "unknown",
      retryHint: 0,
      note: "worker_main_fatal",
    },
    err,
  );
  process.exit(1);
});
