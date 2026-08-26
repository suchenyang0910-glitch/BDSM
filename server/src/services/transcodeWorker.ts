import { PrismaClient, type TranscodeJob, type VideoAsset } from "@prisma/client";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";

import { emitSafetyEvent } from "../utils/structuredError.js";
import { getS3Client, headObject, requireObjectStorageEnv } from "./objectStorage.js";

const TRANSCODE_ERROR_CLASSES = new Set([
  "source_not_found",
  "source_head_mismatch",
  "source_download_failed",
  "source_invalid_media",
  "ffprobe_timeout",
  "ffmpeg_timeout",
  "ffmpeg_failed",
  "output_manifest_invalid",
  "output_segment_missing",
  "output_upload_failed",
  "output_verify_failed",
  "job_cancelled",
  "worker_exhausted",
  "unknown",
] as const);

const DEFAULT_RENDITION_TARGETS = [
  { kind: "hls_1080" as const, maxHeight: 1080, bitrateKbps: 5500 },
  { kind: "hls_720" as const, maxHeight: 720, bitrateKbps: 2500 },
  { kind: "hls_480" as const, maxHeight: 480, bitrateKbps: 1200 },
];

export type TranscodeErrorClass = typeof TRANSCODE_ERROR_CLASSES extends Set<infer T> ? T : never;
export type VideoRenditionKind = "preview" | "hls_1080" | "hls_720" | "hls_480";
export type VideoRenditionStatus = "pending" | "processing" | "ready" | "failed" | "deleted";

export type TranscodeWorkerConfig = {
  enabled: boolean;
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseSeconds: number;
  maxAttempts: number;
  previewSeconds: number;
  tmpDir: string;
  ffprobePath: string;
  ffmpegPath: string;
  ffprobeTimeoutMs: number;
  ffmpegTimeoutMs: number;
  runnerMode: "ffmpeg" | "mock";
};

export type SourceProbe = {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

export type RenditionPlan = {
  kind: VideoRenditionKind;
  width: number;
  height: number;
  bitrateKbps: number;
  durationSeconds: number;
  manifestPath: string;
  prefixPath: string;
  segmentCount: number;
};

export type RenderOutput = {
  probe: SourceProbe;
  renditions: RenditionPlan[];
  masterManifestPath?: string | null;
};

export type TranscodeRunner = {
  probe(input: { inputPath: string; timeoutMs: number }): Promise<SourceProbe>;
  render(input: {
    inputPath: string;
    workDir: string;
    previewSeconds: number;
    previewEnabled?: boolean;
    timeoutMs: number;
  }): Promise<RenderOutput>;
};

export type ClaimedTranscodeJob = TranscodeJob & {
  asset: VideoAsset;
};

export type ProcessTranscodeResult = {
  ok: boolean;
  jobId: string;
  contentId: string;
  assetId: string;
  errorClass?: string;
  renditions?: Array<{ kind: VideoRenditionKind; status: VideoRenditionStatus }>;
};

type TaggedTranscodeError = Error & {
  transcodeErrorClass?: string;
};

type LocalRenditionSummary = {
  segmentCount: number;
  byteSize: bigint;
  manifestName: string;
};

type UploadedObject = {
  key: string;
  size: bigint;
};

type RenditionTarget = {
  kind: VideoRenditionKind;
  width: number;
  height: number;
  bitrateKbps: number;
  durationSeconds: number;
};

export function sanitizeTranscodeErrorClass(input: string | null | undefined): string | null {
  if (!input) return null;
  const normalized = String(input).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
  return TRANSCODE_ERROR_CLASSES.has(normalized as any) ? normalized : "unknown";
}

export function loadTranscodeWorkerConfig(env: NodeJS.ProcessEnv = process.env): TranscodeWorkerConfig {
  const enabled = String(env.TRANSCODE_WORKER_ENABLED || "false").trim().toLowerCase() === "true";
  const concurrency = 1;
  const pollIntervalMs = clampInt(env.TRANSCODE_POLL_INTERVAL_MS, 5_000, 1_000, 60_000);
  const leaseSeconds = clampInt(env.TRANSCODE_LEASE_SECONDS, 1_800, 120, 7_200);
  const maxAttempts = clampInt(env.TRANSCODE_MAX_ATTEMPTS, 3, 1, 10);
  const previewSeconds = clampInt(env.TRANSCODE_PREVIEW_SECONDS, 60, 30, 90);
  const tmpDir = String(env.TRANSCODE_TMP_DIR || path.join(os.tmpdir(), "intune-transcode")).trim();
  const workerId = String(env.TRANSCODE_WORKER_ID || `transcode-${randomUUID().slice(0, 8)}`).trim().slice(0, 64);
  const ffprobePath = String(env.TRANSCODE_FFPROBE_PATH || "ffprobe").trim();
  const ffmpegPath = String(env.TRANSCODE_FFMPEG_PATH || "ffmpeg").trim();
  const ffprobeTimeoutMs = clampInt(env.TRANSCODE_FFPROBE_TIMEOUT_MS, 60_000, 5_000, 300_000);
  const ffmpegTimeoutMs = clampInt(env.TRANSCODE_FFMPEG_TIMEOUT_MS, 3_600_000, 30_000, 10 * 3_600_000);
  const runnerMode = String(env.TRANSCODE_RUNNER || "ffmpeg").trim().toLowerCase() === "mock" ? "mock" : "ffmpeg";
  return {
    enabled,
    workerId,
    concurrency,
    pollIntervalMs,
    leaseSeconds,
    maxAttempts,
    previewSeconds,
    tmpDir,
    ffprobePath,
    ffmpegPath,
    ffprobeTimeoutMs,
    ffmpegTimeoutMs,
    runnerMode,
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildRenditionPrefix(asset: Pick<VideoAsset, "contentId" | "id">, kind: VideoRenditionKind) {
  return `hls/${asset.contentId}/${asset.id}/${kind}`;
}

export function buildHlsAssetRootPrefix(asset: Pick<VideoAsset, "contentId" | "id">) {
  return `hls/${asset.contentId}/${asset.id}`;
}

export function buildHlsTempRootPrefix(job: Pick<TranscodeJob, "id" | "contentId" | "assetId">) {
  return `hls-tmp/${job.contentId}/${job.assetId}/${job.id}`;
}

export async function claimNextTranscodeJob(
  prisma: PrismaClient,
  cfg: Pick<TranscodeWorkerConfig, "workerId" | "leaseSeconds">,
  now = new Date(),
): Promise<ClaimedTranscodeJob | null> {
  const transcodeJob = (prisma as any).transcodeJob;
  const candidate = await transcodeJob.findFirst({
    where: {
      status: "queued",
      asset: {
        status: "verified",
        kind: "full_source",
        deletedAt: null,
      },
    },
    include: { asset: true },
    orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
  });
  if (!candidate) return null;
  const leaseUntil = new Date(now.getTime() + cfg.leaseSeconds * 1000);
  const updated = await transcodeJob.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: {
      status: "processing",
      workerId: cfg.workerId,
      leaseUntil,
      lastHeartbeatAt: now,
      startedAt: candidate.startedAt ?? now,
      finishedAt: null,
      progressPercent: 1,
      attemptCount: { increment: 1 } as any,
      errorClass: null,
    },
  });
  if (updated.count !== 1) return null;
  return transcodeJob.findUnique({
    where: { id: candidate.id },
    include: { asset: true },
  }) as any;
}

export async function heartbeatTranscodeJob(
  prisma: PrismaClient,
  input: { jobId: string; workerId: string; progressPercent?: number; leaseSeconds: number },
  now = new Date(),
) {
  const transcodeJob = (prisma as any).transcodeJob;
  const progress = Math.max(0, Math.min(100, Math.floor(input.progressPercent ?? 0)));
  const leaseUntil = new Date(now.getTime() + input.leaseSeconds * 1000);
  await transcodeJob.updateMany({
    where: { id: input.jobId, workerId: input.workerId, status: "processing" },
    data: {
      lastHeartbeatAt: now,
      leaseUntil,
      progressPercent: progress,
    },
  });
}

export async function requeueExpiredTranscodeJobs(
  prisma: PrismaClient,
  cfg: Pick<TranscodeWorkerConfig, "maxAttempts">,
  now = new Date(),
) {
  const transcodeJob = (prisma as any).transcodeJob;
  const rows = await transcodeJob.findMany({
    where: {
      status: "processing",
      leaseUntil: { lt: now },
    },
    select: { id: true, attemptCount: true },
  });
  let requeued = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.attemptCount >= cfg.maxAttempts) {
      await transcodeJob.update({
        where: { id: row.id },
        data: {
          status: "failed",
          errorClass: "worker_exhausted",
          finishedAt: now,
          progressPercent: 0,
          workerId: null,
          leaseUntil: null,
          lastHeartbeatAt: now,
        },
      });
      failed += 1;
      continue;
    }
    await transcodeJob.update({
      where: { id: row.id },
      data: {
        status: "queued",
        workerId: null,
        leaseUntil: null,
        lastHeartbeatAt: now,
        progressPercent: 0,
        errorClass: null,
        queuedAt: now,
        finishedAt: null,
      },
    });
    requeued += 1;
  }
  return { requeued, failed };
}

export async function cancelTranscodeJobWrite(prisma: PrismaClient, jobId: string, now = new Date()) {
  await (prisma as any).transcodeJob.update({
    where: { id: jobId },
    data: {
      status: "cancelled",
      errorClass: "job_cancelled",
      finishedAt: now,
      workerId: null,
      leaseUntil: null,
      progressPercent: 0,
      lastHeartbeatAt: now,
    },
  });
}

export async function markTranscodeJobFailed(
  prisma: PrismaClient,
  input: { jobId: string; errorClass: string; maxAttempts: number },
  now = new Date(),
) {
  const transcodeJob = (prisma as any).transcodeJob;
  const job = await transcodeJob.findUnique({ where: { id: input.jobId } });
  if (!job) return null;
  const safeError = sanitizeTranscodeErrorClass(input.errorClass) || "unknown";
  const shouldRequeue = safeError !== "job_cancelled" && job.attemptCount < input.maxAttempts;
  await transcodeJob.update({
    where: { id: input.jobId },
    data: shouldRequeue
      ? {
          status: "queued",
          errorClass: safeError,
          workerId: null,
          leaseUntil: null,
          progressPercent: 0,
          queuedAt: now,
          lastHeartbeatAt: now,
        }
      : {
          status: safeError === "job_cancelled" ? "cancelled" : "failed",
          errorClass: safeError,
          workerId: null,
          leaseUntil: null,
          progressPercent: 0,
          finishedAt: now,
          lastHeartbeatAt: now,
        },
  });
  return { requeued: shouldRequeue, errorClass: safeError };
}

export async function markTranscodeJobReady(
  prisma: PrismaClient,
  input: { jobId: string },
  now = new Date(),
) {
  await (prisma as any).transcodeJob.update({
    where: { id: input.jobId },
    data: {
      status: "ready",
      workerId: null,
      leaseUntil: null,
      lastHeartbeatAt: now,
      finishedAt: now,
      progressPercent: 100,
      errorClass: null,
    },
  });
}

export async function upsertVideoRenditions(
  prisma: PrismaClient,
  input: {
    contentId: string;
    assetId: string;
    renditions: Array<{
      kind: VideoRenditionKind;
      status: VideoRenditionStatus;
      manifestKey?: string | null;
      prefixKey?: string | null;
      width?: number | null;
      height?: number | null;
      bitrateKbps?: number | null;
      durationSeconds?: number | null;
      segmentCount?: number | null;
      byteSize?: bigint | null;
      errorClass?: string | null;
      readyAt?: Date | null;
    }>;
  },
) {
  const videoRendition = (prisma as any).videoRendition;
  for (const row of input.renditions) {
    await videoRendition.upsert({
      where: { assetId_kind: { assetId: input.assetId, kind: row.kind } },
      update: {
        status: row.status,
        manifestKey: row.manifestKey ?? null,
        prefixKey: row.prefixKey ?? null,
        width: row.width ?? null,
        height: row.height ?? null,
        bitrateKbps: row.bitrateKbps ?? null,
        durationSeconds: row.durationSeconds ?? null,
        segmentCount: row.segmentCount ?? null,
        byteSize: row.byteSize ?? null,
        errorClass: sanitizeTranscodeErrorClass(row.errorClass) || null,
        readyAt: row.readyAt ?? null,
      },
      create: {
        contentId: input.contentId,
        assetId: input.assetId,
        kind: row.kind,
        status: row.status,
        manifestKey: row.manifestKey ?? null,
        prefixKey: row.prefixKey ?? null,
        width: row.width ?? null,
        height: row.height ?? null,
        bitrateKbps: row.bitrateKbps ?? null,
        durationSeconds: row.durationSeconds ?? null,
        segmentCount: row.segmentCount ?? null,
        byteSize: row.byteSize ?? null,
        errorClass: sanitizeTranscodeErrorClass(row.errorClass) || null,
        readyAt: row.readyAt ?? null,
      },
    });
  }
}

export async function markPendingRenditionsProcessing(
  prisma: PrismaClient,
  input: { contentId: string; assetId: string; kinds: VideoRenditionKind[] },
) {
  const videoRendition = (prisma as any).videoRendition;
  for (const kind of input.kinds) {
    await videoRendition.upsert({
      where: { assetId_kind: { assetId: input.assetId, kind } },
      update: { status: "processing", errorClass: null, readyAt: null },
      create: {
        contentId: input.contentId,
        assetId: input.assetId,
        kind,
        status: "processing",
      },
    });
  }
}

export async function markRenditionsFailed(
  prisma: PrismaClient,
  input: { contentId: string; assetId: string; kinds: VideoRenditionKind[]; errorClass: string },
) {
  const safeError = sanitizeTranscodeErrorClass(input.errorClass) || "unknown";
  await upsertVideoRenditions(prisma, {
    contentId: input.contentId,
    assetId: input.assetId,
    renditions: input.kinds.map((kind) => ({
      kind,
      status: safeError === "job_cancelled" ? "failed" : "failed",
      errorClass: safeError,
      readyAt: null,
    })),
  });
}

export async function ensureTranscodeTmpDir(tmpDir: string) {
  await mkdir(tmpDir, { recursive: true });
}

export async function createJobWorkDir(tmpDir: string, jobId: string) {
  await ensureTranscodeTmpDir(tmpDir);
  return mkdtemp(path.join(tmpDir, `${jobId}-`));
}

export async function cleanupJobWorkDir(dirPath: string) {
  await rm(dirPath, { recursive: true, force: true });
}

export async function assertJobNotCancelled(prisma: PrismaClient, jobId: string) {
  const row = await (prisma as any).transcodeJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (!row || row.status === "cancelled") {
    throw taggedError("job_cancelled");
  }
}

export async function downloadSourceObjectToFile(asset: Pick<VideoAsset, "objectKey">, outputPath: string) {
  const storageEnv = requireObjectStorageEnv();
  const verify = await headObject(storageEnv.bucket, asset.objectKey);
  if (!verify.ok || !verify.head) {
    throw taggedError("source_not_found");
  }
  const s3 = getS3Client();
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: storageEnv.bucket,
      Key: asset.objectKey,
    }));
    const body = response.Body as any;
    if (!body) throw taggedError("source_download_failed");
    await pipeline(body, createWriteStream(outputPath));
    return verify.head;
  } catch (error) {
    if ((error as TaggedTranscodeError)?.transcodeErrorClass) throw error;
    throw taggedError("source_download_failed");
  }
}

export function buildRenditionTargets(probe: SourceProbe, previewSeconds: number, previewEnabled = true): RenditionTarget[] {
  const targets: RenditionTarget[] = [];
  if (previewEnabled) {
    const previewScale = scaleDimensions(probe.width, probe.height, Math.min(480, probe.height));
    targets.push({
      kind: "preview",
      width: previewScale.width,
      height: previewScale.height,
      bitrateKbps: Math.min(900, Math.max(500, Math.round((previewScale.height / 480) * 900))),
      durationSeconds: Math.min(Math.max(1, Math.floor(probe.durationSeconds || previewSeconds)), previewSeconds),
    });
  }
  for (const target of DEFAULT_RENDITION_TARGETS) {
    if (target.kind !== "hls_480" && probe.height < target.maxHeight) continue;
    const scaled = scaleDimensions(probe.width, probe.height, Math.min(target.maxHeight, probe.height));
    targets.push({
      kind: target.kind,
      width: scaled.width,
      height: scaled.height,
      bitrateKbps: target.bitrateKbps,
      durationSeconds: Math.max(1, Math.floor(probe.durationSeconds || 1)),
    });
  }
  return targets;
}

function scaleDimensions(sourceWidth: number, sourceHeight: number, targetMaxHeight: number) {
  const safeSourceWidth = Math.max(2, sourceWidth);
  const safeSourceHeight = Math.max(2, sourceHeight);
  const effectiveHeight = Math.max(2, Math.min(safeSourceHeight, targetMaxHeight));
  const ratio = effectiveHeight / safeSourceHeight;
  let width = Math.max(2, Math.floor((safeSourceWidth * ratio) / 2) * 2);
  let height = Math.max(2, Math.floor(effectiveHeight / 2) * 2);
  if (width > safeSourceWidth) width = Math.max(2, Math.floor(safeSourceWidth / 2) * 2);
  if (height > safeSourceHeight) height = Math.max(2, Math.floor(safeSourceHeight / 2) * 2);
  return { width, height };
}

function taggedError(errorClass: string, message?: string): TaggedTranscodeError {
  const err = new Error(message || errorClass) as TaggedTranscodeError;
  err.transcodeErrorClass = sanitizeTranscodeErrorClass(errorClass) || "unknown";
  return err;
}

async function runProcess(command: string, args: string[], input: { timeoutMs: number; cwd?: string }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(taggedError(command.includes("ffprobe") ? "ffprobe_timeout" : "ffmpeg_timeout"));
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(taggedError(command.includes("ffprobe") ? "unknown" : "unknown"));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(taggedError(command.includes("ffprobe") ? "source_invalid_media" : "ffmpeg_failed"));
    });
  });
}

export function createFfmpegTranscodeRunner(cfg: Pick<TranscodeWorkerConfig, "ffprobePath" | "ffmpegPath" | "ffprobeTimeoutMs" | "ffmpegTimeoutMs">): TranscodeRunner {
  return {
    async probe(input) {
      const { stdout } = await runProcess(cfg.ffprobePath, [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        input.inputPath,
      ], {
        timeoutMs: input.timeoutMs || cfg.ffprobeTimeoutMs,
      });
      try {
        const parsed = JSON.parse(stdout || "{}");
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const videoStream = streams.find((stream: any) => stream.codec_type === "video");
        if (!videoStream) throw taggedError("source_invalid_media");
        const audioStream = streams.find((stream: any) => stream.codec_type === "audio");
        const width = Number(videoStream.width || 0);
        const height = Number(videoStream.height || 0);
        const durationRaw = Number(parsed.format?.duration || videoStream.duration || 0);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isFinite(durationRaw) || durationRaw <= 0) {
          throw taggedError("source_invalid_media");
        }
        return {
          durationSeconds: Math.max(1, Math.round(durationRaw)),
          width,
          height,
          hasAudio: !!audioStream,
        };
      } catch (error) {
        if ((error as TaggedTranscodeError)?.transcodeErrorClass) throw error;
        throw taggedError("source_invalid_media");
      }
    },
    async render(input) {
      const probe = await this.probe({ inputPath: input.inputPath, timeoutMs: cfg.ffprobeTimeoutMs });
      const targets = buildRenditionTargets(probe, input.previewSeconds, input.previewEnabled !== false);
      const renditions: RenditionPlan[] = [];
      for (const target of targets) {
        const dir = path.join(input.workDir, target.kind);
        await mkdir(dir, { recursive: true });
        const manifestPath = path.join(dir, "index.m3u8");
        const segmentPattern = "segment_%03d.m4s";
        const manifestOutputName = "index.m3u8";
        const args = [
          "-y",
          "-v",
          "error",
          "-i",
          input.inputPath,
          "-map",
          "0:v:0",
        ];
        if (probe.hasAudio) {
          args.push("-map", "0:a:0?");
        } else {
          args.push("-an");
        }
        if (target.kind === "preview") {
          args.push("-t", String(target.durationSeconds));
        }
        args.push(
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-vf",
          `scale=${target.width}:${target.height}`,
          "-b:v",
          `${target.bitrateKbps}k`,
          "-maxrate",
          `${Math.round(target.bitrateKbps * 1.15)}k`,
          "-bufsize",
          `${Math.round(target.bitrateKbps * 2)}k`,
          "-g",
          "48",
          "-keyint_min",
          "48",
          "-sc_threshold",
          "0",
        );
        if (probe.hasAudio) {
          args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
        }
        args.push(
          "-f",
          "hls",
          "-hls_time",
          "4",
          "-hls_playlist_type",
          "vod",
          "-hls_segment_type",
          "fmp4",
          "-hls_fmp4_init_filename",
          "init.mp4",
          "-hls_flags",
          "independent_segments",
          "-hls_segment_filename",
          segmentPattern,
          manifestOutputName,
        );
        await runProcess(cfg.ffmpegPath, args, {
          timeoutMs: input.timeoutMs || cfg.ffmpegTimeoutMs,
          cwd: dir,
        });
        const local = await inspectLocalRendition({
          kind: target.kind,
          width: target.width,
          height: target.height,
          bitrateKbps: target.bitrateKbps,
          durationSeconds: target.durationSeconds,
          manifestPath,
          prefixPath: dir,
          segmentCount: 0,
        });
        renditions.push({
          kind: target.kind,
          width: target.width,
          height: target.height,
          bitrateKbps: target.bitrateKbps,
          durationSeconds: target.durationSeconds,
          manifestPath,
          prefixPath: dir,
          segmentCount: local.segmentCount,
        });
      }
      const fullRenditions = renditions.filter((item) => item.kind !== "preview");
      const masterManifestPath = fullRenditions.length > 0
        ? await writeMasterManifest(input.workDir, fullRenditions)
        : null;
      return { probe, renditions, masterManifestPath };
    },
  };
}

export async function inspectLocalRendition(rendition: RenditionPlan): Promise<LocalRenditionSummary> {
  const manifestName = path.basename(rendition.manifestPath);
  const manifestText = await readFile(rendition.manifestPath, "utf8").catch(() => {
    throw taggedError("output_manifest_invalid");
  });
  if (!manifestText.includes("#EXTM3U")) {
    throw taggedError("output_manifest_invalid");
  }
  const referencedFiles = new Set<string>();
  for (const line of manifestText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const mapMatch = trimmed.match(/URI="([^"]+)"/);
    if (mapMatch?.[1]) referencedFiles.add(mapMatch[1]);
    if (!trimmed.startsWith("#")) referencedFiles.add(trimmed);
  }
  let segmentCount = 0;
  let byteSize = 0n;
  const files = await readdir(rendition.prefixPath, { withFileTypes: true });
  const fileNames = new Set(files.filter((item) => item.isFile()).map((item) => item.name));
  for (const file of referencedFiles) {
    if (!fileNames.has(file)) throw taggedError("output_segment_missing");
    const fileStat = await stat(path.join(rendition.prefixPath, file));
    byteSize += BigInt(fileStat.size);
    if (/\.(m4s|ts)$/i.test(file)) segmentCount += 1;
  }
  const manifestStat = await stat(rendition.manifestPath);
  byteSize += BigInt(manifestStat.size);
  if (segmentCount <= 0) throw taggedError("output_segment_missing");
  return { segmentCount, byteSize, manifestName };
}

async function writeMasterManifest(workDir: string, renditions: RenditionPlan[]) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  for (const rendition of renditions) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bitrateKbps * 1000},RESOLUTION=${rendition.width}x${rendition.height}`,
      `${rendition.kind}/index.m3u8`,
    );
  }
  const manifestPath = path.join(workDir, "master.m3u8");
  await writeFile(manifestPath, `${lines.join("\n")}\n`);
  return manifestPath;
}

function isAllowedTranscodePrefixKey(prefixKey: string) {
  return /^(hls|hls-tmp)\/[0-9a-z-]+\/[0-9a-z-]+(?:\/[0-9a-z-]+)?(?:\/[a-z0-9_-]+)?$/i.test(prefixKey);
}

export async function uploadDirectoryAsPrivatePrefix(input: {
  localDir: string;
  prefixKey: string;
}) {
  if (!isAllowedTranscodePrefixKey(input.prefixKey)) {
    throw taggedError("output_upload_failed");
  }
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  const uploaded: UploadedObject[] = [];
  const walk = async (dirPath: string) => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const relative = path.relative(input.localDir, absolute).replace(/\\/g, "/");
      const key = `${input.prefixKey}/${relative}`;
      const body = await readFile(absolute);
      const stats = await stat(absolute);
      try {
        await s3.send(new PutObjectCommand({
          Bucket: env.bucket,
          Key: key,
          Body: body,
          ContentType: inferManifestContentType(entry.name),
        }));
      } catch {
        throw taggedError("output_upload_failed");
      }
      uploaded.push({ key, size: BigInt(stats.size) });
    }
  };
  await walk(input.localDir);
  return uploaded;
}

export async function uploadFileToPrivateKey(input: { localPath: string; key: string }) {
  if (!/^hls(?:-tmp)?\/[0-9a-z-]+\/[0-9a-z-]+(?:\/[0-9a-z-]+)?\/[a-z0-9._-]+$/i.test(input.key)) {
    throw taggedError("output_upload_failed");
  }
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  const body = await readFile(input.localPath);
  try {
    await s3.send(new PutObjectCommand({
      Bucket: env.bucket,
      Key: input.key,
      Body: body,
      ContentType: inferManifestContentType(path.basename(input.key)),
    }));
  } catch {
    throw taggedError("output_upload_failed");
  }
  const fileStat = await stat(input.localPath);
  return { key: input.key, size: BigInt(fileStat.size) };
}

function inferManifestContentType(name: string) {
  if (name.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (name.endsWith(".m4s")) return "video/iso.segment";
  if (name.endsWith(".ts")) return "video/mp2t";
  if (name.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

export async function verifyUploadedObjects(keys: string[]) {
  const env = requireObjectStorageEnv();
  for (const key of keys) {
    const result = await headObject(env.bucket, key);
    if (!result.ok || !result.head) {
      throw taggedError("output_verify_failed");
    }
  }
}

export async function deletePrefixSafe(prefixKey: string) {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  try {
    let continuationToken: string | undefined;
    while (true) {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: env.bucket,
        Prefix: `${prefixKey}/`,
        ContinuationToken: continuationToken,
      }));
      const objects = (list.Contents || []).map((row) => row.Key).filter(Boolean) as string[];
      if (objects.length > 0) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: env.bucket,
          Delete: { Objects: objects.map((key) => ({ Key: key })) },
        }));
      }
      if (!list.IsTruncated || !list.NextContinuationToken) break;
      continuationToken = list.NextContinuationToken;
    }
  } catch (error) {
    emitSafetyEvent({
      event: "transcode_output_prefix_delete_failed",
      errorClass: "unknown",
      note: `prefix_len=${prefixKey.length}`,
      retryHint: 1,
    }, error);
  }
}

function mapFailureToErrorClass(error: unknown): string {
  const fromTagged = sanitizeTranscodeErrorClass((error as TaggedTranscodeError)?.transcodeErrorClass);
  if (fromTagged) return fromTagged;
  return "unknown";
}

export async function processClaimedTranscodeJob(
  prisma: PrismaClient,
  input: {
    job: ClaimedTranscodeJob;
    cfg: TranscodeWorkerConfig;
    runner: TranscodeRunner;
  },
): Promise<ProcessTranscodeResult> {
  const { job, cfg, runner } = input;
  const tmpRootPrefix = buildHlsTempRootPrefix(job);
  const finalRootPrefix = buildHlsAssetRootPrefix(job.asset);
  let workDir = "";
  let plannedKinds: VideoRenditionKind[] = [];
  try {
    await assertJobNotCancelled(prisma, job.id);
    workDir = await createJobWorkDir(cfg.tmpDir, job.id);
    const sourcePath = path.join(workDir, "source.mp4");

    await heartbeatTranscodeJob(prisma, { jobId: job.id, workerId: cfg.workerId, leaseSeconds: cfg.leaseSeconds, progressPercent: 5 });
    const sourceHead = await downloadSourceObjectToFile(job.asset, sourcePath);
    const sourceLength = typeof sourceHead.ContentLength === "number" ? BigInt(sourceHead.ContentLength) : null;
    if (sourceLength != null && sourceLength !== job.asset.byteSize) {
      throw taggedError("source_head_mismatch");
    }

    await heartbeatTranscodeJob(prisma, { jobId: job.id, workerId: cfg.workerId, leaseSeconds: cfg.leaseSeconds, progressPercent: 15 });
    const probe = await runner.probe({ inputPath: sourcePath, timeoutMs: cfg.ffprobeTimeoutMs });
    // 转码探测出的时长是源视频的权威元数据。回填 Content，避免用户端显示 “--:--”。
    await (prisma as any).content.update({
      where: { id: job.contentId },
      data: { durationSeconds: probe.durationSeconds },
    });
    const contentSettings = await (prisma as any).content.findUnique({
      where: { id: job.contentId },
      select: { previewEnabled: true, previewDurationSeconds: true },
    });
    const previewEnabled = contentSettings?.previewEnabled !== false;
    const previewSeconds = clampInt(
      contentSettings?.previewDurationSeconds != null ? String(contentSettings.previewDurationSeconds) : undefined,
      cfg.previewSeconds,
      30,
      90,
    );
    const expectedKinds = buildRenditionTargets(probe, previewSeconds, previewEnabled).map((row) => row.kind);
    plannedKinds = Array.from(new Set(expectedKinds));
    if (plannedKinds.length > 0) {
      await markPendingRenditionsProcessing(prisma, { contentId: job.contentId, assetId: job.assetId, kinds: plannedKinds });
    }

    await assertJobNotCancelled(prisma, job.id);
    await heartbeatTranscodeJob(prisma, { jobId: job.id, workerId: cfg.workerId, leaseSeconds: cfg.leaseSeconds, progressPercent: 35 });
    const rendered = await runner.render({
      inputPath: sourcePath,
      workDir,
      previewSeconds,
      previewEnabled,
      timeoutMs: cfg.ffmpegTimeoutMs,
    });
    if (!Array.isArray(rendered.renditions) || rendered.renditions.length === 0) {
      throw taggedError("output_manifest_invalid");
    }
    if (previewEnabled && !rendered.renditions.some((item) => item.kind === "preview")) {
      throw taggedError("output_manifest_invalid");
    }
    plannedKinds = Array.from(new Set(rendered.renditions.map((item) => item.kind)));

    const readyRows: Array<{
      kind: VideoRenditionKind;
      status: VideoRenditionStatus;
      manifestKey: string;
      prefixKey: string;
      width: number;
      height: number;
      bitrateKbps: number;
      durationSeconds: number;
      segmentCount: number;
      byteSize: bigint;
      readyAt: Date;
    }> = [];
    const tmpKeys: string[] = [];
    const finalKeys: string[] = [];

    for (let index = 0; index < rendered.renditions.length; index += 1) {
      const rendition = rendered.renditions[index];
      await assertJobNotCancelled(prisma, job.id);
      const local = await inspectLocalRendition(rendition);
      const tempPrefix = `${tmpRootPrefix}/${rendition.kind}`;
      const finalPrefix = buildRenditionPrefix(job.asset, rendition.kind);
      const tempUploaded = await uploadDirectoryAsPrivatePrefix({ localDir: rendition.prefixPath, prefixKey: tempPrefix });
      tmpKeys.push(...tempUploaded.map((item) => item.key));
      await verifyUploadedObjects(tempUploaded.map((item) => item.key));

      await assertJobNotCancelled(prisma, job.id);
      const finalUploaded = await uploadDirectoryAsPrivatePrefix({ localDir: rendition.prefixPath, prefixKey: finalPrefix });
      finalKeys.push(...finalUploaded.map((item) => item.key));
      await verifyUploadedObjects(finalUploaded.map((item) => item.key));

      readyRows.push({
        kind: rendition.kind,
        status: "ready",
        manifestKey: `${finalPrefix}/${local.manifestName}`,
        prefixKey: finalPrefix,
        width: rendition.width,
        height: rendition.height,
        bitrateKbps: rendition.bitrateKbps,
        durationSeconds: rendition.durationSeconds,
        segmentCount: local.segmentCount,
        byteSize: local.byteSize,
        readyAt: new Date(),
      });
      const progress = 50 + Math.round(((index + 1) / rendered.renditions.length) * 35);
      await heartbeatTranscodeJob(prisma, { jobId: job.id, workerId: cfg.workerId, leaseSeconds: cfg.leaseSeconds, progressPercent: progress });
    }

    if (rendered.masterManifestPath) {
      const tempMaster = await uploadFileToPrivateKey({ localPath: rendered.masterManifestPath, key: `${tmpRootPrefix}/master.m3u8` });
      const finalMaster = await uploadFileToPrivateKey({ localPath: rendered.masterManifestPath, key: `${finalRootPrefix}/master.m3u8` });
      tmpKeys.push(tempMaster.key);
      finalKeys.push(finalMaster.key);
      await verifyUploadedObjects([tempMaster.key, finalMaster.key]);
    }

    await upsertVideoRenditions(prisma, {
      contentId: job.contentId,
      assetId: job.assetId,
      renditions: readyRows,
    });
    await markTranscodeJobReady(prisma, { jobId: job.id }, new Date());
    await deletePrefixSafe(tmpRootPrefix);
    return {
      ok: true,
      jobId: job.id,
      contentId: job.contentId,
      assetId: job.assetId,
      renditions: readyRows.map((item) => ({ kind: item.kind, status: item.status })),
    };
  } catch (error) {
    const errorClass = mapFailureToErrorClass(error);
    if (plannedKinds.length > 0) {
      await markRenditionsFailed(prisma, {
        contentId: job.contentId,
        assetId: job.assetId,
        kinds: plannedKinds,
        errorClass,
      });
    }
    await markTranscodeJobFailed(prisma, {
      jobId: job.id,
      errorClass,
      maxAttempts: cfg.maxAttempts,
    }, new Date());
    await deletePrefixSafe(tmpRootPrefix);
    await deletePrefixSafe(finalRootPrefix);
    return {
      ok: false,
      jobId: job.id,
      contentId: job.contentId,
      assetId: job.assetId,
      errorClass,
    };
  } finally {
    if (workDir) await cleanupJobWorkDir(workDir);
  }
}

export function createTranscodeRunner(cfg: TranscodeWorkerConfig): TranscodeRunner {
  return cfg.runnerMode === "mock" ? defaultMockTranscodeRunner() : createFfmpegTranscodeRunner(cfg);
}

export function defaultMockTranscodeRunner(): TranscodeRunner {
  return {
    async probe() {
      return { durationSeconds: 120, width: 1920, height: 1080, hasAudio: true };
    },
    async render(input) {
      const probe = await this.probe({ inputPath: input.inputPath, timeoutMs: input.timeoutMs });
      const targets = buildRenditionTargets(probe, input.previewSeconds, input.previewEnabled !== false);
      const renditions: RenderOutput["renditions"] = [];
      for (const target of targets) {
        const dir = path.join(input.workDir, target.kind);
        await mkdir(dir, { recursive: true });
        const manifestPath = path.join(dir, "index.m3u8");
        const initPath = path.join(dir, "init.mp4");
        const segmentPath = path.join(dir, "segment_000.m4s");
        await writeFile(manifestPath, "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.0,\nsegment_000.m4s\n");
        await writeFile(initPath, "init-bytes");
        await writeFile(segmentPath, "segment-bytes");
        renditions.push({
          kind: target.kind,
          width: target.width,
          height: target.height,
          bitrateKbps: target.bitrateKbps,
          durationSeconds: target.durationSeconds,
          manifestPath,
          prefixPath: dir,
          segmentCount: 1,
        });
      }
      const masterManifestPath = await writeMasterManifest(input.workDir, renditions.filter((item) => item.kind !== "preview"));
      return { probe, renditions, masterManifestPath };
    },
  };
}
