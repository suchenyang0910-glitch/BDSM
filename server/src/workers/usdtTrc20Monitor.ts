import { PrismaClient } from "@prisma/client";
import { loadUsdtMonitorConfig, nextMonitorDelayMs, runUsdtMonitorCycle } from "../services/usdtMonitor.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let cfg;
  try {
    cfg = loadUsdtMonitorConfig(process.env);
  } catch (err: any) {
    console.error(`[usdt-monitor] startup aborted: ${err?.message || "invalid configuration"}`);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    errorFormat: "minimal",
  });

  try {
    await prisma.$connect();
    console.log(`[usdt-monitor] started worker=${cfg.workerName} poll=${cfg.pollIntervalMs}ms`);

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

main().catch((err) => {
  console.error(`[usdt-monitor] fatal: ${err?.message || "unknown_error"}`);
  process.exit(1);
});
