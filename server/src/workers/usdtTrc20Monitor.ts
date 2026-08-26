import { PrismaClient } from "@prisma/client";
import { loadUsdtMonitorConfig, nextMonitorDelayMs, runUsdtMonitorCycle } from "../services/usdtMonitor.js";
import { emitSafetyEvent, emitStructuredLog } from "../utils/structuredError.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let cfg;
  try {
    cfg = loadUsdtMonitorConfig(process.env);
  } catch (err: unknown) {
    // Configuration and database libraries can embed addresses, connection
    // strings, or schema details in their raw messages. Keep the supervisor
    // log classifiable without ever relaying that text.
    emitSafetyEvent({
      event: "usdt_monitor_startup_aborted",
      errorClass: "business",
      note: "invalid_monitor_configuration",
    }, err);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    errorFormat: "minimal",
  });

  try {
    await prisma.$connect();
    emitStructuredLog({
      event: "usdt_monitor_started",
      errorClass: "business",
      note: "monitor_ready",
      counts: { pollIntervalMs: cfg.pollIntervalMs },
    });

    while (true) {
      const result = await runUsdtMonitorCycle(prisma, cfg, fetch, new Date());
      const failures = result.ok
        ? 0
        : (await (prisma as any).usdtMonitorRuntimeState.findUnique({ where: { workerName: cfg.workerName } }))?.consecutiveFailures ?? 1;
      await sleep(nextMonitorDelayMs(cfg, failures));
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err: unknown) => {
  emitSafetyEvent({
    event: "usdt_monitor_fatal",
    errorClass: "unknown",
    note: "monitor_stopped_unexpectedly",
  }, err);
  process.exit(1);
});
