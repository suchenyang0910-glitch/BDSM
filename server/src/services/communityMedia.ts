import { PrismaClient } from "@prisma/client";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  buildCommunityHlsManifestKey,
  buildCommunityHlsPrefix,
  getS3Client,
  headObject,
  requireObjectStorageEnv,
} from "./objectStorage.js";
import { emitSafetyEvent } from "../utils/structuredError.js";

export type CommunityMediaConfig = {
  runnerMode: "ffmpeg" | "mock";
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegTimeoutMs: number;
  ffprobeTimeoutMs: number;
  tmpDir: string;
};

export type CommunityMediaProbe = {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
};

export function loadCommunityMediaConfig(env: NodeJS.ProcessEnv = process.env): CommunityMediaConfig {
  return {
    runnerMode: String(env.COMMUNITY_MEDIA_RUNNER || "").trim().toLowerCase() === "mock" ? "mock" : "ffmpeg",
    ffmpegPath: String(env.COMMUNITY_FFMPEG_PATH || env.TRANSCODE_FFMPEG_PATH || "ffmpeg").trim(),
    ffprobePath: String(env.COMMUNITY_FFPROBE_PATH || env.TRANSCODE_FFPROBE_PATH || "ffprobe").trim(),
    ffmpegTimeoutMs: clampInt(env.COMMUNITY_FFMPEG_TIMEOUT_MS, 10 * 60_000, 30_000, 60 * 60_000),
    ffprobeTimeoutMs: clampInt(env.COMMUNITY_FFPROBE_TIMEOUT_MS, 60_000, 5_000, 5 * 60_000),
    tmpDir: String(env.COMMUNITY_MEDIA_TMP_DIR || path.join(os.tmpdir(), "intune-community-media")).trim(),
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function ensureTmpDir(base: string) {
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, "job-"));
}

async function runCommand(bin: string, args: string[], timeoutMs: number) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${bin}_timeout`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const error = new Error(`${bin}_failed:${code}`);
      (error as any).stdout = stdout;
      (error as any).stderr = stderr;
      reject(error);
    });
  });
}

async function downloadObjectToFile(objectKey: string, outputPath: string) {
  const env = requireObjectStorageEnv();
  const verify = await headObject(env.bucket, objectKey);
  if (!verify.ok || !verify.head) throw new Error("community_source_not_found");
  const client = getS3Client();
  const result: any = await client.send(new GetObjectCommand({ Bucket: env.bucket, Key: objectKey }));
  if (!result?.Body || typeof result.Body.pipe !== "function") throw new Error("community_source_stream_invalid");
  await pipeline(result.Body, createWriteStream(outputPath));
}

async function uploadFileToObject(input: { objectKey: string; filePath: string; contentType: string }) {
  const env = requireObjectStorageEnv();
  const client = getS3Client();
  const body = await readFile(input.filePath);
  await client.send(new PutObjectCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    Body: body,
    ContentType: input.contentType,
  }));
}

async function uploadTextToObject(input: { objectKey: string; body: string; contentType: string }) {
  const env = requireObjectStorageEnv();
  const client = getS3Client();
  await client.send(new PutObjectCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    Body: Buffer.from(input.body, "utf8"),
    ContentType: input.contentType,
  }));
}

export async function probeCommunityMediaFile(input: { filePath: string; cfg: CommunityMediaConfig }): Promise<CommunityMediaProbe> {
  if (input.cfg.runnerMode === "mock") {
    return { width: 720, height: 1280, durationSeconds: 12 };
  }
  const args = [
    "-v", "error",
    "-print_format", "json",
    "-show_entries", "stream=width,height:format=duration",
    input.filePath,
  ];
  let stdout = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.cfg.ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("community_ffprobe_timeout"));
    }, input.cfg.ffprobeTimeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`community_ffprobe_failed:${code}`));
    });
  });
  const parsed = JSON.parse(stdout || "{}");
  const stream = Array.isArray(parsed.streams) ? parsed.streams.find((row: any) => row.width && row.height) : null;
  const duration = Number(parsed?.format?.duration);
  return {
    width: stream?.width ? Number(stream.width) : null,
    height: stream?.height ? Number(stream.height) : null,
    durationSeconds: Number.isFinite(duration) ? Math.max(1, Math.round(duration)) : null,
  };
}

export async function inspectCommunityObjectMedia(input: {
  objectKey: string;
  cfg?: CommunityMediaConfig;
}): Promise<CommunityMediaProbe> {
  const cfg = input.cfg || loadCommunityMediaConfig();
  const workDir = await ensureTmpDir(cfg.tmpDir);
  try {
    const srcPath = path.join(workDir, "source");
    await downloadObjectToFile(input.objectKey, srcPath);
    return await probeCommunityMediaFile({ filePath: srcPath, cfg });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function computeCommunityObjectSha256(input: {
  objectKey: string;
  cfg?: CommunityMediaConfig;
}): Promise<string> {
  const cfg = input.cfg || loadCommunityMediaConfig();
  const workDir = await ensureTmpDir(cfg.tmpDir);
  try {
    const srcPath = path.join(workDir, "source");
    await downloadObjectToFile(input.objectKey, srcPath);
    const bytes = await readFile(srcPath);
    return createHash("sha256").update(bytes).digest("base64");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function generateCommunityImageThumbnail(input: {
  sourceObjectKey: string;
  thumbnailObjectKey: string;
  cfg?: CommunityMediaConfig;
}): Promise<{ width: number | null; height: number | null; aspectRatio: number | null }> {
  const cfg = input.cfg || loadCommunityMediaConfig();
  const workDir = await ensureTmpDir(cfg.tmpDir);
  try {
    const srcPath = path.join(workDir, "source");
    const thumbPath = path.join(workDir, "thumb.jpg");
    await downloadObjectToFile(input.sourceObjectKey, srcPath);
    const probe = await probeCommunityMediaFile({ filePath: srcPath, cfg });
    if (cfg.runnerMode === "mock") {
      await uploadTextToObject({ objectKey: input.thumbnailObjectKey, body: "mock-community-thumb", contentType: "image/jpeg" });
      return {
        width: probe.width,
        height: probe.height,
        aspectRatio: probe.width && probe.height ? probe.width / probe.height : null,
      };
    }
    await runCommand(cfg.ffmpegPath, [
      "-y",
      "-i", srcPath,
      "-vf", "scale=if(gte(iw\\,ih)\\,min(720\\,iw)\\,-2):if(gte(ih\\,iw)\\,min(720\\,ih)\\,-2)",
      "-frames:v", "1",
      thumbPath,
    ], cfg.ffmpegTimeoutMs);
    await uploadFileToObject({ objectKey: input.thumbnailObjectKey, filePath: thumbPath, contentType: "image/jpeg" });
    return {
      width: probe.width,
      height: probe.height,
      aspectRatio: probe.width && probe.height ? probe.width / probe.height : null,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function processCommunityVideoAsset(prisma: PrismaClient, assetId: string, cfgInput?: CommunityMediaConfig) {
  const cfg = cfgInput || loadCommunityMediaConfig();
  const asset = await (prisma as any).communityPostAsset.findUnique({
    where: { id: assetId },
    include: { post: true },
  });
  if (!asset || asset.kind !== "video" || !asset.objectKey || !asset.post) throw new Error("community_video_asset_not_found");
  const manifestKey = buildCommunityHlsManifestKey(asset.postId, asset.id);
  const prefixKey = buildCommunityHlsPrefix(asset.postId, asset.id);
  const posterKey = asset.posterObjectKey || `community/posts/${asset.postId}/videos/${asset.id}/poster.jpg`;
  const workDir = await ensureTmpDir(cfg.tmpDir);
  try {
    const srcPath = path.join(workDir, "source.mp4");
    await (prisma as any).communityPostAsset.update({
      where: { id: asset.id },
      data: { transcodeStatus: "processing", transcodeProgressPercent: 10, playbackManifestKey: manifestKey, playbackPrefixKey: prefixKey, posterObjectKey: posterKey },
    });
    await downloadObjectToFile(asset.objectKey, srcPath);
    const probe = await probeCommunityMediaFile({ filePath: srcPath, cfg });
    if (cfg.runnerMode === "mock") {
      await uploadTextToObject({ objectKey: `${prefixKey}/master.m3u8`, body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg-000.ts\n", contentType: "application/vnd.apple.mpegurl" });
      await uploadTextToObject({ objectKey: `${prefixKey}/seg-000.ts`, body: "mock-community-segment", contentType: "video/mp2t" });
      await uploadTextToObject({ objectKey: posterKey, body: "mock-community-poster", contentType: "image/jpeg" });
    } else {
      const hlsDir = path.join(workDir, "hls");
      await mkdir(hlsDir, { recursive: true });
      await runCommand(cfg.ffmpegPath, [
        "-y",
        "-i", srcPath,
        "-vf", "scale=if(gt(iw\\,720)\\,720\\,iw):-2",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "24",
        "-g", "48",
        "-sc_threshold", "0",
        "-c:a", "aac",
        "-b:a", "96k",
        "-hls_time", "4",
        "-hls_playlist_type", "vod",
        "-hls_segment_filename", path.join(hlsDir, "seg-%03d.ts"),
        path.join(hlsDir, "master.m3u8"),
      ], cfg.ffmpegTimeoutMs);
      await runCommand(cfg.ffmpegPath, [
        "-y",
        "-i", srcPath,
        "-ss", "00:00:01",
        "-frames:v", "1",
        path.join(workDir, "poster.jpg"),
      ], cfg.ffmpegTimeoutMs);
      const files = await readdir(hlsDir);
      for (const fileName of files) {
        const objectKey = `${prefixKey}/${fileName}`;
        const contentType = fileName.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
        await uploadFileToObject({ objectKey, filePath: path.join(hlsDir, fileName), contentType });
      }
      await uploadFileToObject({ objectKey: posterKey, filePath: path.join(workDir, "poster.jpg"), contentType: "image/jpeg" });
    }
    await (prisma as any).communityPostAsset.update({
      where: { id: asset.id },
      data: {
        transcodeStatus: "ready",
        transcodeProgressPercent: 100,
        playbackManifestKey: manifestKey,
        playbackPrefixKey: prefixKey,
        posterObjectKey: posterKey,
        width: probe.width,
        height: probe.height,
        aspectRatio: probe.width && probe.height ? probe.width / probe.height : null,
        durationSeconds: probe.durationSeconds,
      },
    });
  } catch (error) {
    emitSafetyEvent({ event: "community_video_transcode_failed", errorClass: "unknown", note: `asset=${assetId}` }, error);
    await (prisma as any).communityPostAsset.update({
      where: { id: assetId },
      data: { transcodeStatus: "failed", transcodeProgressPercent: 0 },
    });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function claimNextCommunityVideoAsset(prisma: PrismaClient) {
  const candidate = await (prisma as any).communityPostAsset.findFirst({
    where: {
      kind: "video",
      transcodeStatus: "pending",
      objectKey: { not: null },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!candidate) return null;
  const updated = await (prisma as any).communityPostAsset.updateMany({
    where: { id: candidate.id, transcodeStatus: "pending" },
    data: { transcodeStatus: "processing", transcodeProgressPercent: 5 },
  });
  if (updated.count !== 1) return null;
  return candidate;
}

export async function processNextCommunityVideoAsset(prisma: PrismaClient, cfg?: CommunityMediaConfig) {
  const asset = await claimNextCommunityVideoAsset(prisma);
  if (!asset) return null;
  await processCommunityVideoAsset(prisma, asset.id, cfg);
  return asset.id;
}

export function buildCommunityManifestPath(postId: string, assetId: string, relative = "master.m3u8") {
  return `/api/community/media/${encodeURIComponent(postId)}/videos/${encodeURIComponent(assetId)}/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

export function rewriteCommunityManifest(postId: string, assetId: string, text: string) {
  const result: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push(line);
      continue;
    }
    if (!trimmed.startsWith("#")) {
      result.push(buildCommunityManifestPath(postId, assetId, trimmed));
      continue;
    }
    result.push(line);
  }
  return result.join("\n");
}

export function createCommunityPlaybackNonce() {
  return randomUUID().slice(0, 12);
}
