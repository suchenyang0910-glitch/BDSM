// ============================================================
// 对象存储封装（S3 兼容，支持 DigitalOcean Spaces / AWS S3 / COS / OSS 兼容 API）
// 安全规则（Fail-Closed）：
//   1) 缺任何一项必填 env 直接抛错，返回给前端仅为 "object_storage_unavailable"
//   2) 预签名 URL 仅允许 PUT，默认 15 分钟
//   3) HeadObject 失败或 Etag/ContentLength 不匹配 → emitSafetyEvent，前端仅 "upload_verify_failed"
//   4) storageKey 生成为: {YYYYMMDD}/{kind}/{uuid}_{origBase62}.{ext}，绝不包含任何用户/频道/Bot 明文标识
//   5) S3 客户端错误不泄露给前端；原始错误仅写入 structuredError stderr
// ============================================================

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  HeadObjectCommandOutput,
  DeleteObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { extname, basename } from "node:path";
import type { MediaAssetKind, MediaAssetStorageBackend } from "@prisma/client";
import { emitSafetyEvent } from "../utils/structuredError.js";

export type ObjectStorageInitUploadInput = {
  kind: MediaAssetKind;
  originalFilename?: string | null;
  mimeType?: string | null;
  contentLength: number;
  expectedChecksumSha256?: string | null;
  adminId?: string | null;
  note?: string | null;
};

export type ObjectStorageInitResult = {
  mediaAssetId: string;
  uploadUrl: string;
  storageKey: string;
  storageBucket: string;
  storageRegion: string;
  uploadExpiresAt: Date;
  expectedHttpHeaders: Record<string, string>;
};

export type ObjectStorageVerifyResult = {
  ok: boolean;
  userError?: string;
  etag?: string;
  contentLength?: bigint;
  lastModified?: Date;
  publicUrl?: string;
};

export type RequiredObjectStorageEnv = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
};

export type PrivateObjectStorageAssetKind = "cover" | "preview_source" | "full_source";

export type PrivateObjectStorageInitInput = {
  sessionId: string;
  objectKey: string;
  mimeType: string;
  contentLength: number;
  expectedSha256: string;
};

export type PrivateObjectStorageInitResult = {
  uploadUrl: string;
  uploadExpiresAt: Date;
  expectedHttpHeaders: Record<string, string>;
};

export type PrivateObjectStorageReadResult = {
  downloadUrl: string;
  expiresAt: Date;
};

export type PrivateMultipartUploadInitInput = {
  sessionId: string;
  objectKey: string;
  mimeType: string;
  expectedSha256: string;
};

export type PrivateMultipartUploadInitResult = {
  storageUploadId: string;
};

export type PrivateMultipartPartSignInput = {
  objectKey: string;
  storageUploadId: string;
  partNumber: number;
  checksumSha256?: string | null;
};

export type PrivateMultipartPartSignResult = {
  uploadUrl: string;
  uploadExpiresAt: Date;
  expectedHttpHeaders: Record<string, string>;
};

export type PrivateMultipartUploadedPart = {
  partNumber: number;
  etag: string;
  size: bigint;
};

export type CommunityStorageAssetKind = "image_source" | "video_source" | "image_thumbnail" | "video_poster" | "video_hls";

/** Only assets that are intended to appear in the public catalog may be public. */
export function isPublicMediaAssetKind(kind: MediaAssetKind): boolean {
  return kind === "cover_image" || kind === "preview_video";
}

const REQUIRED_ENV_KEYS = [
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_ACCESS_KEY",
  "OBJECT_STORAGE_SECRET_KEY",
] as const;

let _cachedEnv: RequiredObjectStorageEnv | null = null;
let _cachedS3: S3Client | null = null;

export function requireObjectStorageEnv(): RequiredObjectStorageEnv {
  if (_cachedEnv) return _cachedEnv;
  const missing: string[] = [];
  for (const k of REQUIRED_ENV_KEYS) {
    const v = readObjectStorageEnvValue(k);
    if (!v || !String(v).trim()) missing.push(k);
  }
  if (missing.length > 0) {
    emitSafetyEvent({
      event: "object_storage_env_missing",
      errorClass: "exhausted",
      note: `missing_env_keys_count=${missing.length}`,
      counts: { missingEnvKeys: missing.length },
    });
    throw new Error("OBJECT_STORAGE_ENV_MISSING");
  }
  const env: RequiredObjectStorageEnv = {
    endpoint: String(readObjectStorageEnvValue("OBJECT_STORAGE_ENDPOINT")).trim(),
    region: String(readObjectStorageEnvValue("OBJECT_STORAGE_REGION")).trim(),
    bucket: String(readObjectStorageEnvValue("OBJECT_STORAGE_BUCKET")).trim(),
    accessKeyId: String(readObjectStorageEnvValue("OBJECT_STORAGE_ACCESS_KEY")).trim(),
    secretAccessKey: String(readObjectStorageEnvValue("OBJECT_STORAGE_SECRET_KEY")).trim(),
    publicBaseUrl: readObjectStorageEnvValue("OBJECT_STORAGE_PUBLIC_BASE_URL")
      ? String(readObjectStorageEnvValue("OBJECT_STORAGE_PUBLIC_BASE_URL")).trim()
      : undefined,
  };
  if (!/^https?:\/\//i.test(env.endpoint)) {
    emitSafetyEvent({ event: "object_storage_env_invalid", errorClass: "business", note: "endpoint_missing_http_prefix_len_limit_64" });
    throw new Error("OBJECT_STORAGE_ENV_INVALID");
  }
  _cachedEnv = env;
  return env;
}

function readObjectStorageEnvValue(key: string): string | undefined {
  const direct = process.env[key];
  if (direct && String(direct).trim()) return String(direct).trim();
  const legacyMap: Record<string, string> = {
    OBJECT_STORAGE_ENDPOINT: "S3_ENDPOINT",
    OBJECT_STORAGE_REGION: "S3_REGION",
    OBJECT_STORAGE_BUCKET: "S3_BUCKET",
    OBJECT_STORAGE_ACCESS_KEY: "S3_ACCESS_KEY_ID",
    OBJECT_STORAGE_SECRET_KEY: "S3_SECRET_ACCESS_KEY",
    OBJECT_STORAGE_PUBLIC_BASE_URL: "S3_PUBLIC_BASE_URL",
  };
  const legacy = legacyMap[key];
  if (!legacy) return undefined;
  const legacyValue = process.env[legacy];
  return legacyValue && String(legacyValue).trim() ? String(legacyValue).trim() : undefined;
}

export function assertObjectStorageConfiguredOnStartup(): void {
  requireObjectStorageEnv();
}

export function objectKeyPrefixForAssetKind(kind: PrivateObjectStorageAssetKind): "covers" | "previews" | "originals" {
  if (kind === "cover") return "covers";
  if (kind === "preview_source") return "previews";
  return "originals";
}

export function getPrivateMultipartPartSizeBytes(): number {
  const raw = process.env.OBJECT_STORAGE_MULTIPART_PART_SIZE_MIB || process.env.S3_MULTIPART_PART_SIZE_MIB || "32";
  const mib = Number.parseInt(String(raw).trim(), 10);
  const clamped = Number.isFinite(mib) ? Math.min(64, Math.max(16, mib)) : 32;
  return clamped * 1024 * 1024;
}

export function generatePrivateObjectKey(kind: PrivateObjectStorageAssetKind, contentId: string, sessionId: string, originalFilename?: string | null): string {
  const prefix = objectKeyPrefixForAssetKind(kind);
  let ext = extname(originalFilename || "").slice(1).toLowerCase();
  if (ext.length > 16) ext = ext.slice(0, 16);
  const safeName = basename(originalFilename || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 64)
    .toLowerCase();
  return `${prefix}/${contentId}/${sessionId}/${safeName}${ext ? `.${ext}` : ""}`;
}

export function isAllowedPrivateObjectKey(objectKey: string): boolean {
  return /^(covers|previews|originals)\/[0-9a-z-]+\/[0-9a-z-]+\/[a-z0-9._-]+$/i.test(objectKey);
}

export function generateCommunityObjectKey(
  kind: CommunityStorageAssetKind,
  postId: string,
  assetId: string,
  originalFilename?: string | null,
): string {
  let ext = extname(originalFilename || "").slice(1).toLowerCase();
  if (ext.length > 16) ext = ext.slice(0, 16);
  const safeName = basename(originalFilename || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 64)
    .toLowerCase();
  if (kind === "image_source") return `community/posts/${postId}/images/${assetId}/source${ext ? `.${ext}` : ""}`;
  if (kind === "image_thumbnail") return `community/posts/${postId}/images/${assetId}/thumb.jpg`;
  if (kind === "video_source") return `community/posts/${postId}/videos/${assetId}/source${ext ? `.${ext}` : ""}`;
  if (kind === "video_poster") return `community/posts/${postId}/videos/${assetId}/poster.jpg`;
  return `community/hls/${postId}/${assetId}/${safeName || "playlist"}`;
}

export function buildCommunityHlsPrefix(postId: string, assetId: string): string {
  return `community/hls/${postId}/${assetId}`;
}

export function buildCommunityHlsManifestKey(postId: string, assetId: string): string {
  return `${buildCommunityHlsPrefix(postId, assetId)}/master.m3u8`;
}

export function isAllowedCommunityObjectKey(objectKey: string): boolean {
  return /^community\/posts\/[0-9a-z-]+\/(images|videos)\/[0-9a-z-]+\/[A-Za-z0-9._-]+$/i.test(objectKey) ||
    /^community\/hls\/[0-9a-z-]+\/[0-9a-z-]+\/[A-Za-z0-9._/-]+$/i.test(objectKey);
}

// Transcode output is server-generated and is never accepted from an upload
// request. Keep it out of the upload-key allowlist, while permitting the
// authenticated playback gateway to create a short-lived read URL for it.
function isAllowedControlledReadObjectKey(objectKey: string): boolean {
  return isAllowedPrivateObjectKey(objectKey) ||
    /^hls\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9._/-]+$/i.test(objectKey) ||
    isAllowedCommunityObjectKey(objectKey);
}

export function objectStorageBackend(): MediaAssetStorageBackend {
  // 当前仅支持 S3 兼容；local_disk 为 Staging 低规格预留，不在 P0 开放。
  return "s3_compatible";
}

export function getS3Client(): S3Client {
  if (_cachedS3) return _cachedS3;
  const env = requireObjectStorageEnv();
  _cachedS3 = new S3Client({
    endpoint: env.endpoint,
    region: env.region,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
    // DigitalOcean Spaces / COS / 大部分 S3 兼容需要 path-style=false; AWS S3 也要求 virtual-hosted-style
    forcePathStyle: false,
  });
  return _cachedS3;
}

function base62(bytes: Buffer): string {
  const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let num = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    num = num * 256n + BigInt(bytes[i]);
  }
  let out = "";
  const base = BigInt(ALPHABET.length);
  if (num === 0n) return ALPHABET[0];
  while (num > 0n) {
    const r = Number(num % base);
    num = num / base;
    out = ALPHABET[r] + out;
  }
  return out;
}

export function generateStorageKey(kind: MediaAssetKind, originalFilename?: string | null): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const dateDir = `${y}${m}${d}`;
  const rand = base62(randomBytes(12));
  let ext = extname(originalFilename || "").slice(1).toLowerCase();
  if (ext.length > 16) ext = ext.slice(0, 16);
  const safeOrig = basename(originalFilename || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 64)
    .toLowerCase();
  return `${dateDir}/${kind}/${rand}_${safeOrig}${ext ? `.${ext}` : ""}`;
}

export function makePublicUrl(bucket: string, region: string, key: string, env: RequiredObjectStorageEnv): string | undefined {
  if (env.publicBaseUrl) {
    const base = env.publicBaseUrl.replace(/\/+$/, "");
    return `${base}/${key.replace(/^\/+/, "")}`;
  }
  // 无法自动从 endpoint 猜 Spaces/COS 绑定域名，返回 undefined 让上游手动填
  return undefined;
}

export async function createPresignedPutUpload(
  input: ObjectStorageInitUploadInput,
): Promise<{
  env: RequiredObjectStorageEnv;
  key: string;
  url: string;
  expiresAt: Date;
  headers: Record<string, string>;
}> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  const publicReadable = isPublicMediaAssetKind(input.kind);
  const key = generateStorageKey(input.kind, input.originalFilename);
  const expiresSeconds = 15 * 60;
  const contentLength = Number.isFinite(input.contentLength) ? Math.max(0, Math.floor(input.contentLength)) : 0;
  const metadata: Record<string, string> = {
    "x-amz-meta-kind": input.kind,
  };
  if (input.adminId) metadata["x-amz-meta-admin-fp"] = shortFp(input.adminId);
  const headers: Record<string, string> = {
    "Content-Type": input.mimeType || "application/octet-stream",
    "Content-Length": String(contentLength),
  };
  if (publicReadable) headers["x-amz-acl"] = "public-read";
  if (input.expectedChecksumSha256) {
    headers["X-Amz-Checksum-Sha256"] = String(input.expectedChecksumSha256).trim();
  }
  const cmd = new PutObjectCommand({
    Bucket: env.bucket,
    Key: key,
    ContentType: headers["Content-Type"],
    ContentLength: contentLength > 0 ? contentLength : undefined,
    ChecksumSHA256: input.expectedChecksumSha256 ? String(input.expectedChecksumSha256).trim() : undefined,
    Metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    // Full videos are delivered only by the controlled Telegram channel flow.
    // Never grant public-read to them at upload time.
    ACL: publicReadable ? "public-read" : undefined,
  });
  const url = await getSignedUrl(s3, cmd as any, { expiresIn: expiresSeconds });
  const expiresAt = new Date(Date.now() + expiresSeconds * 1000);
  return { env, key, url, expiresAt, headers };
}

export async function createPrivatePresignedUpload(
  input: PrivateObjectStorageInitInput,
): Promise<PrivateObjectStorageInitResult> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedPrivateObjectKey(input.objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const contentLength = Number.isFinite(input.contentLength) ? Math.max(0, Math.floor(input.contentLength)) : 0;
  const expiresSeconds = 15 * 60;
  const headers: Record<string, string> = {
    "Content-Type": input.mimeType || "application/octet-stream",
    "Content-Length": String(contentLength),
    "X-Amz-Checksum-Sha256": String(input.expectedSha256).trim(),
  };
  const cmd = new PutObjectCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    ContentType: headers["Content-Type"],
    ContentLength: contentLength > 0 ? contentLength : undefined,
    ChecksumSHA256: String(input.expectedSha256).trim(),
    Metadata: {
      uploadsessionid: input.sessionId,
      sha256: String(input.expectedSha256).trim(),
    },
  });
  const uploadUrl = await getSignedUrl(s3, cmd as any, { expiresIn: expiresSeconds });
  return {
    uploadUrl,
    uploadExpiresAt: new Date(Date.now() + expiresSeconds * 1000),
    expectedHttpHeaders: headers,
  };
}

export async function createCommunityPresignedUpload(
  input: PrivateObjectStorageInitInput,
): Promise<PrivateObjectStorageInitResult> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedCommunityObjectKey(input.objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const contentLength = Number.isFinite(input.contentLength) ? Math.max(0, Math.floor(input.contentLength)) : 0;
  const expiresSeconds = 15 * 60;
  const headers: Record<string, string> = {
    "Content-Type": input.mimeType || "application/octet-stream",
    "Content-Length": String(contentLength),
    "X-Amz-Checksum-Sha256": String(input.expectedSha256).trim(),
  };
  const cmd = new PutObjectCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    ContentType: headers["Content-Type"],
    ContentLength: contentLength > 0 ? contentLength : undefined,
    ChecksumSHA256: String(input.expectedSha256).trim(),
    Metadata: {
      uploadsessionid: input.sessionId,
      sha256: String(input.expectedSha256).trim(),
      scope: "community",
    },
  });
  const uploadUrl = await getSignedUrl(s3, cmd as any, { expiresIn: expiresSeconds });
  return {
    uploadUrl,
    uploadExpiresAt: new Date(Date.now() + expiresSeconds * 1000),
    expectedHttpHeaders: headers,
  };
}

/**
 * 仅由已授权的服务端路由调用，用于短期预览私有对象。
 * 不把 Bucket、Key 或稳定对象 URL 暴露给浏览器端。
 */
export async function createPrivatePresignedReadUrl(
  objectKey: string,
  expiresSeconds = 5 * 60,
): Promise<PrivateObjectStorageReadResult> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedControlledReadObjectKey(objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const ttl = Math.min(Math.max(Math.floor(expiresSeconds), 30), 15 * 60);
  const cmd = new GetObjectCommand({ Bucket: env.bucket, Key: objectKey });
  const downloadUrl = await getSignedUrl(s3, cmd as any, { expiresIn: ttl });
  return { downloadUrl, expiresAt: new Date(Date.now() + ttl * 1000) };
}

export async function createPrivateMultipartUpload(
  input: PrivateMultipartUploadInitInput,
): Promise<PrivateMultipartUploadInitResult> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedPrivateObjectKey(input.objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const cmd = new CreateMultipartUploadCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    ChecksumAlgorithm: "SHA256",
    ContentType: input.mimeType || "application/octet-stream",
    Metadata: {
      uploadsessionid: input.sessionId,
      sha256: String(input.expectedSha256).trim(),
    },
  });
  const result = await s3.send(cmd);
  const storageUploadId = typeof result.UploadId === "string" ? result.UploadId : "";
  if (!storageUploadId) {
    throw new Error("OBJECT_STORAGE_MULTIPART_INIT_FAILED");
  }
  return { storageUploadId };
}

export async function createCommunityMultipartUpload(
  input: PrivateMultipartUploadInitInput,
): Promise<PrivateMultipartUploadInitResult> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedCommunityObjectKey(input.objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const cmd = new CreateMultipartUploadCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    ContentType: input.mimeType || "application/octet-stream",
    Metadata: {
      uploadsessionid: input.sessionId,
      scope: "community",
    },
  });
  const result = await s3.send(cmd);
  const storageUploadId = typeof result.UploadId === "string" ? result.UploadId : "";
  if (!storageUploadId) throw new Error("OBJECT_STORAGE_MULTIPART_INIT_FAILED");
  return { storageUploadId };
}

export async function createPrivateMultipartPartUploadUrl(
  input: PrivateMultipartPartSignInput,
): Promise<PrivateMultipartPartSignResult> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedPrivateObjectKey(input.objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const expiresSeconds = 15 * 60;
  const headers: Record<string, string> = {};
  const checksum = input.checksumSha256 ? String(input.checksumSha256).trim() : "";
  if (checksum) headers["X-Amz-Checksum-Sha256"] = checksum;
  const cmd = new UploadPartCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    UploadId: input.storageUploadId,
    PartNumber: input.partNumber,
    ChecksumSHA256: checksum || undefined,
  });
  const uploadUrl = await getSignedUrl(s3, cmd as any, { expiresIn: expiresSeconds });
  return {
    uploadUrl,
    uploadExpiresAt: new Date(Date.now() + expiresSeconds * 1000),
    expectedHttpHeaders: headers,
  };
}

export async function createCommunityMultipartPartUploadUrl(
  input: PrivateMultipartPartSignInput,
): Promise<PrivateMultipartPartSignResult> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedCommunityObjectKey(input.objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const expiresSeconds = 15 * 60;
  const headers: Record<string, string> = {};
  const checksum = input.checksumSha256 ? String(input.checksumSha256).trim() : "";
  if (checksum) headers["X-Amz-Checksum-Sha256"] = checksum;
  const cmd = new UploadPartCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    UploadId: input.storageUploadId,
    PartNumber: input.partNumber,
    ChecksumSHA256: checksum || undefined,
  });
  const uploadUrl = await getSignedUrl(s3, cmd as any, { expiresIn: expiresSeconds });
  return {
    uploadUrl,
    uploadExpiresAt: new Date(Date.now() + expiresSeconds * 1000),
    expectedHttpHeaders: headers,
  };
}

export async function listPrivateMultipartParts(
  objectKey: string,
  storageUploadId: string,
): Promise<PrivateMultipartUploadedPart[]> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedPrivateObjectKey(objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const parts: PrivateMultipartUploadedPart[] = [];
  let partNumberMarker: string | undefined;
  while (true) {
    const result = await s3.send(new ListPartsCommand({
      Bucket: env.bucket,
      Key: objectKey,
      UploadId: storageUploadId,
      PartNumberMarker: partNumberMarker,
    }));
    for (const part of result.Parts || []) {
      const rawPartNumber = typeof part.PartNumber === "number" ? part.PartNumber : null;
      const rawEtag = typeof part.ETag === "string" ? part.ETag.replace(/^"|"$/g, "") : "";
      if (!rawPartNumber || !rawEtag) continue;
      parts.push({
        partNumber: rawPartNumber,
        etag: rawEtag,
        size: typeof part.Size === "number" ? BigInt(part.Size) : 0n,
      });
    }
    if (!result.IsTruncated) break;
    partNumberMarker = result.NextPartNumberMarker != null ? String(result.NextPartNumberMarker) : undefined;
    if (!partNumberMarker) break;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

export async function listCommunityMultipartParts(
  objectKey: string,
  storageUploadId: string,
): Promise<PrivateMultipartUploadedPart[]> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedCommunityObjectKey(objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const parts: PrivateMultipartUploadedPart[] = [];
  let partNumberMarker: string | undefined;
  while (true) {
    const result = await s3.send(new ListPartsCommand({
      Bucket: env.bucket,
      Key: objectKey,
      UploadId: storageUploadId,
      PartNumberMarker: partNumberMarker,
    }));
    for (const part of result.Parts || []) {
      const rawPartNumber = typeof part.PartNumber === "number" ? part.PartNumber : null;
      const rawEtag = typeof part.ETag === "string" ? part.ETag.replace(/^"|"$/g, "") : "";
      if (!rawPartNumber || !rawEtag) continue;
      parts.push({ partNumber: rawPartNumber, etag: rawEtag, size: typeof part.Size === "number" ? BigInt(part.Size) : 0n });
    }
    if (!result.IsTruncated) break;
    partNumberMarker = result.NextPartNumberMarker != null ? String(result.NextPartNumberMarker) : undefined;
    if (!partNumberMarker) break;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

export async function completePrivateMultipartUpload(input: {
  objectKey: string;
  storageUploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}): Promise<void> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedPrivateObjectKey(input.objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    UploadId: input.storageUploadId,
    MultipartUpload: {
      Parts: input.parts
        .slice()
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
    },
  }));
}

export async function completeCommunityMultipartUpload(input: {
  objectKey: string;
  storageUploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}): Promise<void> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedCommunityObjectKey(input.objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: env.bucket,
    Key: input.objectKey,
    UploadId: input.storageUploadId,
    MultipartUpload: {
      Parts: input.parts
        .slice()
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
    },
  }));
}

export async function abortPrivateMultipartUpload(objectKey: string, storageUploadId: string): Promise<void> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedPrivateObjectKey(objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  await s3.send(new AbortMultipartUploadCommand({
    Bucket: env.bucket,
    Key: objectKey,
    UploadId: storageUploadId,
  }));
}

export async function abortCommunityMultipartUpload(objectKey: string, storageUploadId: string): Promise<void> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  if (!isAllowedCommunityObjectKey(objectKey)) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  await s3.send(new AbortMultipartUploadCommand({
    Bucket: env.bucket,
    Key: objectKey,
    UploadId: storageUploadId,
  }));
}

function shortFp(s: string | number | bigint | null | undefined): string {
  const v = s == null ? "" : String(s);
  if (!v) return "";
  // 前 8 位非敏感短摘要，仅用于日志标识（不可逆）；禁止入库作为外键
  return v.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}

export async function headObject(
  bucket: string,
  key: string,
): Promise<{ ok: boolean; head?: HeadObjectCommandOutput; userError?: string; rawErrCode?: string }> {
  try {
    const s3 = getS3Client();
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { ok: true, head };
  } catch (err: any) {
    const code = typeof err?.name === "string" ? err.name : (typeof err?.Code === "string" ? err.Code : undefined);
    const http = typeof err?.$metadata?.httpStatusCode === "number" ? err.$metadata.httpStatusCode : undefined;
    emitSafetyEvent({
      event: "object_storage_head_failed",
      errorClass: http === 404 ? "business" : "unknown",
      note: `http=${http ?? 0} key_len=${key.length} code_len=${(code || "").length}`,
      retryHint: http === 404 ? 0 : 1,
    });
    return {
      ok: false,
      rawErrCode: code,
      userError: http === 404 ? "upload_file_not_found_retry_upload" : "object_storage_service_unavailable",
    };
  }
}

export function normalizeHeadMetadata(head?: HeadObjectCommandOutput): {
  contentLength: bigint | null;
  contentType: string | null;
  checksumSha256: string | null;
  metadataSha256: string | null;
  uploadSessionId: string | null;
  etag: string | null;
} {
  const metadata = head?.Metadata || {};
  const etagRaw = typeof head?.ETag === "string" ? head.ETag : null;
  return {
    contentLength: typeof head?.ContentLength === "number" ? BigInt(head.ContentLength) : null,
    contentType: typeof head?.ContentType === "string" ? head.ContentType : null,
    checksumSha256: typeof (head as any)?.ChecksumSHA256 === "string" ? String((head as any).ChecksumSHA256) : null,
    metadataSha256: typeof metadata?.sha256 === "string" ? String(metadata.sha256) : null,
    uploadSessionId: typeof metadata?.uploadsessionid === "string" ? String(metadata.uploadsessionid) : null,
    etag: etagRaw ? etagRaw.replace(/^"|"$/g, "") : null,
  };
}

export async function deleteObjectSafe(bucket: string, key: string, adminId?: string | null): Promise<void> {
  try {
    const s3 = getS3Client();
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    emitSafetyEvent({
      event: "object_storage_delete_failed",
      errorClass: "unknown",
      adminId: adminId || null,
      note: `key_len=${key.length} bucket_len=${bucket.length}`,
      retryHint: 1,
    });
    // 不抛错避免把 S3 原错泄露；删除失败由对象存储生命周期兜底
  }
}

export function streamObjectForRead(bucket: string, key: string): {
  command: GetObjectCommand;
  client: S3Client;
  sseErrorEvent: { event: string; errorClass: string; note: string };
} {
  // 仅由 telegramPublisher 调用以 ReadableStream 形式发送到 Bot API multipart/form-data
  // 上游 try/catch 任何错误后必须走 emitSafetyEvent
  const s3 = getS3Client();
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return {
    client: s3,
    command: cmd,
    sseErrorEvent: {
      event: "object_storage_get_stream_failed",
      errorClass: "timeout",
      note: `bucket_len=${bucket.length} key_len=${key.length}`,
    },
  };
}
