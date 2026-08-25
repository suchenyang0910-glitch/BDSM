import type { PrismaClient } from "@prisma/client";
import { abortPrivateMultipartUpload } from "./objectStorage.js";
import { emitSafetyEvent, emitStructuredLog } from "../utils/structuredError.js";

const DEFAULT_UPLOAD_SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 1000;
const SWEEP_BATCH_SIZE = 50;

export type UploadSessionCleanupResult = {
  scanned: number;
  expired: number;
  aborted: number;
  failed: number;
  ranAt: string;
};

export async function runUploadSessionCleanupSweep(prisma: PrismaClient): Promise<UploadSessionCleanupResult> {
  const now = new Date();
  const result: UploadSessionCleanupResult = {
    scanned: 0,
    expired: 0,
    aborted: 0,
    failed: 0,
    ranAt: now.toISOString(),
  };
  const client = prisma as any;
  const sessions = await client.uploadSession.findMany({
    where: {
      status: { notIn: ["completed", "cancelled", "expired"] },
      expiresAt: { lt: now },
    },
    orderBy: [{ expiresAt: "asc" }],
    take: SWEEP_BATCH_SIZE,
  });

  for (const session of sessions) {
    result.scanned += 1;
    try {
      if (session.storageUploadId && session.assetKind === "full_source") {
        await abortPrivateMultipartUpload(session.objectKey, session.storageUploadId);
        result.aborted += 1;
      }
      await client.uploadSession.update({
        where: { id: session.id },
        data: {
          status: "expired",
          lastActivityAt: now,
        },
      });
      result.expired += 1;
    } catch (error) {
      result.failed += 1;
      emitSafetyEvent(
        {
          event: "upload_session_cleanup_failed",
          errorClass: "unknown",
          retryHint: 1,
          note: `session=${session.id}`,
        },
        error,
      );
    }
  }

  emitStructuredLog({
    event: "upload_session_cleanup_sweep_done",
    errorClass: result.failed > 0 ? "db_error" : "business",
    retryHint: 0,
    note: result.failed > 0 ? "upload_session_cleanup_with_failures" : "upload_session_cleanup_ok",
    counts: {
      scanned: result.scanned,
      expired: result.expired,
      aborted: result.aborted,
      failed: result.failed,
    },
  });

  return result;
}

export function startUploadSessionCleanupCron(
  prisma: PrismaClient,
  opts?: { intervalMs?: number; runOnStart?: boolean },
): { stop: () => void; runOnce: () => Promise<UploadSessionCleanupResult> } {
  const intervalMs = Math.max(
    60 * 1000,
    Number.isFinite(opts?.intervalMs) ? Number(opts?.intervalMs) : DEFAULT_UPLOAD_SESSION_CLEANUP_INTERVAL_MS,
  );
  let stopped = false;
  const runOnce = () => runUploadSessionCleanupSweep(prisma).catch((error) => {
    emitSafetyEvent(
      {
        event: "upload_session_cleanup_run_once_unhandled",
        errorClass: "unknown",
        retryHint: 1,
        note: "upload_session_cleanup_run_once_unhandled",
      },
      error,
    );
    return {
      scanned: 0,
      expired: 0,
      aborted: 0,
      failed: 1,
      ranAt: new Date().toISOString(),
    };
  });

  if (opts?.runOnStart !== false) {
    setTimeout(() => {
      if (!stopped) void runOnce();
    }, INITIAL_DELAY_MS);
  }

  const timer = setInterval(() => {
    if (!stopped) void runOnce();
  }, intervalMs);
  try { (timer as any).unref?.(); } catch {}

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    runOnce,
  };
}
