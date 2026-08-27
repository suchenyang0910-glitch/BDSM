import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireAdmin, type AdminSession } from "./admin.js";
import { adminHasPermission } from "../services/authAdmin.js";
import { resolvePackageChannelId, resolveContentChannelId } from "../services/channelCrypto.js";
import {
  refRawChatId,
  type ChannelRef,
  buildPrivateChannelPostUrl,
  channelRefFingerprint,
  chatIdFingerprint,
  maskChatIdSafe,
} from "../services/telegramBot.js";
import { resolveMembershipChannelRef } from "../services/membershipChannel.js";
import type { PlaybackConfig } from "../services/playbackConfig.js";
import { prewarmPlaybackCdnForContent } from "../services/playbackCdnPrewarm.js";
import { emitSafetyEvent } from "../utils/structuredError.js";
import {
  isValidFreeChannelCode,
  listConfiguredPublicFreeChannelOptions,
  refFreeChannelByCode,
  getFreeChannelEntry,
} from "../services/freeChannels.js";
import {
  createPresignedPutUpload,
  createPrivatePresignedUpload,
  createPrivatePresignedReadUrl,
  createPrivateMultipartUpload,
  createPrivateMultipartPartUploadUrl,
  listPrivateMultipartParts,
  completePrivateMultipartUpload,
  abortPrivateMultipartUpload,
  headObject,
  normalizeHeadMetadata,
  deleteObjectSafe,
  makePublicUrl,
  objectStorageBackend,
  requireObjectStorageEnv,
  generateStorageKey,
  generatePrivateObjectKey,
  isAllowedPrivateObjectKey,
  getPrivateMultipartPartSizeBytes,
} from "../services/objectStorage.js";
import {
  initTelegramPublisher,
  getPublishQueueHandle,
  buildPreviewVideoCaption,
} from "../services/telegramPublisher.js";
import {
  validateKeywordList,
  validateTelegramTagList,
  normalizeTelegramTagValuesFromInputs,
  buildEffectiveSeo,
  normalizeTelegramHashtagsFromInputs,
  appendTelegramTagLine,
  type ListNormalizationIssue,
} from "../services/seoMetadata.js";
import { revokePlaybackSessionsByContent } from "../services/playbackAdmin.js";
import { randomBytes, createHash } from "node:crypto";
import { decryptChatIdAesGcm } from "../utils/crypto.js";

const ContentStatusZ = z.enum(["draft", "pending_review", "published", "archived", "scheduled"]);
const BannerStatusZ = z.enum(["draft", "active", "inactive", "scheduled", "archived"]);
const BannerTargetTypeZ = z.enum(["content", "category", "package", "membership", "external"]);
// Telegram 本地 Bot API 对单文件上传的实际能力上限为 2GB；后台与 API 必须一致。
const MAX_FULL_VIDEO_BYTES = 2n * 1024n * 1024n * 1024n;
const VOD_SINGLE_UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000;
const VOD_MULTIPART_UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const VOD_MULTIPART_MAX_CONCURRENCY = 3;
const SHA256_BASE64_RE = /^[A-Za-z0-9+/]{43}=$/;
const VOD_ASSET_KIND_Z = z.enum(["cover", "preview_source", "full_source"]);
const VOD_UPLOAD_SESSION_STATUS_Z = z.enum(["initiated", "uploading", "paused", "completing", "completed", "cancelled", "expired", "failed"]);
const VOD_ERROR_CLASS = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  invalid_input: "invalid_input",
  content_not_found: "content_not_found",
  upload_session_expired: "upload_session_expired",
  upload_session_invalid: "upload_session_invalid",
  object_not_found: "object_not_found",
  object_metadata_mismatch: "object_metadata_mismatch",
  object_storage_unavailable: "object_storage_unavailable",
  deleted: "deleted",
} as const;

const VOD_MIME_RULES: Record<z.infer<typeof VOD_ASSET_KIND_Z>, { prefixes: string[]; maxBytes: bigint }> = {
  cover: { prefixes: ["image/"], maxBytes: 20n * 1024n * 1024n },
  preview_source: { prefixes: ["video/"], maxBytes: 1024n * 1024n * 1024n },
  full_source: { prefixes: ["video/"], maxBytes: 8n * 1024n * 1024n * 1024n },
};

function normalizePreviewPolicy(input: { previewEnabled?: boolean | null; previewDurationSeconds?: number | null }) {
  const previewEnabled = input.previewEnabled !== false;
  const rawDuration = Number(input.previewDurationSeconds ?? 60);
  const previewDurationSeconds = [30, 60, 90].includes(rawDuration) ? rawDuration : 60;
  return {
    previewEnabled,
    previewDurationSeconds,
  };
}

function adminMeta(req: FastifyRequest) {
  const sess = (req as any).admin as AdminSession;
  return {
    adminId: sess.adminId,
    adminRole: sess.role,
    adminEmail: sess.email,
    ip: (req.ip as string) || null,
    ua: (req.headers["user-agent"] as string) || null,
  };
}

function isMimeAllowedForVodAsset(kind: z.infer<typeof VOD_ASSET_KIND_Z>, mimeType: string): boolean {
  const normalized = String(mimeType || "").trim().toLowerCase();
  return VOD_MIME_RULES[kind].prefixes.some((prefix) => normalized.startsWith(prefix));
}

function isSizeAllowedForVodAsset(kind: z.infer<typeof VOD_ASSET_KIND_Z>, bytes: bigint): boolean {
  return bytes > 0n && bytes <= VOD_MIME_RULES[kind].maxBytes;
}

function summarizeFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  if (trimmed.length <= 40) return trimmed;
  return `${trimmed.slice(0, 24)}...${trimmed.slice(-12)}`;
}

function sanitizeErrorClass(input: string | null | undefined): string | null {
  if (!input) return null;
  return String(input).trim().toLowerCase().replace(/[^a-z0-9_:-]/g, "").slice(0, 64) || null;
}

function summarizeVideoRendition(row: any) {
  return {
    kind: row.kind,
    status: row.status,
    width: row.width ?? null,
    height: row.height ?? null,
    bitrateKbps: row.bitrateKbps ?? null,
    durationSeconds: row.durationSeconds ?? null,
    segmentCount: row.segmentCount ?? null,
    byteSize: row.byteSize != null ? String(row.byteSize) : null,
    errorClass: sanitizeErrorClass(row.errorClass),
    readyAt: row.readyAt ? new Date(row.readyAt).toISOString() : null,
  };
}

function summarizeVodAsset(row: any) {
  const transcodeJob = row?.transcodeJobs?.[0] || null;
  const renditions = Array.isArray(row?.renditions) ? row.renditions.map((item: any) => summarizeVideoRendition(item)) : [];
  return {
    id: row.id,
    kind: row.kind,
    filename: summarizeFilename(row.originalFilename),
    byteSize: row.byteSize != null ? String(row.byteSize) : null,
    mimeType: row.mimeType || null,
    source: "vod",
    // 受控的后台预览入口；真正的对象地址只由该入口短期签发。
    previewPath: row.kind === "cover" && row.status === "verified" && !row.deletedAt
      ? `/api/admin/vod-assets/${encodeURIComponent(row.id)}/preview`
      : null,
    status: row.status,
    errorClass: sanitizeErrorClass(row.errorClass),
    verifiedAt: row.verifiedAt ? new Date(row.verifiedAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    transcode: transcodeJob
      ? {
          id: transcodeJob.id,
          status: transcodeJob.status,
          attemptCount: transcodeJob.attemptCount,
          progressPercent: typeof transcodeJob.progressPercent === "number" ? transcodeJob.progressPercent : 0,
          errorClass: sanitizeErrorClass(transcodeJob.errorClass),
          workerIdPresent: !!transcodeJob.workerId,
          leaseUntil: transcodeJob.leaseUntil ? new Date(transcodeJob.leaseUntil).toISOString() : null,
          lastHeartbeatAt: transcodeJob.lastHeartbeatAt ? new Date(transcodeJob.lastHeartbeatAt).toISOString() : null,
          queuedAt: transcodeJob.queuedAt ? new Date(transcodeJob.queuedAt).toISOString() : null,
        }
      : null,
    renditions,
  };
}

/** 轻媒体（封面 / 历史试看）与 VideoAsset 使用不同表，但后台素材页需要统一展示。 */
function summarizeLightMediaAsset(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    filename: summarizeFilename(row.originalFilename),
    byteSize: row.contentLength != null ? String(row.contentLength) : null,
    mimeType: row.mimeType || null,
    source: "legacy",
    status: row.status,
    errorClass: sanitizeErrorClass(row.lastErrorClass),
    verifiedAt: row.lastVerifiedAt ? new Date(row.lastVerifiedAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    // 只下发后台受控预览路径，绝不把对象存储 URL / Key 返回给浏览器。
    previewPath: row.kind === "cover_image" && row.status === "ready"
      ? `/api/admin/media/${encodeURIComponent(row.id)}/preview`
      : null,
    transcode: null,
    renditions: [],
  };
}

function isMultipartVodAssetKind(kind: z.infer<typeof VOD_ASSET_KIND_Z> | string | null | undefined): boolean {
  return kind === "full_source";
}

function uploadSessionTtlMs(kind: z.infer<typeof VOD_ASSET_KIND_Z> | string | null | undefined): number {
  return isMultipartVodAssetKind(kind) ? VOD_MULTIPART_UPLOAD_SESSION_TTL_MS : VOD_SINGLE_UPLOAD_SESSION_TTL_MS;
}

function nextUploadSessionExpiry(kind: z.infer<typeof VOD_ASSET_KIND_Z> | string | null | undefined): Date {
  return new Date(Date.now() + uploadSessionTtlMs(kind));
}

function summarizeUploadSessionPart(row: any) {
  return {
    partNumber: row.partNumber,
    etag: row.etag,
    bytes: row.bytes != null ? String(row.bytes) : "0",
    checksum: row.checksum || null,
    status: row.status,
    uploadedAt: row.uploadedAt ? new Date(row.uploadedAt).toISOString() : null,
  };
}

function summarizeUploadSession(row: any) {
  const parts = Array.isArray(row?.parts) ? row.parts : [];
  return {
    id: row.id,
    contentId: row.contentId,
    assetKind: row.assetKind,
    status: row.status,
    filename: summarizeFilename(row.originalFilename),
    mimeType: row.expectedMime || null,
    expectedSize: row.expectedSize != null ? String(row.expectedSize) : null,
    uploadedBytes: row.uploadedBytes != null ? String(row.uploadedBytes) : "0",
    totalParts: row.totalParts ?? null,
    partSize: row.partSize ?? null,
    storageUploadIdPresent: !!row.storageUploadId,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).toISOString() : null,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    parts: parts.map((part: any) => summarizeUploadSessionPart(part)),
  };
}

async function touchUploadSession(tx: any, sessionId: string, kind: string, extra: Record<string, any> = {}) {
  return tx.uploadSession.update({
    where: { id: sessionId },
    data: {
      lastActivityAt: new Date(),
      expiresAt: nextUploadSessionExpiry(kind),
      ...extra,
    },
  });
}

function writeAudit(
  prisma: any,
  meta: ReturnType<typeof adminMeta>,
  action: string,
  objectType: string,
  objectId: string,
  beforeValue: any,
  afterValue: any,
  reason?: string | null,
) {
  return prisma.adminAuditLog.create({
    data: {
      adminId: meta.adminId,
      action,
      objectType,
      objectId,
      beforeValue: beforeValue == null ? null : (typeof beforeValue === "string" ? beforeValue : beforeValue),
      afterValue: afterValue == null ? null : (typeof afterValue === "string" ? afterValue : afterValue),
      reason: reason ?? null,
      ipAddress: meta.ip,
      userAgent: meta.ua,
    },
  });
}

function serialize(v: any) {
  if (v == null) return null;
  // Prisma 的金额、文件大小和 Telegram messageId 使用 BigInt；JSON 本身无法编码 BigInt。
  // 后台 API 统一以十进制字符串交付，避免列表/详情页因单个关联字段而整体 500。
  return JSON.parse(JSON.stringify(v, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

function stripSensitiveFields(v: any): any {
  if (v == null) return v;
  const copy = serialize(v);
  if (Array.isArray(copy)) {
    return copy.map((item) => stripSensitiveFields(item));
  }
  if (copy && typeof copy === "object") {
    if ("channelId" in copy) delete copy.channelId;
    if ("inviteLink" in copy) delete copy.inviteLink;
    for (const k of Object.keys(copy)) copy[k] = stripSensitiveFields(copy[k]);
  }
  return copy;
}

type FieldValidationFailure = {
  field: string;
  label: string;
  issues: ListNormalizationIssue[];
};

function buildValidationErrorResponse(failures: FieldValidationFailure[]) {
  const primary = failures[0];
  return {
    error: "validation_error",
    message: primary ? `${primary.label}存在 ${primary.issues.length} 项无效输入，请按提示修正后再保存。` : "输入校验失败。",
    details: failures.map((failure) => ({
      field: failure.field,
      label: failure.label,
      issues: failure.issues,
    })),
  };
}

function normalizeSeoPayload(payload: {
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: unknown;
  geoKeywords?: unknown;
}) {
  const seoTitle = String(payload.seoTitle || "").trim().slice(0, 120) || null;
  const seoDescription = String(payload.seoDescription || "").trim().slice(0, 300) || null;
  const seoKeywords = validateKeywordList(payload.seoKeywords);
  const geoKeywords = validateKeywordList(payload.geoKeywords);
  const failures: FieldValidationFailure[] = [];
  if (seoKeywords.errors.length > 0) failures.push({ field: "seoKeywords", label: "SEO 关键词", issues: seoKeywords.errors });
  if (geoKeywords.errors.length > 0) failures.push({ field: "geoKeywords", label: "GEO 关键词", issues: geoKeywords.errors });
  return {
    ok: failures.length === 0,
    failures,
    value: {
      seoTitle,
      seoDescription,
      seoKeywords: seoKeywords.items,
      geoKeywords: geoKeywords.items,
    },
  };
}

function normalizeContentTagsPayload(input: unknown) {
  const tags = validateTelegramTagList(input, { prefixHash: false });
  const failures: FieldValidationFailure[] = tags.errors.length > 0
    ? [{ field: "tags", label: "内容标签", issues: tags.errors }]
    : [];
  return {
    ok: failures.length === 0,
    failures,
    value: tags.items,
  };
}

function normalizePublishTelegramTagsPayload(input: unknown) {
  const tags = validateTelegramTagList(input, { prefixHash: false });
  const failures: FieldValidationFailure[] = tags.errors.length > 0
    ? [{ field: "telegramTags", label: "Telegram 标签", issues: tags.errors }]
    : [];
  return {
    ok: failures.length === 0,
    failures,
    value: tags.items,
  };
}

async function getPlatformMetadataRow(prisma: PrismaClient) {
  const row = await prisma.platformMetadata.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });
  return row;
}

function serializePlatformMetadata(row: any) {
  return {
    id: row.id,
    seoTitle: row.seoTitle || null,
    seoDescription: row.seoDescription || null,
    seoKeywords: Array.isArray(row.seoKeywords) ? row.seoKeywords : [],
    geoKeywords: Array.isArray(row.geoKeywords) ? row.geoKeywords : [],
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    updatedBy: row.updatedBy || null,
  };
}

function attachEffectiveSeo<T extends Record<string, any>>(row: T, platform: any): T & { effectiveSeo: ReturnType<typeof buildEffectiveSeo> } {
  return Object.assign({}, row, {
    effectiveSeo: buildEffectiveSeo({
      contentSeoTitle: row.seoTitle,
      contentSeoDescription: row.seoDescription,
      contentSeoKeywords: row.seoKeywords,
      contentGeoKeywords: row.geoKeywords,
      fallbackTitle: row.title,
      fallbackDescription: row.description,
      platformSeoTitle: platform?.seoTitle,
      platformSeoDescription: platform?.seoDescription,
      platformSeoKeywords: platform?.seoKeywords,
      platformGeoKeywords: platform?.geoKeywords,
    }),
  });
}

function normalizeStoredTelegramTags(input: unknown): string[] {
  return normalizeTelegramHashtagsFromInputs([Array.isArray(input) ? input : []]);
}

function maskTelegramMessageId(messageId: bigint | number | string | null | undefined): string | null {
  if (messageId == null) return null;
  const raw = String(messageId);
  if (raw.length <= 4) return raw;
  return `***${raw.slice(-4)}`;
}

function getAllowedChannelMessageFilter(content: {
  accessType: AccessTypeBound;
  packageId?: string | null;
}) {
  if (content.accessType === "public") {
    return { purpose: "free_preview" as const };
  }
  if (content.accessType === "membership") {
    return { purpose: "membership_main" as const };
  }
  if (content.accessType === "package") {
    return { purpose: "package_channel" as const, packageId: content.packageId || null };
  }
  return null;
}

function serializeChannelMessageRow(row: any) {
  return {
    id: row.id,
    managedChannelId: row.managedChannelId,
    channelLabel: row.managedChannel?.title || row.managedChannel?.username || "受控频道",
    channelPurpose: row.managedChannel?.purpose || "none",
    packageId: row.managedChannel?.packageId || null,
    mediaKind: row.mediaKind,
    postedAt: row.postedAt ? new Date(row.postedAt).toISOString() : null,
    associationStatus: row.associationStatus,
    contentId: row.contentId || null,
    linkedAt: row.linkedAt ? new Date(row.linkedAt).toISOString() : null,
    messageIdMasked: maskTelegramMessageId(row.messageId),
  };
}

type AccessTypeBound = "public" | "single" | "membership" | "package";
type FreePreviewDistributionTarget = { code: string; label: string; description: string };

/**
 * 免费频道是后台绑定的「free_preview」频道池。优先使用后台已登记频道，
 * 以便运营无需维护环境变量或在每条内容中重复选择；保留 env 白名单作为旧部署兼容兜底。
 */
async function listFreePreviewDistributionTargets(prisma: PrismaClient): Promise<FreePreviewDistributionTarget[]> {
  const managed = await (prisma as any).adminManagedChannel.findMany({
    where: { purpose: "free_preview", chatType: "channel", isPrivate: false },
    select: { id: true, title: true, username: true },
    orderBy: [{ updatedAt: "desc" }],
  });
  if (managed.length > 0) {
    return managed.map((channel: any, index: number) => ({
      code: `managed:${channel.id}`,
      label: channel.title || channel.username || `免费流量频道 ${index + 1}`,
      description: "后台已绑定的免费流量入口",
    }));
  }
  return listConfiguredPublicFreeChannelOptions();
}

/**
 * 免费流量入口是所有可发布内容的强制前置：至少一张已校验封面 + 至少一个
 * 已启用入口。当前入口为 Telegram 公开频道；以后 Facebook 等平台只需实现
 * 同一入口适配器，不得改变内容发布主流程。
 */
async function validateFreeTrafficEntryReady(prisma: PrismaClient, contentId: string) {
  const [cover, targets] = await Promise.all([
    (prisma as any).videoAsset.findFirst({
      where: { contentId, kind: "cover", status: "verified", deletedAt: null },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    }),
    listFreePreviewDistributionTargets(prisma),
  ]);
  if (!cover) {
    return { ok: false as const, status: 409, error: "free_traffic_cover_required", message: "发布前必须上传并校验一张封面图，用于免费流量入口推广。" };
  }
  if (targets.length === 0) {
    return { ok: false as const, status: 409, error: "free_traffic_entry_required", message: "发布前必须配置至少一个免费流量入口。" };
  }
  return { ok: true as const };
}

interface ContentAccessValidationContext {
  prisma: PrismaClient;
  targetContentId?: string | null;
  accessType: AccessTypeBound;
  packageId?: string | null;
  productId?: string | null;
  freeChannelCode?: string | null;
  coverAssetId?: string | null;
  previewAssetId?: string | null;
  fullVideoAssetId?: string | null;
  fullVideoAssetIds?: string[];
  allowDraftWithoutDeliveryMedia?: boolean;
}

/** Preserve upload order, reject duplicate media references, and retain legacy callers. */
function normalizeFullVideoAssetIds(input?: string[] | null, legacy?: string | null): string[] {
  const source = Array.isArray(input) && input.length > 0 ? input : legacy ? [legacy] : [];
  return Array.from(new Set(source.filter((id): id is string => typeof id === "string" && id.trim().length > 0)));
}

async function syncContentFullVideoBindings(tx: any, contentId: string) {
  const assets = await tx.videoAsset.findMany({
    where: {
      contentId,
      kind: "full_source",
      status: "verified",
      deletedAt: null,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const firstId = assets[0]?.id ?? null;
  await tx.content.update({
    where: { id: contentId },
    data: { fullVideoAssetId: firstId },
  });
  await tx.contentFullVideoSegment.deleteMany({ where: { contentId } });
  if (assets.length > 0) {
    await tx.contentFullVideoSegment.createMany({
      data: assets.map((asset: any, index: number) => ({
        contentId,
        videoAssetId: asset.id,
        segmentOrder: index + 1,
      })),
    });
  }
  return assets;
}

async function validateContentAccessTypeConstraints(ctx: ContentAccessValidationContext): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string; message?: string; details?: any }
> {
  const { prisma, targetContentId, accessType, packageId, productId, coverAssetId, previewAssetId, fullVideoAssetId } = ctx;
  const fullVideoAssetIds = normalizeFullVideoAssetIds(ctx.fullVideoAssetIds, fullVideoAssetId);

  // —— FK 基础校验：如传入 assetId，必须是存在且 status=ready（避免引用不存在/未完成上传的素材）
  const fkChecks: Array<{ key: "coverAssetId" | "previewAssetId"; id: string | null | undefined; expectedKind?: "cover_image" | "preview_video" }> = [
    { key: "coverAssetId", id: coverAssetId, expectedKind: "cover_image" },
    { key: "previewAssetId", id: previewAssetId, expectedKind: "preview_video" },
  ];
  for (const fk of fkChecks) {
    if (!fk.id) continue;
    const a = await prisma.mediaAsset.findUnique({ where: { id: fk.id }, select: { id: true, status: true, kind: true, contentLength: true } });
    if (!a) {
      return { ok: false, status: 404, error: `${fk.key}_not_found`, message: `指定的素材不存在（${fk.key}=${fk.id}），请先完成素材上传并校验通过。` };
    }
    if (a.status !== "ready") {
      return { ok: false, status: 409, error: `${fk.key}_not_ready`, message: `素材尚未完成上传或校验失败（当前 status=${a.status}）。请先完成上传并点击校验通过。` };
    }
    if (fk.expectedKind && a.kind !== fk.expectedKind) {
      return { ok: false, status: 409, error: `${fk.key}_kind_mismatch`, message: `素材类型不匹配：${fk.key} 必须是 ${fk.expectedKind}，实际为 ${a.kind}。` };
    }
  }
  for (const assetId of fullVideoAssetIds) {
    const asset = await prisma.videoAsset.findUnique({
      where: { id: assetId },
      select: { id: true, contentId: true, status: true, kind: true, deletedAt: true },
    });
    if (!asset) {
      return { ok: false, status: 404, error: "fullVideoAssetId_not_found", message: `指定的完整视频不存在（fullVideoAssetId=${assetId}），请先完成完整视频上传。` };
    }
    if (targetContentId && asset.contentId !== targetContentId) {
      return {
        ok: false,
        status: 409,
        error: "asset_content_mismatch",
        message: "完整视频只允许绑定到其所属内容，不能跨内容复用或挪用其他内容的源视频。",
        details: { assetId, assetContentId: asset.contentId, targetContentId },
      };
    }
    if (asset.deletedAt || asset.status === "deleted") {
      return { ok: false, status: 409, error: "fullVideoAssetId_not_ready", message: "指定的完整视频已删除，请重新上传。" };
    }
    if (asset.status !== "verified") {
      return { ok: false, status: 409, error: "fullVideoAssetId_not_ready", message: `完整视频尚未校验完成（当前 status=${asset.status}）。` };
    }
    if (asset.kind !== "full_source") {
      return { ok: false, status: 409, error: "fullVideoAssetId_kind_mismatch", message: `完整视频绑定必须引用 full_source，实际为 ${asset.kind}。` };
    }
  }

  // —— 强业务矩阵校验：accessType × 素材
  if (accessType === "public") {
    if (fullVideoAssetIds.length === 0 && !ctx.allowDraftWithoutDeliveryMedia) {
      return {
        ok: false,
        status: 400,
        error: "public_requires_full_video",
        message: "public 类型需上传一份完整源视频，系统将自动生成独立私有试看 HLS。",
      };
    }
  }

  if (accessType === "package") {
    if (!packageId) {
      return {
        ok: false,
        status: 400,
        error: "package_id_required",
        message: "package 类型必须绑定已发布且已配置受控频道的内容包。",
      };
    }
    const pkg = await prisma.contentPackage.findUnique({
      where: { id: packageId },
      select: {
        id: true,
        status: true,
        channelId: true,
        channelIdCiphertext: true,
        productId: true,
        product: { select: { status: true } },
      },
    });
    if (!pkg) {
      return { ok: false, status: 404, error: "package_not_found", message: "指定的内容包不存在" };
    }
    const pkgChannel = resolvePackageChannelId({
      channelId: pkg.channelId,
      channelIdCiphertext: pkg.channelIdCiphertext,
    });
    const missing: string[] = [];
    if (pkg.status !== "published") missing.push("内容包未发布（status 必须为 published）");
    if (pkgChannel == null) missing.push("内容包未配置交付频道（需服务端完成受控映射，channelId 不能为空）");
    if (pkg.productId && pkg.product?.status !== "active") missing.push("内容包对应商品未启用（product.status 必须为 active）");
    if (missing.length > 0) {
      return {
        ok: false,
        status: 409,
        error: "package_not_ready",
        message: "内容包暂不可交付",
        details: missing,
      };
    }
  }

  if (accessType === "single") {
    if (!productId) {
      return {
        ok: false,
        status: 400,
        error: "single_product_required",
        message: "single 类型必须绑定已启用的单篇商品。",
      };
    }
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, type: true, status: true },
    });
    if (!product) {
      return { ok: false, status: 404, error: "product_not_found", message: "指定的商品不存在" };
    }
    if (product.type !== "single") {
      return {
        ok: false,
        status: 409,
        error: "single_product_type_mismatch",
        message: `single 类型必须绑定 single 商品，当前商品类型为 ${product.type}。`,
      };
    }
    if (product.status !== "active") {
      return {
        ok: false,
        status: 409,
        error: "single_product_not_active",
        message: "single 类型必须绑定已启用的单篇商品。",
      };
    }
  }

  if (accessType === "membership" && fullVideoAssetIds.length === 0 && !ctx.allowDraftWithoutDeliveryMedia) {
    return { ok: false, status: 400, error: "membership_requires_full_video", message: "会员交付内容必须上传并绑定完整视频（VideoAsset）。" };
  }
  if (accessType === "package" && fullVideoAssetIds.length === 0 && !ctx.allowDraftWithoutDeliveryMedia) {
    return { ok: false, status: 400, error: "package_requires_full_video", message: "内容包交付内容必须上传并绑定完整视频（VideoAsset）。" };
  }

  if (accessType === "membership") {
    if (packageId) {
      return {
        ok: false,
        status: 400,
        error: "membership_must_not_bind_package",
        message: "会员内容不得绑定 packageId；会员频道由服务端受控统一交付。",
      };
    }
  }

  if (accessType === "public") {
    if (packageId) {
      return {
        ok: false,
        status: 400,
        error: "public_must_not_bind_package",
        message: "公开内容不得绑定收费内容包 packageId。",
      };
    }
  }

  void productId;
  return { ok: true };
}

/**
 * 兼容早期后台脚本：VOD 的封面存在 video_assets，旧脚本却会把它写到
 * MediaAsset 的 coverAssetId 字段。该字段不是 VOD 封面的绑定位；同内容的
 * VOD cover 必须忽略，避免已校验封面反而阻断普通“保存视频信息”。
 *
 * 只忽略确实属于当前内容、且 kind=cover 的 VOD 素材；任意未知 ID 仍由
 * 后续校验严格拒绝，不能借此绕过素材归属检查。
 */
async function omitLegacyCoverReferenceForVodAsset(
  prisma: PrismaClient,
  contentId: string,
  payload: { coverAssetId?: string | null },
): Promise<boolean> {
  const candidateId = payload.coverAssetId;
  if (!candidateId) return false;
  const [legacyAsset, vodAsset] = await Promise.all([
    prisma.mediaAsset.findUnique({ where: { id: candidateId }, select: { id: true } }),
    (prisma as any).videoAsset.findUnique({
      where: { id: candidateId },
      select: { contentId: true, kind: true },
    }),
  ]);
  if (!legacyAsset && vodAsset?.contentId === contentId && vodAsset.kind === "cover") {
    delete payload.coverAssetId;
    return true;
  }
  return false;
}

async function validatePublishReady(
  prisma: PrismaClient,
  contentId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string; message?: string; details?: any }> {
  const row = await prisma.content.findUnique({
    where: { id: contentId },
    select: {
      accessType: true,
      packageId: true,
      productId: true,
      freeChannelCode: true,
      coverAssetId: true,
      previewAssetId: true,
      fullVideoAssetId: true,
      fullVideoSegments: { orderBy: { segmentOrder: "asc" }, select: { videoAssetId: true } },
    },
  });
  if (!row) return { ok: false, status: 404, error: "not_found", message: "内容不存在" };
  return validateContentAccessTypeConstraints({
    prisma,
    accessType: row.accessType as AccessTypeBound,
    packageId: row.packageId,
    productId: row.productId,
    freeChannelCode: row.freeChannelCode,
    coverAssetId: row.coverAssetId,
    previewAssetId: row.previewAssetId,
    fullVideoAssetId: row.fullVideoAssetId,
    fullVideoAssetIds: row.fullVideoSegments.map((segment) => segment.videoAssetId),
  });
}

type TelegramPublishPlanKind = "public_free_preview" | "membership_full" | "package_full";
type TelegramPublishQueueResult =
  | { ok: true; jobs: any[]; normalizedTelegramTags: string[] }
  | { ok: false; status: number; error: string; message: string; details?: any };

/**
 * 为内容创建受控的 Telegram 发送任务。
 *
 * 这不是“登记已发布消息”的旧流程：任务会由 publisher worker 真正发送。
 * 目标频道始终由 accessType / freeChannelCode / package 的服务端映射决定，调用方不能传 chatId。
 */
async function queueTelegramPublishForContent(input: {
  prisma: PrismaClient;
  contentId: string;
  meta: ReturnType<typeof adminMeta>;
  channelKinds: TelegramPublishPlanKind[];
  telegramTags?: unknown;
  reason?: string | null;
}): Promise<TelegramPublishQueueResult> {
  const { prisma, contentId, meta } = input;
  const normalizedPublishTags = normalizePublishTelegramTagsPayload(input.telegramTags || []);
  if (!normalizedPublishTags.ok) {
    return {
      ok: false,
      status: 400,
      error: "validation_error",
      message: buildValidationErrorResponse(normalizedPublishTags.failures).message,
      details: buildValidationErrorResponse(normalizedPublishTags.failures).details,
    };
  }
  const content = await prisma.content.findUnique({
    where: { id: contentId },
    include: {
      coverAsset: true,
      previewAsset: true,
      fullVideoAsset: true,
      // 免费频道只发一张已校验封面图作为推广入口；试看仍由 Web HLS 播放，
      // 不复制完整视频，也不要求运营另传试看文件。
      videoAssets: {
        where: { kind: "cover", status: "verified", deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      fullVideoSegments: { orderBy: { segmentOrder: "asc" }, include: { videoAsset: true } },
      package: { select: { id: true, status: true, channelId: true, channelIdCiphertext: true, title: true } },
    },
  });
  if (!content) return { ok: false, status: 404, error: "not_found", message: "内容不存在" };

  const baseOk = await validateContentAccessTypeConstraints({
    prisma,
    accessType: content.accessType as AccessTypeBound,
    packageId: content.packageId,
    productId: content.productId,
    freeChannelCode: content.freeChannelCode,
    coverAssetId: content.coverAssetId,
    previewAssetId: content.previewAssetId,
    fullVideoAssetId: content.fullVideoAssetId,
    fullVideoAssetIds: content.fullVideoSegments.map((segment) => segment.videoAssetId),
  });
  if (!baseOk.ok) {
    return {
      ok: false,
      status: baseOk.status,
      error: baseOk.error,
      message: baseOk.message || "频道发布前检查未通过。",
      details: baseOk.details,
    };
  }

  // 免费流量入口是视频发布的强制组成部分，而不是由后台复选框决定的可选项。
  // 这样无论是首次自动发布，还是运营后续手动补发私密完整视频，都会同时补齐
  // 全部已启用免费频道的封面推广任务。现有任务会在下方按目标幂等复用，不会重复发送。
  const kinds = Array.from(new Set([
    ...input.channelKinds,
    "public_free_preview" as TelegramPublishPlanKind,
  ]));
  const plans: Array<{
    mediaAssetId?: string | null;
    videoAssetId?: string | null;
    contentSegmentId?: string | null;
    segmentOrder?: number | null;
    segmentCount?: number | null;
    targetFreeChannelCode?: string | null;
    channelKindDb: TelegramPublishPlanKind;
    packageId?: string | null;
  }> = [];
  // Migration populates historic single-file records. The fallback is deliberately
  // retained for a deployment where code has restarted before the migration is run.
  const fullSegments = content.fullVideoSegments.length > 0
    ? content.fullVideoSegments
    : content.fullVideoAsset
      ? [{ id: null, segmentOrder: 1, videoAssetId: content.fullVideoAsset.id, videoAsset: content.fullVideoAsset }]
      : [];
  for (const kind of kinds) {
    if (kind === "public_free_preview") {
      const promoCover = content.videoAssets[0];
      if (!promoCover) {
        return {
          ok: false,
          status: 409,
          error: "free_promo_cover_required",
          message: "免费频道推广需要一张已校验封面图；60 秒试看仍由 Web 自动生成，不需要单独上传试看视频。",
        };
      }
      const targets = await listFreePreviewDistributionTargets(prisma);
      if (targets.length === 0) {
        return {
          ok: false,
          status: 409,
          error: "free_channel_pool_not_configured",
          message: "尚未配置可用的免费流量频道。请先在频道管理中设置至少一个公开 free_preview 频道。",
        };
      }
      for (const target of targets) {
        plans.push({
          videoAssetId: promoCover.id,
          targetFreeChannelCode: target.code,
          channelKindDb: kind,
        });
      }
      continue;
    }
    if (kind === "membership_full") {
      if (content.accessType !== "membership") {
        return { ok: false, status: 409, error: "publish_kind_mismatch", message: "只有会员内容可发送到会员私密频道。" };
      }
      if (fullSegments.length === 0 || fullSegments.some((segment) => segment.videoAsset.status !== "verified" || segment.videoAsset.kind !== "full_source")) {
        return { ok: false, status: 409, error: "full_video_asset_required", message: "会员内容必须先上传并校验完整视频。" };
      }
      for (const segment of fullSegments) {
        plans.push({ videoAssetId: segment.videoAssetId, contentSegmentId: segment.id, segmentOrder: segment.segmentOrder, segmentCount: fullSegments.length, channelKindDb: kind });
      }
      continue;
    }
    if (kind === "package_full") {
      if (content.accessType !== "package") {
        return { ok: false, status: 409, error: "publish_kind_mismatch", message: "只有内容包内容可发送到内容包私密频道。" };
      }
      if (!content.package || resolvePackageChannelId({ channelId: content.package.channelId, channelIdCiphertext: content.package.channelIdCiphertext }) == null) {
        return { ok: false, status: 409, error: "package_channel_not_configured", message: "内容包尚未配置受控交付频道。" };
      }
      if (fullSegments.length === 0 || fullSegments.some((segment) => segment.videoAsset.status !== "verified" || segment.videoAsset.kind !== "full_source")) {
        return { ok: false, status: 409, error: "full_video_asset_required", message: "内容包内容必须先上传并校验完整视频。" };
      }
      for (const segment of fullSegments) {
        plans.push({ videoAssetId: segment.videoAssetId, contentSegmentId: segment.id, segmentOrder: segment.segmentOrder, segmentCount: fullSegments.length, channelKindDb: kind, packageId: content.package.id });
      }
    }
  }
  if (plans.length === 0) return { ok: false, status: 400, error: "publish_plan_empty", message: "没有任何合法的频道发布计划。" };

  // Telegram 公开标签只允许来自内容标签与本次发布时手填标签；
  // SEO / GEO 关键词绝不能自动泄露为公开标签。
  const normalizedTelegramTags = normalizeTelegramHashtagsFromInputs([
    normalizeTelegramTagValuesFromInputs(content.tags || []),
    normalizedPublishTags.value,
  ]);
  const createdJobs = await prisma.$transaction(async (tx: any) => {
    const jobs: any[] = [];
    const now = Date.now();
    for (const plan of plans) {
      // 发布按钮可被重复点击、网络层也可能重放请求。用 PostgreSQL 事务咨询锁把
      // “内容 + 素材 + 目标频道”收敛为一个交付任务，避免同一视频在同一频道重复发送。
      // 后续若需要重新发片，必须走显式的 re-publish 动作，而不是复用这个默认入口。
      const deliveryAssetId = plan.videoAssetId || plan.mediaAssetId;
      if (!deliveryAssetId) continue;
      const deliveryIdentity = [
        content.id,
        deliveryAssetId,
        plan.channelKindDb,
        plan.targetFreeChannelCode || "private-channel",
      ].join(":");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${deliveryIdentity}))`;
      const existing = await tx.telegramPublishJob.findFirst({
        where: {
          contentId: content.id,
          mediaAssetId: plan.mediaAssetId ?? null,
          videoAssetId: plan.videoAssetId ?? null,
          channelKind: plan.channelKindDb,
          targetFreeChannelCode: plan.targetFreeChannelCode ?? null,
        },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        jobs.push(existing);
        continue;
      }
      const jobSeed = `${plan.channelKindDb}|${content.id}|${deliveryAssetId}|${meta.adminId}|${now}|${cryptoRandomUuid()}`;
      const jobToken = `tgj_${createHash("sha256").update(jobSeed).digest("hex").slice(0, 48)}`;
      let captionBundle: { captionText?: string | null; parseMode?: string | null } = {};
      if (plan.channelKindDb === "public_free_preview") {
        const { caption, parseMode } = buildPreviewVideoCaption(content);
        captionBundle = { captionText: appendTelegramTagLine(caption, normalizedTelegramTags), parseMode };
      } else if (plan.channelKindDb === "membership_full" || plan.channelKindDb === "package_full") {
        // 私密频道完整视频不再只显示标签；worker 会以标题、简介为主体并追加这些标签。
        captionBundle = { captionText: null, parseMode: "HTML" };
      } else if (normalizedTelegramTags.length > 0) {
        captionBundle = { captionText: normalizedTelegramTags.join(" "), parseMode: null };
      }
      const job = await tx.telegramPublishJob.create({
        data: {
          contentId: content.id,
          packageId: plan.packageId ?? null,
          adminId: meta.adminId,
          mediaAssetId: plan.mediaAssetId ?? null,
          videoAssetId: plan.videoAssetId ?? null,
          contentSegmentId: plan.contentSegmentId ?? null,
          segmentOrder: plan.segmentOrder ?? null,
          channelKind: plan.channelKindDb,
          targetFreeChannelCode: plan.targetFreeChannelCode ?? null,
          jobToken,
          queueName: "telegram-publish-default",
          botKey: "primary",
          captionText: captionBundle.captionText ?? null,
          parseMode: captionBundle.parseMode ?? null,
          telegramTagsJson: normalizedTelegramTags,
          sendOptionsJson: plan.segmentCount ? { segmentCount: plan.segmentCount } : undefined,
        },
      });
      jobs.push(job);
      await writeAudit(tx, meta, `content.publish_telegram_queue_${plan.channelKindDb}`, "content", content.id, null, serialize({ jobId: job.id, jobToken_fp: safeHexDigest(jobToken, 16) }), input.reason || null);
    }
    return jobs;
  });

  const queueHandle = getPublishQueueHandle();
  if (queueHandle) {
    for (const job of createdJobs) {
      try { await queueHandle.add(job.jobToken); } catch (err) {
        emitSafetyEvent({ event: "tg_publish_enqueue_failed", errorClass: "queue_error", note: `job_fp=${safeHexDigest(job.id, 12)}` }, err);
      }
    }
  } else {
    emitSafetyEvent({ event: "tg_publish_no_queue_handle", errorClass: "publisher_uninitialized", note: `jobs=${createdJobs.length}` });
  }
  return { ok: true, jobs: createdJobs, normalizedTelegramTags };
}

export default async function adminCmsRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma as PrismaClient;
  const playbackConfig = (fastify as any).playbackConfig as PlaybackConfig | undefined;
  const SENSITIVE_MASK = "******";
  const ZID = z.string().trim().min(1).max(64);

  // 【P0-素材上传发布】初始化 Bot 发布队列（BullMQ + Redis，缺 REDIS_URL 自动回退 DB 轮询）
  try {
    await initTelegramPublisher(fastify);
  } catch (err) {
    emitSafetyEvent({ event: "admin_init_publisher_failed", errorClass: "publisher_init_error", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
  }

  // ===========================================================================
  // CONTENTS (Step 1 BE-R1)
  // ===========================================================================
  fastify.get(
    "/admin/platform-metadata",
    { preHandler: [requireAdmin("settings:view")] },
    async (_req: any, reply) => {
      const row = await getPlatformMetadataRow(prisma);
      return reply.send(serializePlatformMetadata(row));
    },
  );

  fastify.put(
    "/admin/platform-metadata",
    { preHandler: [requireAdmin("settings:manage")] },
    async (req: any, reply) => {
      const body = ZPLATFORM_METADATA.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await getPlatformMetadataRow(prisma);
      const normalized = normalizeSeoPayload(body);
      if (!normalized.ok) {
        return reply.status(400).send(buildValidationErrorResponse(normalized.failures));
      }
      const after = await prisma.platformMetadata.update({
        where: { id: "default" },
        data: {
          seoTitle: normalized.value.seoTitle,
          seoDescription: normalized.value.seoDescription,
          seoKeywords: normalized.value.seoKeywords,
          geoKeywords: normalized.value.geoKeywords,
          updatedBy: meta.adminId,
        },
      });
      await writeAudit(
        prisma,
        meta,
        "platform_metadata.update",
        "platform_metadata",
        "default",
        serializePlatformMetadata(before),
        serializePlatformMetadata(after),
        body.reason || null,
      );
      return reply.send({ ok: true, platformMetadata: serializePlatformMetadata(after) });
    },
  );

  const ZCONTENT_CREATE = z.object({
    title: z.string().trim().min(1).max(200),
    coverUrl: z.string().trim().url().max(500).optional().nullable(),
    thumbnailUrl: z.string().trim().url().max(500).optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
    tags: z.union([z.array(z.string().max(500)), z.string().max(5000)]).optional().default([]),
    seoTitle: z.string().trim().max(120).optional().nullable(),
    seoDescription: z.string().trim().max(300).optional().nullable(),
    seoKeywords: z.union([z.array(z.string().max(500)), z.string().max(5000)]).optional().default([]),
    geoKeywords: z.union([z.array(z.string().max(500)), z.string().max(5000)]).optional().default([]),
    previewUrl: z.string().trim().max(500).optional().nullable(),
    previewEnabled: z.boolean().optional().default(true),
    previewDurationSeconds: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional().default(60),
    durationSeconds: z.number().int().min(0).optional().nullable(),
    accessType: z.enum(["public", "single", "membership", "package"]).optional().default("single"),
    freeChannelCode: z.string().max(64).trim().optional().nullable(),
    coverAssetId: ZID.optional().nullable(),
    previewAssetId: ZID.optional().nullable(),
    fullVideoAssetId: ZID.optional().nullable(),
    fullVideoAssetIds: z.array(ZID).max(50).optional(),
    isRecommended: z.boolean().optional().default(false),
    isFeatured: z.boolean().optional().default(false),
    isNewArrival: z.boolean().optional().default(false),
    featuredSort: z.number().int().optional().nullable(),
    sortOrder: z.number().int().min(0).optional().default(0),
    recommendStartsAt: z.string().datetime().optional().nullable(),
    recommendEndsAt: z.string().datetime().optional().nullable(),
    scheduledAt: z.string().datetime().optional().nullable(),
    packageId: ZID.optional().nullable(),
    productId: ZID.optional().nullable(),
    categoryIds: z.array(ZID).optional().default([]),
    reason: z.string().max(500).optional(),
  });
  const ZCONTENT_EDIT = ZCONTENT_CREATE.partial().extend({ id: ZID });
  const ZCATEGORY_SET = z.object({ categoryIds: z.array(ZID), reason: z.string().max(500).optional() });
  const ZSTATUS_ACTION = z.object({ reason: z.string().max(500).optional() });
  const ZCONTENT_QP = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    status: z.string().optional(),
    categoryId: ZID.optional(),
    q: z.string().optional(),
    accessType: z.string().optional(),
  });
  const ZAUDIT_REASON = z.object({ reason: z.string().max(500).optional() });
  const ZPUBLISH_VIDEO = z.object({
    videoFileId: z.string().trim().min(1).max(512),
    thumbnailFileId: z.string().trim().max(512).optional().nullable(),
    caption: z.string().max(2048).optional().nullable(),
    supportsStreaming: z.boolean().optional().default(true),
    parseMode: z.enum(["MarkdownV2", "HTML", "Markdown"]).optional().default("HTML"),
    reason: z.string().max(500).optional(),
  });

  const ZREGISTER_TELEGRAM_PUBLISH = z.object({
    telegramMessageId: z.union([z.string().trim().min(1), z.number().int()]),
    telegramChatFingerprint: z.string().trim().max(128).optional().nullable(),
    freeChannelCode: z.string().trim().max(64).optional().nullable(),
    videoFileIdRemark: z.string().trim().max(512).optional().nullable(),
    caption: z.string().max(2048).optional().nullable(),
    reason: z.string().max(500).optional(),
  });

  const ZSTART_PUBLISH = z.object({
    channelKinds: z.array(
      z.enum(["public_free_preview", "membership_full", "package_full"])
    ).min(1).max(6),
    telegramTags: z.union([z.array(z.string().max(500)), z.string().max(5000)]).optional().default([]),
    reason: z.string().max(500).optional(),
  });
  const ZPLATFORM_METADATA = z.object({
    seoTitle: z.string().trim().max(120).optional().nullable(),
    seoDescription: z.string().trim().max(300).optional().nullable(),
    seoKeywords: z.union([z.array(z.string().max(500)), z.string().max(5000)]).optional().default([]),
    geoKeywords: z.union([z.array(z.string().max(500)), z.string().max(5000)]).optional().default([]),
    reason: z.string().max(500).optional(),
  });
  const ZPUBLISH_JOBS_QP = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  });
  const ZCHANNEL_MESSAGES_QP = z.object({
    status: z.enum(["unlinked", "linked"]).optional(),
    purpose: z.enum(["free_preview", "membership_main", "package_channel"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(30),
  });
  const ZLINK_CHANNEL_MESSAGE = z.object({
    channelMessageId: z.string().uuid(),
    reason: z.string().max(500).optional(),
  });

  // —— 免费频道白名单枚举（只暴露 code/label/描述，绝不暴露 chatId）
  fastify.get(
    "/admin/free-channels",
    { preHandler: [requireAdmin("content:view")] },
    async (_req: any, reply) => {
      return reply.send({
        items: (await listFreePreviewDistributionTargets(prisma)).map((c) => ({
          code: c.code,
          label: c.label,
          description: c.description,
        })),
      });
    },
  );

  fastify.get(
    "/admin/contents",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const qp = ZCONTENT_QP.parse(req.query);
      const where: any = {};
      if (qp.status && ContentStatusZ.safeParse(qp.status).success) where.status = qp.status;
      if (qp.accessType) where.accessType = qp.accessType;
      if (qp.categoryId) where.categories = { some: { categoryId: qp.categoryId } };
      if (qp.q?.trim()) {
        where.OR = [
          { title: { contains: qp.q.trim(), mode: "insensitive" } },
          { description: { contains: qp.q.trim(), mode: "insensitive" } },
        ];
      }
      const [total, rows, platform] = await Promise.all([
        prisma.content.count({ where }),
        prisma.content.findMany({
          where,
          include: {
            categories: { orderBy: { displayOrder: "asc" }, include: { category: true } },
            product: { select: { id: true, title: true, priceMinor: true, currency: true } },
            package: { select: { id: true, title: true } },
            lastEditor: { select: { id: true, email: true, displayName: true } },
            // VOD Phase A 的封面不再写入旧 MediaAsset；列表必须读取已校验的
            // VOD cover，并只下发受控预览入口，不能泄漏对象存储地址。
            videoAssets: {
              where: { kind: "cover", status: "verified", deletedAt: null },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { id: true },
            },
          },
          skip: (qp.page - 1) * qp.limit,
          take: qp.limit,
          orderBy: [{ sortOrder: "desc" }, { isFeatured: "desc" }, { isRecommended: "desc" }, { updatedAt: "desc" }],
        }),
        getPlatformMetadataRow(prisma),
      ]);
      return reply.send(serialize({
        total, page: qp.page, limit: qp.limit,
        data: rows.map((c: any) => {
          const { videoAssets, ...content } = c;
          return attachEffectiveSeo({
            ...content,
            coverPreviewPath: videoAssets[0]
              ? `/api/admin/vod-assets/${encodeURIComponent(videoAssets[0].id)}/preview`
              : null,
            categories: c.categories.map((x: any) => ({ id: x.categoryId, name: x.category.name, slug: x.category.slug, displayOrder: x.displayOrder })),
          }, platform);
        }),
      }));
    },
  );

  fastify.get(
    "/admin/contents/:id",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const [row, platform] = await Promise.all([
        prisma.content.findUnique({
          where: { id },
          include: {
            categories: { orderBy: { displayOrder: "asc" }, include: { category: true } },
            product: true,
            package: true,
            lastEditor: { select: { id: true, email: true, displayName: true } },
            coverAsset: {
              select: {
                id: true, kind: true, status: true, originalFilename: true, mimeType: true,
                storagePublicUrl: true, contentLength: true, widthPixels: true, heightPixels: true,
                lastVerifiedAt: true, createdAt: true,
              },
            },
            previewAsset: {
              select: {
                id: true, kind: true, status: true, originalFilename: true, mimeType: true,
                storagePublicUrl: true, contentLength: true, durationSeconds: true,
                widthPixels: true, heightPixels: true, hasWatermark: true,
                lastVerifiedAt: true, createdAt: true,
              },
            },
            fullVideoAsset: {
              select: {
                id: true, kind: true, status: true, originalFilename: true, mimeType: true,
                byteSize: true, verifiedAt: true, createdAt: true,
              },
            },
            fullVideoSegments: {
              orderBy: { segmentOrder: "asc" },
              include: {
                videoAsset: {
                  select: {
                    id: true, kind: true, status: true, originalFilename: true, mimeType: true,
                    byteSize: true, verifiedAt: true, createdAt: true,
                  },
                },
              },
            },
          },
        }),
        getPlatformMetadataRow(prisma),
      ]);
      if (!row) return reply.status(404).send({ error: "not_found" });
      return reply.send(serialize(attachEffectiveSeo({
        ...row,
        categories: row.categories.map((x: any) => ({ id: x.categoryId, name: x.category.name, slug: x.category.slug, displayOrder: x.displayOrder })),
      }, platform)));
    },
  );

  const ZVOD_UPLOAD_SESSION = z.object({
    assetKind: VOD_ASSET_KIND_Z,
    filename: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(128),
    byteSize: z.union([z.number().int().min(1), z.string().trim().min(1)]).transform((value) => BigInt(String(value))),
    sha256: z.string().trim().min(32).max(128),
  });
  const ZVOD_MULTIPART_SIGN = z.object({
    checksumSha256: z.string().trim().regex(SHA256_BASE64_RE, "checksumSha256 必须是 SHA-256 Base64").optional().nullable(),
  });
  const ZVOD_COMPLETE = z.object({
    uploadSessionId: z.string().uuid(),
    proof: z.object({
      etag: z.string().trim().max(128).optional().nullable(),
      reportedPartCount: z.number().int().min(1).max(10_000).optional().nullable(),
    }).optional().nullable(),
  });
  const vodPrisma = prisma as any;

  const VOD_UPLOAD_SESSION_WITH_PARTS = {
    include: {
      parts: { orderBy: { partNumber: "asc" } },
    },
  } as const;

  async function syncMultipartSessionParts(session: any) {
    if (!session?.storageUploadId || !isMultipartVodAssetKind(session.assetKind)) {
      return vodPrisma.uploadSession.findUnique({
        where: { id: session.id },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
    }
    const remoteParts = await listPrivateMultipartParts(session.objectKey, session.storageUploadId);
    const uploadedBytes = remoteParts.reduce((sum, part) => sum + BigInt(part.size), 0n);
    await prisma.$transaction(async (tx: any) => {
      for (const part of remoteParts) {
        await tx.uploadSessionPart.upsert({
          where: {
            uploadSessionId_partNumber: {
              uploadSessionId: session.id,
              partNumber: part.partNumber,
            },
          },
          update: {
            etag: part.etag,
            bytes: part.size,
            status: "uploaded",
            uploadedAt: new Date(),
          },
          create: {
            uploadSessionId: session.id,
            partNumber: part.partNumber,
            etag: part.etag,
            bytes: part.size,
            status: "uploaded",
          },
        });
      }
      await touchUploadSession(tx, session.id, session.assetKind, {
        uploadedBytes,
        status:
          session.status === "paused" || session.status === "completed" || session.status === "cancelled" || session.status === "expired"
            ? session.status
            : remoteParts.length > 0
              ? "uploading"
              : session.status,
      });
    });
    return vodPrisma.uploadSession.findUnique({
      where: { id: session.id },
      include: { parts: { orderBy: { partNumber: "asc" } } },
    });
  }

  async function expireMultipartSessionIfNeeded(session: any, meta: ReturnType<typeof adminMeta>) {
    if (!session || session.expiresAt.getTime() >= Date.now() || ["completed", "cancelled", "expired"].includes(session.status)) {
      return session;
    }
    if (session.storageUploadId && isMultipartVodAssetKind(session.assetKind)) {
      try {
        await abortPrivateMultipartUpload(session.objectKey, session.storageUploadId);
      } catch (error) {
        emitSafetyEvent({
          event: "vod_upload_session_expire_abort_failed",
          errorClass: "unknown",
          adminId: meta.adminId,
          note: `session=${session.id}`,
        }, error);
      }
    }
    await prisma.$transaction(async (tx: any) => {
      await tx.uploadSession.update({
        where: { id: session.id },
        data: {
          status: "expired",
          lastActivityAt: new Date(),
        },
      });
      await writeAudit(tx, meta, "vod.upload_session.expire", "upload_session", session.id, serialize({ status: session.status }), serialize({ status: "expired" }), "upload session expired");
    });
    return vodPrisma.uploadSession.findUnique({
      where: { id: session.id },
      include: { parts: { orderBy: { partNumber: "asc" } } },
    });
  }

  async function resetMultipartCompletingSession(session: any) {
    return prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${session.id}))`;
      const locked = await tx.uploadSession.findUnique({
        where: { id: session.id },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      if (!locked || ["completed", "cancelled", "expired"].includes(locked.status)) {
        return locked;
      }
      const resumeStatus = (locked.parts || []).length > 0 ? "paused" : "uploading";
      await tx.uploadSession.update({
        where: { id: session.id },
        data: {
          status: resumeStatus,
          lastActivityAt: new Date(),
          expiresAt: nextUploadSessionExpiry(session.assetKind),
        },
      });
      return tx.uploadSession.findUnique({
        where: { id: session.id },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
    });
  }

  fastify.post(
    "/admin/contents/:contentId/assets/upload-session",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const contentId = ZID.parse(req.params.contentId);
      const body = ZVOD_UPLOAD_SESSION.parse(req.body);
      const meta = adminMeta(req);
      const content = await prisma.content.findUnique({
        where: { id: contentId },
        select: { id: true, status: true },
      });
      if (!content) {
        return reply.status(404).send({ error: VOD_ERROR_CLASS.content_not_found, message: "内容不存在" });
      }
      if (!isMimeAllowedForVodAsset(body.assetKind, body.mimeType)) {
        return reply.status(400).send({ error: VOD_ERROR_CLASS.invalid_input, errorClass: "mime_not_allowed", message: "文件 MIME 不在允许范围内" });
      }
      if (!isSizeAllowedForVodAsset(body.assetKind, body.byteSize)) {
        return reply.status(400).send({ error: VOD_ERROR_CLASS.invalid_input, errorClass: "file_too_large", message: "文件大小超出当前媒体类型限制" });
      }
      if (isMultipartVodAssetKind(body.assetKind)) {
        return reply.status(409).send({
          error: "multipart_required",
          message: "完整源视频必须使用 Multipart Upload 分片上传，请改走 multipart/initiate 接口。",
        });
      }
      const uploadSessionId = cryptoRandomUuid();
      const objectKey = generatePrivateObjectKey(body.assetKind, contentId, uploadSessionId, body.filename);
      if (!isAllowedPrivateObjectKey(objectKey)) {
        emitSafetyEvent({ event: "vod_upload_session_key_invalid", errorClass: "business", adminId: meta.adminId, note: `content=${contentId}` });
        return reply.status(500).send({ error: VOD_ERROR_CLASS.invalid_input, errorClass: "object_key_invalid", message: "对象存储路径生成失败" });
      }
      let uploadTarget;
      try {
        uploadTarget = await createPrivatePresignedUpload({
          sessionId: uploadSessionId,
          objectKey,
          mimeType: body.mimeType,
          contentLength: Number(body.byteSize),
          expectedSha256: body.sha256,
        });
      } catch (error) {
        emitSafetyEvent({ event: "vod_upload_session_create_failed", errorClass: "exhausted", adminId: meta.adminId, note: `kind=${body.assetKind}` }, error);
        return reply.status(503).send({ error: VOD_ERROR_CLASS.object_storage_unavailable, message: "对象存储暂不可用，无法创建上传会话" });
      }
      await prisma.$transaction(async (tx: any) => {
        await tx.uploadSession.create({
          data: {
            id: uploadSessionId,
            contentId,
            assetKind: body.assetKind,
            objectKey,
            originalFilename: body.filename,
            expectedSize: body.byteSize,
            expectedMime: body.mimeType,
            expectedSha256: body.sha256,
            storageUploadId: null,
            status: "uploading",
            partSize: null,
            totalParts: null,
            uploadedBytes: 0n,
            expiresAt: nextUploadSessionExpiry(body.assetKind),
            lastActivityAt: new Date(),
            createdBy: meta.adminId,
          },
        });
        await writeAudit(
          tx,
          meta,
          "vod.upload_session.create",
          "upload_session",
          uploadSessionId,
          null,
          serialize({ contentId, assetKind: body.assetKind, byteSize: body.byteSize.toString() }),
          `content=${contentId}`,
        );
      });
      return reply.send({
        uploadSessionId,
        uploadUrl: uploadTarget.uploadUrl,
        uploadExpiresAt: uploadTarget.uploadExpiresAt.toISOString(),
        expectedHttpHeaders: uploadTarget.expectedHttpHeaders,
      });
    },
  );

  fastify.post(
    "/admin/contents/:contentId/assets/multipart/initiate",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const contentId = ZID.parse(req.params.contentId);
      const body = ZVOD_UPLOAD_SESSION.parse(req.body);
      const meta = adminMeta(req);
      if (!isMultipartVodAssetKind(body.assetKind)) {
        return reply.status(400).send({ error: VOD_ERROR_CLASS.invalid_input, errorClass: "multipart_only_full_source", message: "只有完整源视频支持 Multipart Upload" });
      }
      const content = await prisma.content.findUnique({
        where: { id: contentId },
        select: { id: true },
      });
      if (!content) {
        return reply.status(404).send({ error: VOD_ERROR_CLASS.content_not_found, message: "内容不存在" });
      }
      if (!isMimeAllowedForVodAsset(body.assetKind, body.mimeType)) {
        return reply.status(400).send({ error: VOD_ERROR_CLASS.invalid_input, errorClass: "mime_not_allowed", message: "文件 MIME 不在允许范围内" });
      }
      if (!isSizeAllowedForVodAsset(body.assetKind, body.byteSize)) {
        return reply.status(400).send({ error: VOD_ERROR_CLASS.invalid_input, errorClass: "file_too_large", message: "文件大小超出当前媒体类型限制" });
      }
      const uploadSessionId = cryptoRandomUuid();
      const objectKey = generatePrivateObjectKey(body.assetKind, contentId, uploadSessionId, body.filename);
      const partSize = getPrivateMultipartPartSizeBytes();
      const totalParts = Math.max(1, Math.ceil(Number(body.byteSize) / partSize));
      let initResult;
      try {
        initResult = await createPrivateMultipartUpload({
          sessionId: uploadSessionId,
          objectKey,
          mimeType: body.mimeType,
          expectedSha256: body.sha256,
        });
      } catch (error) {
        emitSafetyEvent({ event: "vod_multipart_initiate_failed", errorClass: "exhausted", adminId: meta.adminId, note: `content=${contentId}` }, error);
        return reply.status(503).send({ error: VOD_ERROR_CLASS.object_storage_unavailable, message: "对象存储暂不可用，无法创建分片上传会话" });
      }
      await prisma.$transaction(async (tx: any) => {
        await tx.uploadSession.create({
          data: {
            id: uploadSessionId,
            contentId,
            assetKind: body.assetKind,
            status: "initiated",
            objectKey,
            originalFilename: body.filename,
            expectedSize: body.byteSize,
            expectedMime: body.mimeType,
            expectedSha256: body.sha256,
            storageUploadId: initResult.storageUploadId,
            partSize,
            totalParts,
            uploadedBytes: 0n,
            expiresAt: nextUploadSessionExpiry(body.assetKind),
            lastActivityAt: new Date(),
            createdBy: meta.adminId,
          },
        });
        await writeAudit(
          tx,
          meta,
          "vod.multipart.initiate",
          "upload_session",
          uploadSessionId,
          null,
          serialize({ contentId, assetKind: body.assetKind, partSize, totalParts, byteSize: body.byteSize.toString() }),
          "initiate multipart upload",
        );
      });
      return reply.send({
        uploadSessionId,
        storageUploadId: initResult.storageUploadId,
        partSize,
        totalParts,
        expiresAt: nextUploadSessionExpiry(body.assetKind).toISOString(),
        maxConcurrency: VOD_MULTIPART_MAX_CONCURRENCY,
      });
    },
  );

  fastify.post(
    "/admin/upload-sessions/:sessionId/parts/:partNumber/sign",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const sessionId = ZID.parse(req.params.sessionId);
      const partNumber = z.coerce.number().int().min(1).parse(req.params.partNumber);
      const bodyResult = ZVOD_MULTIPART_SIGN.safeParse(req.body || {});
      if (!bodyResult.success) {
        return reply.status(400).send({
          error: VOD_ERROR_CLASS.invalid_input,
          errorClass: "invalid_checksum_sha256",
          message: "checksumSha256 必须是严格的 SHA-256 Base64 字符串",
          details: bodyResult.error.flatten(),
        });
      }
      const body = bodyResult.data;
      const meta = adminMeta(req);
      let session = await vodPrisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      if (!session || !isMultipartVodAssetKind(session.assetKind) || !session.storageUploadId) {
        return reply.status(404).send({ error: VOD_ERROR_CLASS.upload_session_invalid, message: "分片上传会话不存在" });
      }
      session = await expireMultipartSessionIfNeeded(session, meta);
      if (!session || session.status === "expired") {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.upload_session_expired, message: "上传会话已过期，请重新发起上传" });
      }
      if (!session.totalParts || partNumber < 1 || partNumber > session.totalParts) {
        return reply.status(400).send({ error: VOD_ERROR_CLASS.invalid_input, errorClass: "part_number_out_of_range", message: "分片编号超出允许范围" });
      }
      if (!["initiated", "uploading", "paused"].includes(session.status)) {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.upload_session_invalid, errorClass: "upload_session_not_writable", message: "当前会话状态不允许继续上传分片" });
      }
      let signed;
      try {
        signed = await createPrivateMultipartPartUploadUrl({
          objectKey: session.objectKey,
          storageUploadId: session.storageUploadId,
          partNumber,
          checksumSha256: body.checksumSha256 || null,
        });
      } catch (error) {
        emitSafetyEvent({ event: "vod_multipart_part_sign_failed", errorClass: "exhausted", adminId: meta.adminId, note: `session=${sessionId} part=${partNumber}` }, error);
        return reply.status(503).send({ error: VOD_ERROR_CLASS.object_storage_unavailable, message: "对象存储暂不可用，无法签发分片上传地址" });
      }
      await touchUploadSession(vodPrisma, session.id, session.assetKind, { status: "uploading" });
      return reply.send({
        uploadSessionId: session.id,
        partNumber,
        uploadUrl: signed.uploadUrl,
        uploadExpiresAt: signed.uploadExpiresAt.toISOString(),
        expectedHttpHeaders: signed.expectedHttpHeaders,
      });
    },
  );

  fastify.get(
    "/admin/upload-sessions/:sessionId",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const sessionId = ZID.parse(req.params.sessionId);
      const meta = adminMeta(req);
      let session = await vodPrisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      if (!session) {
        return reply.status(404).send({ error: VOD_ERROR_CLASS.upload_session_invalid, message: "上传会话不存在" });
      }
      session = await expireMultipartSessionIfNeeded(session, meta);
      if (!session) {
        return reply.status(404).send({ error: VOD_ERROR_CLASS.upload_session_invalid, message: "上传会话不存在" });
      }
      if (isMultipartVodAssetKind(session.assetKind) && session.storageUploadId && !["cancelled", "expired"].includes(session.status)) {
        try {
          session = await syncMultipartSessionParts(session);
        } catch (error) {
          emitSafetyEvent({ event: "vod_multipart_list_parts_failed", errorClass: "unknown", adminId: meta.adminId, note: `session=${sessionId}` }, error);
          return reply.status(503).send({ error: VOD_ERROR_CLASS.object_storage_unavailable, message: "对象存储暂不可用，无法刷新分片状态" });
        }
      }
      const uploadedBytes = BigInt(String(session.uploadedBytes || 0));
      const expectedSize = BigInt(String(session.expectedSize || 0));
      return reply.send({
        session: summarizeUploadSession(session),
        progressPercent: expectedSize > 0n ? Number((uploadedBytes * 10000n) / expectedSize) / 100 : 0,
      });
    },
  );

  fastify.post(
    "/admin/contents/:contentId/assets/complete",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const contentId = ZID.parse(req.params.contentId);
      const body = ZVOD_COMPLETE.parse(req.body);
      const meta = adminMeta(req);
      const [content, session] = await Promise.all([
        prisma.content.findUnique({ where: { id: contentId }, select: { id: true } }),
        vodPrisma.uploadSession.findUnique({ where: { id: body.uploadSessionId } }),
      ]);
      if (!content) {
        return reply.status(404).send({ error: VOD_ERROR_CLASS.content_not_found, message: "内容不存在" });
      }
      if (!session || session.contentId !== contentId) {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.upload_session_invalid, message: "上传会话不存在或不属于当前内容" });
      }
      if (isMultipartVodAssetKind(session.assetKind)) {
        return reply.status(409).send({
          error: "multipart_required",
          message: "完整源视频必须调用 /admin/upload-sessions/:sessionId/complete 完成分片合并。",
        });
      }
      if (session.expiresAt.getTime() < Date.now()) {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.upload_session_expired, message: "上传会话已过期，请重新发起上传" });
      }
      let storageEnv;
      try {
        storageEnv = requireObjectStorageEnv();
      } catch (error) {
        emitSafetyEvent({ event: "vod_complete_storage_unavailable", errorClass: "exhausted", adminId: meta.adminId, note: `content=${contentId}` }, error);
        return reply.status(503).send({ error: VOD_ERROR_CLASS.object_storage_unavailable, message: "对象存储暂不可用，无法校验上传结果" });
      }
      const verify = await headObject(storageEnv.bucket, session.objectKey);
      if (!verify.ok || !verify.head) {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.object_not_found, errorClass: sanitizeErrorClass(verify.userError), message: "对象存储中未找到上传文件，请重新上传" });
      }
      const headMeta = normalizeHeadMetadata(verify.head);
      const expectedSize = BigInt(String(session.expectedSize));
      const expectedMime = String(session.expectedMime || "").trim().toLowerCase();
      const expectedSha256 = String(session.expectedSha256 || "").trim();
      const mismatches: string[] = [];
      if (headMeta.contentLength == null || headMeta.contentLength !== expectedSize) mismatches.push("byte_size");
      if ((headMeta.contentType || "").trim().toLowerCase() !== expectedMime) mismatches.push("mime_type");
      if (headMeta.uploadSessionId && headMeta.uploadSessionId !== session.id) mismatches.push("upload_session_id");
      const observedSha256 = headMeta.checksumSha256 || headMeta.metadataSha256;
      if (!observedSha256 || observedSha256 !== expectedSha256) mismatches.push("sha256");
      if (mismatches.length > 0) {
        emitSafetyEvent({
          event: "vod_complete_object_mismatch",
          errorClass: "conflict",
          adminId: meta.adminId,
          note: `content=${contentId} mismatches=${mismatches.join(",")}`,
        });
        return reply.status(409).send({
          error: VOD_ERROR_CLASS.object_metadata_mismatch,
          errorClass: "upload_verify_failed",
          message: "上传对象校验失败，请确认文件与会话信息一致后重新上传",
        });
      }

      const result = await prisma.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${session.id}))`;
        const lockedSession = await tx.uploadSession.findUnique({ where: { id: session.id } });
        const existingAsset = await tx.videoAsset.findFirst({
          where: { uploadSessionId: session.id },
          include: {
            transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
            renditions: { orderBy: [{ kind: "asc" }] },
          },
        });
        if (lockedSession?.completedAt && existingAsset) {
          return existingAsset;
        }
        const asset = existingAsset
          ? await tx.videoAsset.update({
              where: { id: existingAsset.id },
              data: {
                objectKey: session.objectKey,
                originalFilename: session.originalFilename,
                mimeType: session.expectedMime,
                byteSize: expectedSize,
                sha256: expectedSha256,
                status: "verified",
                errorClass: null,
                verifiedAt: new Date(),
              },
            })
          : await tx.videoAsset.create({
              data: {
                contentId,
                uploadSessionId: session.id,
                kind: session.assetKind,
                objectKey: session.objectKey,
                originalFilename: session.originalFilename,
                mimeType: session.expectedMime,
                byteSize: expectedSize,
                sha256: expectedSha256,
                status: "verified",
                verifiedAt: new Date(),
              },
            });
        if (session.assetKind !== "cover") {
          await tx.transcodeJob.upsert({
            where: { assetId: asset.id },
            update: {},
            create: {
              contentId,
              assetId: asset.id,
              status: "queued",
            },
          });
        }
        await tx.uploadSession.update({
          where: { id: session.id },
          data: {
            status: "completed",
            completedAt: new Date(),
            uploadedBytes: expectedSize,
            lastActivityAt: new Date(),
            expiresAt: nextUploadSessionExpiry(session.assetKind),
          },
        });
        if (!existingAsset) {
          await writeAudit(
            tx,
            meta,
            "vod.asset.complete",
            "video_asset",
            asset.id,
            null,
            serialize({ contentId, kind: asset.kind, status: asset.status, byteSize: asset.byteSize.toString() }),
            body.proof?.etag || null,
          );
        }
        return tx.videoAsset.findUnique({
          where: { id: asset.id },
          include: {
            transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
            renditions: { orderBy: [{ kind: "asc" }] },
          },
        });
      });

      return reply.send({ ok: true, asset: summarizeVodAsset(result) });
    },
  );

  fastify.post(
    "/admin/upload-sessions/:sessionId/pause",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const sessionId = ZID.parse(req.params.sessionId);
      const meta = adminMeta(req);
      let session = await vodPrisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      if (!session) return reply.status(404).send({ error: VOD_ERROR_CLASS.upload_session_invalid, message: "上传会话不存在" });
      session = await expireMultipartSessionIfNeeded(session, meta);
      if (!session || session.status === "expired") {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.upload_session_expired, message: "上传会话已过期，请重新发起上传" });
      }
      if (session.status !== "completed" && session.status !== "cancelled") {
        session = await touchUploadSession(vodPrisma, session.id, session.assetKind, { status: "paused" });
      }
      const refreshed = await vodPrisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      return reply.send({ ok: true, session: summarizeUploadSession(refreshed) });
    },
  );

  fastify.post(
    "/admin/upload-sessions/:sessionId/resume",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const sessionId = ZID.parse(req.params.sessionId);
      const meta = adminMeta(req);
      let session = await vodPrisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      if (!session) return reply.status(404).send({ error: VOD_ERROR_CLASS.upload_session_invalid, message: "上传会话不存在" });
      session = await expireMultipartSessionIfNeeded(session, meta);
      if (!session || session.status === "expired") {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.upload_session_expired, message: "上传会话已过期，请重新发起上传" });
      }
      if (session.status === "cancelled") {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.upload_session_invalid, errorClass: "upload_session_cancelled", message: "上传已取消，不能继续恢复" });
      }
      await touchUploadSession(vodPrisma, session.id, session.assetKind, { status: "uploading" });
      session = await vodPrisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      if (isMultipartVodAssetKind(session.assetKind) && session.storageUploadId) {
        session = await syncMultipartSessionParts(session);
      }
      return reply.send({ ok: true, session: summarizeUploadSession(session) });
    },
  );

  fastify.post(
    "/admin/upload-sessions/:sessionId/abort",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const sessionId = ZID.parse(req.params.sessionId);
      const meta = adminMeta(req);
      const session = await vodPrisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      if (!session) return reply.status(404).send({ error: VOD_ERROR_CLASS.upload_session_invalid, message: "上传会话不存在" });
      if (session.status !== "completed" && session.status !== "cancelled" && session.storageUploadId && isMultipartVodAssetKind(session.assetKind)) {
        try {
          await abortPrivateMultipartUpload(session.objectKey, session.storageUploadId);
        } catch (error) {
          emitSafetyEvent({ event: "vod_multipart_abort_failed", errorClass: "unknown", adminId: meta.adminId, note: `session=${session.id}` }, error);
          return reply.status(503).send({ error: VOD_ERROR_CLASS.object_storage_unavailable, message: "对象存储暂不可用，无法取消上传" });
        }
      }
      await prisma.$transaction(async (tx: any) => {
        await tx.uploadSession.update({
          where: { id: session.id },
          data: {
            status: "cancelled",
            lastActivityAt: new Date(),
          },
        });
        await writeAudit(tx, meta, "vod.upload_session.abort", "upload_session", session.id, serialize({ status: session.status }), serialize({ status: "cancelled" }), "multipart upload aborted");
      });
      const refreshed = await vodPrisma.uploadSession.findUnique({
        where: { id: session.id },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      return reply.send({ ok: true, session: summarizeUploadSession(refreshed) });
    },
  );

  fastify.post(
    "/admin/upload-sessions/:sessionId/complete",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const sessionId = ZID.parse(req.params.sessionId);
      const meta = adminMeta(req);
      let session = await vodPrisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { parts: { orderBy: { partNumber: "asc" } } },
      });
      if (!session || !isMultipartVodAssetKind(session.assetKind) || !session.storageUploadId) {
        return reply.status(404).send({ error: VOD_ERROR_CLASS.upload_session_invalid, message: "分片上传会话不存在" });
      }
      session = await expireMultipartSessionIfNeeded(session, meta);
      if (!session || session.status === "expired") {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.upload_session_expired, message: "上传会话已过期，请重新发起上传" });
      }
      if (session.status === "cancelled") {
        return reply.status(409).send({ error: VOD_ERROR_CLASS.upload_session_invalid, errorClass: "upload_session_cancelled", message: "上传已取消，不能继续完成" });
      }
      try {
        session = await syncMultipartSessionParts(session);
      } catch (error) {
        emitSafetyEvent({ event: "vod_multipart_sync_before_complete_failed", errorClass: "unknown", adminId: meta.adminId, note: `session=${session.id}` }, error);
        return reply.status(503).send({ error: VOD_ERROR_CLASS.object_storage_unavailable, message: "对象存储暂不可用，无法刷新分片状态" });
      }
      const uploadedPartNumbers = new Set((session.parts || []).map((part: any) => part.partNumber));
      const missingParts: number[] = [];
      const totalParts = session.totalParts || 0;
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        if (!uploadedPartNumbers.has(partNumber)) missingParts.push(partNumber);
      }
      if (missingParts.length > 0) {
        return reply.status(409).send({
          error: VOD_ERROR_CLASS.invalid_input,
          errorClass: "multipart_parts_incomplete",
          message: `仍有 ${missingParts.length} 个分片未完成上传`,
          missingParts,
        });
      }
      const preflight = await prisma.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${session.id}))`;
        const lockedSession = await tx.uploadSession.findUnique({
          where: { id: session.id },
          include: { parts: { orderBy: { partNumber: "asc" } } },
        });
        const existingAsset = await tx.videoAsset.findFirst({
          where: { uploadSessionId: session.id },
          include: {
            transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
            renditions: { orderBy: [{ kind: "asc" }] },
          },
        });
        if (lockedSession?.completedAt && existingAsset) {
          await syncContentFullVideoBindings(tx, session.contentId);
          return { done: true as const, asset: existingAsset };
        }
        await tx.uploadSession.update({
          where: { id: session.id },
          data: {
            status: "completing",
            lastActivityAt: new Date(),
            expiresAt: nextUploadSessionExpiry(session.assetKind),
          },
        });
        return {
          done: false as const,
          parts: (lockedSession?.parts || []).map((part: any) => ({ partNumber: part.partNumber, etag: part.etag })),
        };
      });
      if (preflight.done) {
        return reply.send({ ok: true, asset: summarizeVodAsset(preflight.asset) });
      }
      let completeErrored = false;
      try {
        await completePrivateMultipartUpload({
          objectKey: session.objectKey,
          storageUploadId: session.storageUploadId,
          parts: preflight.parts,
        });
      } catch (error: any) {
        completeErrored = true;
        emitSafetyEvent({ event: "vod_multipart_complete_storage_failed", errorClass: "unknown", adminId: meta.adminId, note: `session=${session.id}` }, error);
      }

      let storageEnv;
      try {
        storageEnv = requireObjectStorageEnv();
      } catch (error) {
        emitSafetyEvent({ event: "vod_multipart_complete_storage_env_missing", errorClass: "exhausted", adminId: meta.adminId, note: `session=${session.id}` }, error);
        return reply.status(503).send({ error: VOD_ERROR_CLASS.object_storage_unavailable, message: "对象存储暂不可用，无法完成最终校验" });
      }
      const verify = await headObject(storageEnv.bucket, session.objectKey);
      if (!verify.ok || !verify.head) {
        await resetMultipartCompletingSession(session);
        return reply.status(503).send({
          error: VOD_ERROR_CLASS.object_storage_unavailable,
          errorClass: completeErrored ? "multipart_complete_unconfirmed" : sanitizeErrorClass(verify.userError),
          message: "对象存储暂不可用，暂时无法确认完整视频合并结果，请稍后重试",
        });
      }
      const headMeta = normalizeHeadMetadata(verify.head);
      const expectedSize = BigInt(String(session.expectedSize));
      const expectedMime = String(session.expectedMime || "").trim().toLowerCase();
      const expectedSha256 = String(session.expectedSha256 || "").trim();
      const mismatches: string[] = [];
      if (headMeta.contentLength == null || headMeta.contentLength !== expectedSize) mismatches.push("byte_size");
      if ((headMeta.contentType || "").trim().toLowerCase() !== expectedMime) mismatches.push("mime_type");
      if (headMeta.uploadSessionId && headMeta.uploadSessionId !== session.id) mismatches.push("upload_session_id");
      if ((headMeta.metadataSha256 || "").trim() !== expectedSha256) mismatches.push("sha256_metadata");
      if (mismatches.length > 0) {
        await resetMultipartCompletingSession(session);
        return reply.status(409).send({
          error: VOD_ERROR_CLASS.object_metadata_mismatch,
          errorClass: "upload_verify_failed",
          message: "合并后的对象校验失败，请重新发起上传",
        });
      }
      const result = await prisma.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${session.id}))`;
        const lockedSession = await tx.uploadSession.findUnique({ where: { id: session.id } });
        const existingAsset = await tx.videoAsset.findFirst({
          where: { uploadSessionId: session.id },
          include: { transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 } },
        });
        if (lockedSession?.completedAt && existingAsset) {
          await syncContentFullVideoBindings(tx, session.contentId);
          return existingAsset;
        }
        const asset = existingAsset
          ? await tx.videoAsset.update({
              where: { id: existingAsset.id },
              data: {
                objectKey: session.objectKey,
                originalFilename: session.originalFilename,
                mimeType: session.expectedMime,
                byteSize: expectedSize,
                sha256: expectedSha256,
                status: "verified",
                errorClass: null,
                verifiedAt: new Date(),
              },
            })
          : await tx.videoAsset.create({
              data: {
                contentId: session.contentId,
                uploadSessionId: session.id,
                kind: session.assetKind,
                objectKey: session.objectKey,
                originalFilename: session.originalFilename,
                mimeType: session.expectedMime,
                byteSize: expectedSize,
                sha256: expectedSha256,
                status: "verified",
                verifiedAt: new Date(),
              },
            });
        await tx.transcodeJob.upsert({
          where: { assetId: asset.id },
          update: {},
          create: {
            contentId: session.contentId,
            assetId: asset.id,
            status: "queued",
          },
        });
        await tx.uploadSession.update({
          where: { id: session.id },
          data: {
            status: "completed",
            completedAt: new Date(),
            uploadedBytes: expectedSize,
            lastActivityAt: new Date(),
            expiresAt: nextUploadSessionExpiry(session.assetKind),
          },
        });
        if (!existingAsset) {
          await writeAudit(
            tx,
            meta,
            "vod.multipart.complete",
            "video_asset",
            asset.id,
            null,
            serialize({ contentId: session.contentId, kind: asset.kind, status: asset.status, byteSize: asset.byteSize.toString() }),
            "multipart complete",
          );
        }
        await syncContentFullVideoBindings(tx, session.contentId);
        return tx.videoAsset.findUnique({
          where: { id: asset.id },
          include: {
            transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
            renditions: { orderBy: [{ kind: "asc" }] },
          },
        });
      });
      return reply.send({ ok: true, asset: summarizeVodAsset(result) });
    },
  );

  fastify.get(
    "/admin/contents/:contentId/media",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const contentId = ZID.parse(req.params.contentId);
      const content = await prisma.content.findUnique({
        where: { id: contentId },
        select: {
          id: true,
          status: true,
          coverAsset: {
            select: {
              id: true, kind: true, status: true, originalFilename: true, mimeType: true,
              contentLength: true, storagePublicUrl: true, lastErrorClass: true, lastVerifiedAt: true, createdAt: true,
            },
          },
          previewAsset: {
            select: {
              id: true, kind: true, status: true, originalFilename: true, mimeType: true,
              contentLength: true, storagePublicUrl: true, lastErrorClass: true, lastVerifiedAt: true, createdAt: true,
            },
          },
        },
      });
      if (!content) {
        return reply.status(404).send({ error: VOD_ERROR_CLASS.content_not_found, message: "内容不存在" });
      }
      const [assets, pendingSessions] = await Promise.all([
        vodPrisma.videoAsset.findMany({
          where: { contentId, status: { not: "deleted" } },
          include: {
            transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
            renditions: { orderBy: [{ kind: "asc" }] },
          },
          orderBy: [{ createdAt: "asc" }],
        }),
        vodPrisma.uploadSession.findMany({
          where: { contentId, status: { notIn: ["completed", "cancelled", "expired"] }, expiresAt: { gte: new Date() } },
          include: { parts: { orderBy: { partNumber: "asc" } } },
          orderBy: [{ createdAt: "asc" }],
        }),
      ]);
      const assetSessionIds = new Set(assets.map((item: any) => item.uploadSessionId).filter(Boolean));
      const lightAssets = [content.coverAsset, content.previewAsset]
        .filter((item: any) => item && item.status !== "deleted")
        .map((item: any) => summarizeLightMediaAsset(item));
      const pendingItems = pendingSessions
        .filter((session: any) => !assetSessionIds.has(session.id))
        .map((session: any) => ({
          id: session.id,
          kind: session.assetKind,
          filename: summarizeFilename(session.originalFilename),
          byteSize: session.expectedSize != null ? String(session.expectedSize) : null,
          mimeType: session.expectedMime || null,
          status: session.status === "failed" ? "failed" : "uploading",
          errorClass: null,
          verifiedAt: null,
          createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
          transcode: null,
        }));
      return reply.send({
        contentStatus: content.status,
        items: [...lightAssets, ...assets.map((row: any) => summarizeVodAsset(row)), ...pendingItems],
        uploadSessions: pendingSessions.map((session: any) => summarizeUploadSession(session)),
      });
    },
  );

  // VOD 封面位于 video_assets（而非旧 media_assets）。只允许后台已登录用户
  // 通过此跳转读取一张短时签名预览，列表接口不会泄露对象 Key 或 Bucket。
  fastify.get(
    "/admin/vod-assets/:id/preview",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const asset = await vodPrisma.videoAsset.findUnique({
        where: { id },
        select: { kind: true, status: true, deletedAt: true, objectKey: true },
      });
      if (!asset || asset.kind !== "cover" || asset.status !== "verified" || asset.deletedAt) {
        return reply.status(404).send({ error: "not_found" });
      }
      try {
        const signed = await createPrivatePresignedReadUrl(asset.objectKey);
        return reply.redirect(signed.downloadUrl);
      } catch (error) {
        emitSafetyEvent({ event: "vod_cover_preview_sign_failed", errorClass: "object_storage_unavailable", note: `asset=${id}` }, error);
        return reply.status(503).send({ error: VOD_ERROR_CLASS.object_storage_unavailable, message: "封面预览暂不可用" });
      }
    },
  );

  fastify.post(
    "/admin/transcode-jobs/:id/retry",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const meta = adminMeta(req);
      const updated = await prisma.$transaction(async (tx: any) => {
        const job = await tx.transcodeJob.findUnique({
          where: { id },
          include: {
            asset: {
              include: {
                renditions: { orderBy: [{ kind: "asc" }] },
                transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
              },
            },
          },
        });
        if (!job) return { error: "not_found" as const };
        if (job.status !== "failed") return { error: "job_status_not_retryable" as const, job };
        const after = await tx.transcodeJob.update({
          where: { id },
          data: {
            status: "queued",
            errorClass: null,
            workerId: null,
            leaseUntil: null,
            lastHeartbeatAt: null,
            progressPercent: 0,
            queuedAt: new Date(),
            finishedAt: null,
          },
        });
        await tx.videoRendition.updateMany({
          where: { assetId: job.assetId, status: { in: ["failed", "processing"] } },
          data: {
            status: "pending",
            errorClass: null,
            readyAt: null,
          },
        });
        await writeAudit(tx, meta, "transcode_job.retry", "transcode_job", id, serialize({ status: job.status, errorClass: job.errorClass }), serialize({ status: after.status }), "manual retry");
        return {
          error: null,
          job: await tx.transcodeJob.findUnique({ where: { id } }),
          asset: await tx.videoAsset.findUnique({
            where: { id: job.assetId },
            include: {
              transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
              renditions: { orderBy: [{ kind: "asc" }] },
            },
          }),
        };
      });
      if (updated.error === "not_found") return reply.status(404).send({ error: "not_found", message: "转码任务不存在" });
      if (updated.error === "job_status_not_retryable") {
        return reply.status(409).send({ error: "job_status_not_retryable", message: `当前 status=${updated.job.status}；仅 failed 任务允许重试。` });
      }
      return reply.send({ ok: true, job: updated.job, asset: summarizeVodAsset(updated.asset) });
    },
  );

  fastify.post(
    "/admin/transcode-jobs/:id/cancel",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const meta = adminMeta(req);
      const updated = await prisma.$transaction(async (tx: any) => {
        const job = await tx.transcodeJob.findUnique({
          where: { id },
          include: {
            asset: {
              include: {
                renditions: { orderBy: [{ kind: "asc" }] },
                transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
              },
            },
          },
        });
        if (!job) return { error: "not_found" as const };
        if (!["queued", "processing"].includes(job.status)) return { error: "job_status_not_cancellable" as const, job };
        const after = await tx.transcodeJob.update({
          where: { id },
          data: {
            status: "cancelled",
            errorClass: "job_cancelled",
            workerId: null,
            leaseUntil: null,
            lastHeartbeatAt: new Date(),
            progressPercent: 0,
            finishedAt: new Date(),
          },
        });
        await tx.videoRendition.updateMany({
          where: { assetId: job.assetId, status: "processing" },
          data: {
            status: "failed",
            errorClass: "job_cancelled",
          },
        });
        await writeAudit(tx, meta, "transcode_job.cancel", "transcode_job", id, serialize({ status: job.status }), serialize({ status: after.status }), "manual cancel");
        return {
          error: null,
          job: after,
          asset: await tx.videoAsset.findUnique({
            where: { id: job.assetId },
            include: {
              transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
              renditions: { orderBy: [{ kind: "asc" }] },
            },
          }),
        };
      });
      if (updated.error === "not_found") return reply.status(404).send({ error: "not_found", message: "转码任务不存在" });
      if (updated.error === "job_status_not_cancellable") {
        return reply.status(409).send({ error: "job_status_not_cancellable", message: `当前 status=${updated.job.status}；仅 queued/processing 任务允许取消。ready 产物不能通过此接口删除。` });
      }
      return reply.send({ ok: true, job: updated.job, asset: summarizeVodAsset(updated.asset) });
    },
  );

  fastify.delete(
    "/admin/contents/:contentId/assets/:assetId",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const contentId = ZID.parse(req.params.contentId);
      const assetId = ZID.parse(req.params.assetId);
      const meta = adminMeta(req);
      const [content, asset] = await Promise.all([
        prisma.content.findUnique({ where: { id: contentId }, select: { id: true, status: true } }),
        vodPrisma.videoAsset.findFirst({
          where: { id: assetId, contentId },
          include: {
            transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
            renditions: { orderBy: [{ kind: "asc" }] },
          },
        }),
      ]);
      if (!content) {
        return reply.status(404).send({ error: VOD_ERROR_CLASS.content_not_found, message: "内容不存在" });
      }
      if (!asset) {
        return reply.status(404).send({ error: "asset_not_found", message: "媒体记录不存在" });
      }
      if (content.status === "published" && meta.adminRole !== "super_admin") {
        return reply.status(403).send({ error: VOD_ERROR_CLASS.forbidden, message: "已发布内容的媒体仅允许超管删除" });
      }
      const deleted = await prisma.$transaction(async (tx: any) => {
        const updated = await tx.videoAsset.update({
          where: { id: asset.id },
          data: {
            status: "deleted",
            deletedAt: new Date(),
            errorClass: VOD_ERROR_CLASS.deleted,
          },
        });
        await tx.transcodeJob.updateMany({
          where: { assetId: asset.id, status: { in: ["queued", "processing"] } },
          data: { status: "cancelled", errorClass: VOD_ERROR_CLASS.deleted, finishedAt: new Date() },
        });
        await syncContentFullVideoBindings(tx, contentId);
        await writeAudit(tx, meta, "vod.asset.delete", "video_asset", asset.id, serialize({ status: asset.status }), serialize({ status: "deleted" }), `content=${contentId}`);
        return tx.videoAsset.findUnique({
          where: { id: asset.id },
          include: {
            transcodeJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
            renditions: { orderBy: [{ kind: "asc" }] },
          },
        });
      });
      return reply.send({ ok: true, asset: summarizeVodAsset(deleted) });
    },
  );

  // 后台内容列表的“前往私密视频”入口。链接只在此受控跳转边界生成，
  // 不把 t.me/c/... 或频道标识作为 JSON 字段返回给浏览器。
  fastify.get(
    "/admin/contents/:id/private-video",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const content = await prisma.content.findUnique({
        where: { id },
        select: {
          accessType: true,
          packageId: true,
          telegramMessageId: true,
          telegramChatFingerprint: true,
          package: { select: { channelId: true, channelIdCiphertext: true } },
        },
      });
      if (!content) return reply.status(404).send({ error: "not_found", message: "内容不存在" });
      if (content.accessType === "public" || content.accessType === "single") {
        return reply.status(409).send({ error: "private_video_not_applicable", message: "该内容不使用私密频道完整视频交付" });
      }
      if (content.telegramMessageId == null || !content.telegramChatFingerprint) {
        return reply.status(409).send({ error: "private_video_not_linked", message: "该内容尚未关联私密频道的视频消息" });
      }

      let channelRef: ChannelRef | null = null;
      if (content.accessType === "membership") {
        channelRef = await resolveMembershipChannelRef(prisma);
      } else if (content.accessType === "package") {
        const channelId = resolvePackageChannelId({
          channelId: content.package?.channelId ?? null,
          channelIdCiphertext: content.package?.channelIdCiphertext ?? null,
        });
        if (channelId != null) channelRef = refRawChatId(channelId);
      }
      if (!channelRef || content.telegramChatFingerprint !== channelRefFingerprint(channelRef)) {
        return reply.status(409).send({ error: "private_video_channel_mismatch", message: "私密频道映射未完成或已变更，请重新关联频道消息" });
      }
      const targetUrl = buildPrivateChannelPostUrl(channelRef, content.telegramMessageId);
      if (!targetUrl) return reply.status(409).send({ error: "private_video_link_unavailable", message: "无法生成该私密视频跳转入口" });
      return reply.redirect(targetUrl, 302);
    },
  );

  fastify.post(
    "/admin/contents",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const body = ZCONTENT_CREATE.parse(req.body);
      const meta = adminMeta(req);
      const contentId = cryptoRandomUuid();
      const preCheck = await validateContentAccessTypeConstraints({
        prisma,
        targetContentId: contentId,
        accessType: body.accessType as AccessTypeBound,
        packageId: body.packageId,
        productId: body.productId,
        freeChannelCode: body.freeChannelCode,
        coverAssetId: body.coverAssetId ?? null,
        previewAssetId: body.previewAssetId ?? null,
        fullVideoAssetId: body.fullVideoAssetId ?? null,
        fullVideoAssetIds: body.fullVideoAssetIds,
        allowDraftWithoutDeliveryMedia: true,
      });
      if (!preCheck.ok) {
        return reply.status(preCheck.status).send({ error: preCheck.error, message: preCheck.message, details: preCheck.details });
      }
      const { reason, categoryIds, ...payload } = body;
      const previewPolicy = normalizePreviewPolicy(payload);
      const fullVideoAssetIds = normalizeFullVideoAssetIds(payload.fullVideoAssetIds, payload.fullVideoAssetId);
      const parseDates = (d: any) => (d ? new Date(d) : null);
      const normalizedSeo = normalizeSeoPayload(payload);
      const normalizedTags = normalizeContentTagsPayload(payload.tags);
      const validationFailures = [
        ...(normalizedSeo.ok ? [] : normalizedSeo.failures),
        ...(normalizedTags.ok ? [] : normalizedTags.failures),
      ];
      if (validationFailures.length > 0) {
        return reply.status(400).send(buildValidationErrorResponse(validationFailures));
      }

      // 轻媒体继续从 MediaAsset 回填封面/试看冗余列；完整视频以 VideoAsset 为真源，不再从 MediaAsset 读。
      const lightAssetFk: Array<string | null> = [payload.coverAssetId ?? null, payload.previewAssetId ?? null];
      const assets = lightAssetFk.some((x) => x != null)
        ? await prisma.mediaAsset.findMany({
            where: { id: { in: lightAssetFk.filter((x): x is string => x != null) } },
            select: { id: true, kind: true, storagePublicUrl: true, durationSeconds: true },
          })
        : [];
      const am = new Map(assets.map((a) => [a.id, a]));
      const coverAsset = payload.coverAssetId ? am.get(payload.coverAssetId) : undefined;
      const previewAsset = payload.previewAssetId ? am.get(payload.previewAssetId) : undefined;
      const redundantCoverUrl = coverAsset?.storagePublicUrl || null;
      const redundantPreviewUrl = previewAsset?.storagePublicUrl || null;
      const redundantDuration = payload.durationSeconds ?? previewAsset?.durationSeconds ?? null;

      const data: any = {
        title: payload.title,
        coverUrl: (payload.coverUrl != null ? payload.coverUrl : redundantCoverUrl) ?? null,
        thumbnailUrl: payload.thumbnailUrl ?? null,
        description: payload.description ?? null,
        tags: normalizedTags.value,
        seoTitle: normalizedSeo.value.seoTitle,
        seoDescription: normalizedSeo.value.seoDescription,
        seoKeywords: normalizedSeo.value.seoKeywords,
        geoKeywords: normalizedSeo.value.geoKeywords,
        previewUrl: (payload.previewUrl != null ? payload.previewUrl : redundantPreviewUrl) ?? null,
        previewEnabled: previewPolicy.previewEnabled,
        previewDurationSeconds: previewPolicy.previewDurationSeconds,
        durationSeconds: payload.durationSeconds ?? redundantDuration ?? null,
        accessType: payload.accessType,
        isRecommended: payload.isRecommended,
        isFeatured: payload.isFeatured,
        isNewArrival: payload.isNewArrival,
        featuredSort: payload.featuredSort ?? null,
        sortOrder: payload.sortOrder,
        recommendStartsAt: parseDates(payload.recommendStartsAt),
        recommendEndsAt: parseDates(payload.recommendEndsAt),
        scheduledAt: parseDates(payload.scheduledAt),
        packageId: payload.packageId ?? null,
        productId: payload.productId ?? null,
        coverAssetId: payload.coverAssetId ?? null,
        previewAssetId: payload.previewAssetId ?? null,
        fullVideoAssetId: fullVideoAssetIds[0] ?? null,
        status: "draft",
        lastEditorId: meta.adminId,
      };
      const result = await prisma.$transaction(async (tx: any) => {
        const created = await tx.content.create({
          data: {
            id: contentId,
            ...data,
            categories: categoryIds.length
              ? { create: categoryIds.map((cid, i) => ({ categoryId: cid, displayOrder: i, assignedBy: meta.adminId })) }
              : undefined,
          },
          include: { categories: { orderBy: { displayOrder: "asc" } } },
        });
        if (fullVideoAssetIds.length > 0) {
          await tx.contentFullVideoSegment.createMany({
            data: fullVideoAssetIds.map((videoAssetId, index) => ({ contentId: created.id, videoAssetId, segmentOrder: index + 1 })),
          });
        }
        await writeAudit(
          tx, meta, "content.create", "content", created.id,
          null,
          stripSensitiveFields(created),
          reason,
        );
        return created;
      });
      return reply.status(201).send({ ok: true, id: result.id });
    },
  );

  fastify.patch(
    "/admin/contents/:id",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const body = ZCONTENT_EDIT.omit({ id: true }).parse(req.body);
      const meta = adminMeta(req);
      const { reason, categoryIds, ...payload } = body;
      const before = await prisma.content.findUnique({
        where: { id },
        include: { categories: { orderBy: { displayOrder: "asc" } }, fullVideoSegments: { orderBy: { segmentOrder: "asc" } } },
      });
      if (!before) return reply.status(404).send({ error: "not_found" });

      // 服务端兼容旧版后台已缓存的 VOD cover 引用；新版前端本身不会再提交它。
      await omitLegacyCoverReferenceForVodAsset(prisma, id, payload);

      if (!adminHasPermission(meta.adminRole, "content:publish")) {
        if (before.status === "published") {
          return reply.status(403).send({ error: "forbidden", message: "无权编辑已发布内容，请先下架" });
        }
      }

      const mergedAccessType = (payload.accessType ?? before.accessType) as AccessTypeBound;
      const previewPolicy = normalizePreviewPolicy({
        previewEnabled: payload.previewEnabled !== undefined ? payload.previewEnabled : (before as any).previewEnabled,
        previewDurationSeconds: payload.previewDurationSeconds !== undefined ? payload.previewDurationSeconds : (before as any).previewDurationSeconds,
      });
      const mergedPackageId = payload.packageId !== undefined ? payload.packageId : before.packageId;
      const mergedProductId = payload.productId !== undefined ? payload.productId : before.productId;
      const mergedFreeChannelCode = payload.freeChannelCode !== undefined ? payload.freeChannelCode : before.freeChannelCode;
      const mergedCoverAssetId = payload.coverAssetId !== undefined ? payload.coverAssetId : before.coverAssetId;
      const mergedPreviewAssetId = payload.previewAssetId !== undefined ? payload.previewAssetId : before.previewAssetId;
      const segmentInputProvided = payload.fullVideoAssetIds !== undefined || payload.fullVideoAssetId !== undefined;
      const mergedFullVideoAssetIds = segmentInputProvided
        ? normalizeFullVideoAssetIds(payload.fullVideoAssetIds, payload.fullVideoAssetId)
        : before.fullVideoSegments.length > 0
          ? before.fullVideoSegments.map((segment) => segment.videoAssetId)
          : normalizeFullVideoAssetIds(undefined, before.fullVideoAssetId);
      const mergedFullVideoAssetId = mergedFullVideoAssetIds[0] ?? null;
      const preCheck = await validateContentAccessTypeConstraints({
        prisma,
        targetContentId: id,
        accessType: mergedAccessType,
        packageId: mergedPackageId,
        productId: mergedProductId,
        freeChannelCode: mergedFreeChannelCode,
        coverAssetId: mergedCoverAssetId ?? null,
        previewAssetId: mergedPreviewAssetId ?? null,
        fullVideoAssetId: mergedFullVideoAssetId ?? null,
        fullVideoAssetIds: mergedFullVideoAssetIds,
      });
      if (!preCheck.ok) {
        return reply.status(preCheck.status).send({ error: preCheck.error, message: preCheck.message, details: preCheck.details });
      }

      // 冗余列回填：若显式修改了 asset FK，则取对应 MediaAsset.storagePublicUrl / durationSeconds 同步写回冗余列
      const touchedAssetFks = [
        payload.coverAssetId !== undefined ? (payload.coverAssetId ?? null) : null,
        payload.previewAssetId !== undefined ? (payload.previewAssetId ?? null) : null,
      ];
      const touchedAnyAsset = payload.coverAssetId !== undefined || payload.previewAssetId !== undefined || segmentInputProvided;
      let assetRedundancies: { coverUrl?: string | null; previewUrl?: string | null; durationSeconds?: number | null } | null = null;
      if (touchedAnyAsset) {
        const ids = touchedAssetFks.filter((x): x is string => x != null);
        const rows = ids.length
          ? await prisma.mediaAsset.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, storagePublicUrl: true, durationSeconds: true } })
          : [];
        const rm = new Map(rows.map((r) => [r.id, r]));
        assetRedundancies = {};
        if (payload.coverAssetId !== undefined) {
          assetRedundancies.coverUrl = payload.coverAssetId ? rm.get(payload.coverAssetId)?.storagePublicUrl || null : null;
        }
        if (payload.previewAssetId !== undefined) {
          assetRedundancies.previewUrl = payload.previewAssetId ? rm.get(payload.previewAssetId)?.storagePublicUrl || null : null;
        }
        if (segmentInputProvided || payload.previewAssetId !== undefined) {
          const prev = payload.previewAssetId !== undefined
            ? (payload.previewAssetId ? rm.get(payload.previewAssetId)?.durationSeconds ?? null : null)
            : undefined;
          assetRedundancies.durationSeconds = prev !== undefined ? prev : before.durationSeconds;
        }
      }

      const data: any = { lastEditorId: meta.adminId };
      for (const k of Object.keys(payload)) {
        const v = (payload as any)[k];
        if (v === undefined) continue;
        if (k === "fullVideoAssetIds") continue;
        if (k === "recommendStartsAt" || k === "recommendEndsAt" || k === "scheduledAt") {
          (data as any)[k] = v ? new Date(v) : null;
        } else {
          (data as any)[k] = v;
        }
      }
      if (segmentInputProvided) data.fullVideoAssetId = mergedFullVideoAssetId;
      data.previewEnabled = previewPolicy.previewEnabled;
      data.previewDurationSeconds = previewPolicy.previewDurationSeconds;
      if (assetRedundancies) {
        if (assetRedundancies.coverUrl !== undefined && payload.coverUrl === undefined) data.coverUrl = assetRedundancies.coverUrl;
        if (assetRedundancies.previewUrl !== undefined && payload.previewUrl === undefined) data.previewUrl = assetRedundancies.previewUrl;
        if (assetRedundancies.durationSeconds !== undefined && payload.durationSeconds === undefined) data.durationSeconds = assetRedundancies.durationSeconds;
      }
      const seoTouched =
        payload.seoTitle !== undefined ||
        payload.seoDescription !== undefined ||
        payload.seoKeywords !== undefined ||
        payload.geoKeywords !== undefined;
      if (seoTouched) {
        const normalizedSeo = normalizeSeoPayload({
          seoTitle: payload.seoTitle !== undefined ? payload.seoTitle : before.seoTitle,
          seoDescription: payload.seoDescription !== undefined ? payload.seoDescription : before.seoDescription,
          seoKeywords: payload.seoKeywords !== undefined ? payload.seoKeywords : before.seoKeywords,
          geoKeywords: payload.geoKeywords !== undefined ? payload.geoKeywords : before.geoKeywords,
        });
        if (!normalizedSeo.ok) {
          return reply.status(400).send(buildValidationErrorResponse(normalizedSeo.failures));
        }
        if (payload.seoTitle !== undefined) data.seoTitle = normalizedSeo.value.seoTitle;
        if (payload.seoDescription !== undefined) data.seoDescription = normalizedSeo.value.seoDescription;
        if (payload.seoKeywords !== undefined) data.seoKeywords = normalizedSeo.value.seoKeywords;
        if (payload.geoKeywords !== undefined) data.geoKeywords = normalizedSeo.value.geoKeywords;
      }
      if (payload.tags !== undefined) {
        const normalizedTags = normalizeContentTagsPayload(payload.tags);
        if (!normalizedTags.ok) {
          return reply.status(400).send(buildValidationErrorResponse(normalizedTags.failures));
        }
        data.tags = normalizedTags.value;
      }

      const result = await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data,
          include: { categories: { orderBy: { displayOrder: "asc" } } },
        });
        if (segmentInputProvided) {
          await tx.contentFullVideoSegment.deleteMany({ where: { contentId: id } });
          if (mergedFullVideoAssetIds.length > 0) {
            await tx.contentFullVideoSegment.createMany({
              data: mergedFullVideoAssetIds.map((videoAssetId, index) => ({ contentId: id, videoAssetId, segmentOrder: index + 1 })),
            });
          }
        }
        if (Array.isArray(categoryIds)) {
          await tx.contentCategory.deleteMany({ where: { contentId: id } });
          if (categoryIds.length) {
            await tx.contentCategory.createMany({
              data: categoryIds.map((cid, i) => ({ contentId: id, categoryId: cid, displayOrder: i, assignedBy: meta.adminId })),
            });
          }
          after.categories = await tx.contentCategory.findMany({ where: { contentId: id }, orderBy: { displayOrder: "asc" } });
        }
        await writeAudit(tx, meta, "content.update", "content", id, stripSensitiveFields(before), stripSensitiveFields(after), reason);
        return after;
      });
      return reply.send({ ok: true, id: result.id });
    },
  );

  fastify.put(
    "/admin/contents/:id/categories",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const body = ZCATEGORY_SET.parse(req.body);
      const meta = adminMeta(req);
      const before = await prisma.contentCategory.findMany({
        where: { contentId: id },
        orderBy: { displayOrder: "asc" },
      });
      const exists = await prisma.content.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return reply.status(404).send({ error: "not_found" });

      const result = await prisma.$transaction(async (tx: any) => {
        await tx.contentCategory.deleteMany({ where: { contentId: id } });
        const rows = body.categoryIds.length
          ? await tx.contentCategory.createManyAndReturn({
              data: body.categoryIds.map((cid, i) => ({ contentId: id, categoryId: cid, displayOrder: i, assignedBy: meta.adminId })),
            })
          : [];
        await writeAudit(
          tx, meta, "content.set_categories", "content", id,
          serialize(before.map((x: any) => ({ categoryId: x.categoryId, displayOrder: x.displayOrder }))),
          serialize(body.categoryIds),
          body.reason,
        );
        return rows;
      });
      return reply.send({ ok: true, categoryIds: result.map((r: any) => r.categoryId) });
    },
  );

  const submitReviewHandler = async (req: any, reply: any) => {
      const id = ZID.parse(req.params.id);
      const { reason } = ZSTATUS_ACTION.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await prisma.content.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      if (!["draft", "archived"].includes(before.status)) {
        return reply.status(409).send({ error: "bad_status", message: "仅草稿或归档可提交审核" });
      }
      const preCheck = await validatePublishReady(prisma, id);
      if (!preCheck.ok) {
        return reply.status(preCheck.status).send({ error: preCheck.error, message: preCheck.message, details: preCheck.details });
      }
      await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data: { status: "pending_review", lastEditorId: meta.adminId },
        });
        await writeAudit(tx, meta, "content.submit_review", "content", id, stripSensitiveFields(before), stripSensitiveFields(after), reason);
      });
      return reply.send({ ok: true, status: "pending_review" });
    };

  fastify.post(
    "/admin/contents/:id/submit_for_review",
    { preHandler: [requireAdmin("content:edit")] },
    submitReviewHandler,
  );

  fastify.post(
    "/admin/contents/:id/submit_review",
    { preHandler: [requireAdmin("content:edit")] },
    submitReviewHandler,
  );

  fastify.post(
    "/admin/contents/:id/publish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const { reason } = ZSTATUS_ACTION.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await prisma.content.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      if (!["draft", "pending_review", "archived", "scheduled"].includes(before.status)) {
        return reply.status(409).send({ error: "bad_status", message: "当前状态不允许发布" });
      }
      const preCheck = await validatePublishReady(prisma, id);
      if (!preCheck.ok) {
        return reply.status(preCheck.status).send({ error: preCheck.error, message: preCheck.message, details: preCheck.details });
      }
      await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data: { status: "published", publishedAt: new Date(), lastEditorId: meta.adminId },
        });
        await writeAudit(tx, meta, "content.publish", "content", id, stripSensitiveFields(before), stripSensitiveFields(after), reason);
      });

      // Telegram 私密频道是完整视频备用交付；所有内容仍必须同步创建免费流量入口
      // 的封面推广任务，试看由 Web 播放链路承担。
      const automaticKinds: TelegramPublishPlanKind[] = [];
      if (before.accessType === "membership") automaticKinds.push("membership_full");
      if (before.accessType === "package") automaticKinds.push("package_full");
      automaticKinds.push("public_free_preview");
      const telegramPublish = await queueTelegramPublishForContent({
        prisma,
        contentId: id,
        meta,
        channelKinds: automaticKinds,
        reason: `${reason || "管理员发布内容"}；自动创建频道投放任务`,
      });
      if (!telegramPublish.ok) {
        if (playbackConfig) {
          void prewarmPlaybackCdnForContent({
            prisma,
            playbackConfig,
            signingKey: String(process.env.VIDEO_CDN_SIGNING_KEY || ""),
            contentId: id,
          });
        }
        emitSafetyEvent({
          event: "content_publish_channel_queue_failed",
          errorClass: telegramPublish.error,
          adminId: meta.adminId,
          note: `content_fp=${safeHexDigest(id, 12)}`,
        });
        return reply.status(202).send({
          ok: true,
          status: "published",
          cdnPrewarm: { queued: !!playbackConfig?.configured },
          telegramPublish: { queued: false, error: telegramPublish.error, message: telegramPublish.message },
        });
      }
      if (playbackConfig) {
        void prewarmPlaybackCdnForContent({
          prisma,
          playbackConfig,
          signingKey: String(process.env.VIDEO_CDN_SIGNING_KEY || ""),
          contentId: id,
        });
      }
      return reply.send({
        ok: true,
        status: "published",
        cdnPrewarm: { queued: !!playbackConfig?.configured },
        telegramPublish: {
          queued: true,
          jobs: telegramPublish.jobs.map((job: any) => ({ id: job.id, channelKind: job.channelKind, status: job.status })),
        },
      });
    },
  );

  fastify.post(
    "/admin/contents/:id/unpublish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const { reason } = ZSTATUS_ACTION.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await prisma.content.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      if (before.status !== "published") {
        return reply.status(409).send({ error: "bad_status", message: "仅已发布内容可下架" });
      }
      await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data: { status: "archived", publishedAt: null, lastEditorId: meta.adminId },
        });
        await writeAudit(tx, meta, "content.unpublish", "content", id, stripSensitiveFields(before), stripSensitiveFields(after), reason);
      });
      await revokePlaybackSessionsByContent(prisma, {
        contentId: id,
        requestedByAdminId: meta.adminId,
        reason: "content_unpublished",
      });
      return reply.send({ ok: true, status: "archived" });
    },
  );

  // 解析内容对应的目标交付频道 ChannelRef（按 accessType 分派；明文 chatId 内部流转不返回）
  async function resolveContentChannelRefForPublish(contentId: string): Promise<
    | { ok: true; ref: ChannelRef; channelCode: string | null; channelLabel: string; chatFingerprint: string; chatMasked: string }
    | { ok: false; status: number; error: string; message?: string; details?: any }
  > {
    const row = await prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        accessType: true,
        freeChannelCode: true,
        packageId: true,
        channelId: true,
        channelIdCiphertext: true,
      },
    });
    if (!row) return { ok: false, status: 404, error: "not_found", message: "内容不存在" };
    let ref: ChannelRef | null = null;
    let channelCode: string | null = null;
    let channelLabel = "";
    switch (row.accessType) {
      case "public": {
        if (!row.freeChannelCode || !isValidFreeChannelCode(row.freeChannelCode)) {
          return {
            ok: false,
            status: 409,
            error: "free_channel_code_required",
            message: "公开内容发布前必须选择合法的免费频道编码。",
          };
        }
        channelCode = row.freeChannelCode;
        try {
          ref = refFreeChannelByCode(row.freeChannelCode);
        } catch (err: any) {
          emitSafetyEvent(
            {
              event: "free_channel_env_resolve_failed",
              errorClass: "business",
              note: `content=${row.id} freeChannelCode=${row.freeChannelCode}`,
            },
            err,
          );
          return {
            ok: false,
            status: 503,
            error: "free_channel_not_configured",
            message: "该免费频道服务端未配置，请稍后重试或联系管理员检查 env",
          } as const;
        }
        const entry = getFreeChannelEntry(row.freeChannelCode);
        channelLabel = entry ? entry.label : `免费:${row.freeChannelCode}`;
        break;
      }
      case "membership": {
        ref = await resolveMembershipChannelRef(prisma);
        channelLabel = "会员专属频道";
        break;
      }
      case "package": {
        if (!row.packageId) {
          return { ok: false, status: 409, error: "package_id_required", message: "打包内容未绑定内容包，无法发布到频道。" };
        }
        const pkg = await prisma.contentPackage.findUnique({
          where: { id: row.packageId },
          select: { id: true, title: true, status: true, channelId: true, channelIdCiphertext: true },
        });
        const ch = pkg ? resolvePackageChannelId({ channelId: pkg.channelId, channelIdCiphertext: pkg.channelIdCiphertext }) : null;
        if (!pkg || pkg.status !== "published" || ch == null) {
          return {
            ok: false,
            status: 409,
            error: "package_not_ready",
            message: "内容包未发布或未配置交付频道；需服务端完成受控映射后才能发布视频。",
          };
        }
        ref = refRawChatId(ch);
        channelLabel = `内容包:${pkg.title || pkg.id}`;
        break;
      }
      case "single":
      default:
        return {
          ok: false,
          status: 409,
          error: "single_channel_delivery_unavailable",
          message: "single（单篇购买）仅支持站内 HLS 受控播放，不提供 Telegram 私密频道完整视频交付。",
        };
    }
    if (!ref) return { ok: false, status: 500, error: "internal", message: "解析目标频道失败" };
    // 拿 fingerprint 对账（需要解析到 chatId，但 ref 携带 rawChatId 可直接用；membership 需要 env 解析）
    let chatId: bigint | null = null;
    try {
      if (ref.kind === "membership_main") {
        const mem = process.env.TELEGRAM_CHANNEL_MEMBERSHIP ?? process.env.MEMBERSHIP_CHANNEL_ID ?? null;
        if (mem) chatId = BigInt(mem);
      } else if (ref.kind === "raw_chat_id_bigint" || ref.kind === "managed_chat_id_bigint") {
        chatId = ref.chatId;
      }
    } catch (_) {
      chatId = null;
    }
    const fingerprint = chatId ? chatIdFingerprint(chatId) : "";
    const masked = chatId ? maskChatIdSafe(chatId) : "pending";
    return { ok: true, ref, channelCode, channelLabel, chatFingerprint: fingerprint, chatMasked: masked };
  }

  async function handleRegisterTelegramPublish(
    id: string,
    reg: {
      telegramMessageId: bigint;
      telegramChatFingerprint?: string | null;
      freeChannelCode?: string | null;
      videoFileIdRemark?: string | null;
      caption?: string | null;
      reason?: string | null;
    },
    meta: ReturnType<typeof adminMeta>,
    reply: any,
  ) {
    const prismaLocal = (adminCmsPrismaHolder as any).prisma as PrismaClient;
    const before = await prismaLocal.content.findUnique({ where: { id } });
    if (!before) return reply.status(404).send({ error: "not_found", message: "内容不存在" });

    if (reg.freeChannelCode && !isValidFreeChannelCode(reg.freeChannelCode)) {
      return reply.status(400).send({
        error: "invalid_free_channel_code",
        userError: "invalid_free_channel_code",
        message: "免费频道编码不在白名单中，请从下拉选择",
      });
    }

    const tgSentAt = new Date();
    const fingerprintToUse: string | null =
      (reg.telegramChatFingerprint && reg.telegramChatFingerprint.trim().length > 0)
        ? reg.telegramChatFingerprint.trim()
        : null;
    const freeCodeToUse = (reg.freeChannelCode && reg.freeChannelCode.trim()) || null;

    let after: any;
    let channelLabelForAudit = "";
    let chatMaskedForAudit = "manual";
    try {
      await prismaLocal.$transaction(async (tx: any) => {
        const updateData: any = {
          telegramMessageId: reg.telegramMessageId,
          telegramSentAt: tgSentAt,
          telegramChatFingerprint: fingerprintToUse,
          lastEditorId: meta.adminId,
        };
        if (freeCodeToUse) updateData.freeChannelCode = freeCodeToUse;
        after = await tx.content.update({ where: { id }, data: updateData });

        const resolved = await resolveContentChannelRefForPublish(id);
        if (resolved.ok) {
          channelLabelForAudit = resolved.channelLabel || before.title || id;
          chatMaskedForAudit = resolved.chatMasked || chatMaskedForAudit;
        } else {
          channelLabelForAudit = before.title || id;
        }

        const beforeAudit = stripSensitiveFields(before);
        const afterAudit = stripSensitiveFields(after);
        const extra: any = {
          mode: "manual_register",
          channelLabel: channelLabelForAudit,
          freeChannelCode: freeCodeToUse || null,
          chatMasked: chatMaskedForAudit,
          chatFingerprint: fingerprintToUse,
          messageId: reg.telegramMessageId.toString(),
          videoFileIdRemark: reg.videoFileIdRemark || null,
          caption: reg.caption || null,
        };
        (beforeAudit as any)._publishContext = null;
        (afterAudit as any)._publishContext = extra;
        await writeAudit(
          tx,
          meta,
          "content.register_telegram_publish",
          "content",
          id,
          beforeAudit,
          afterAudit,
          reg.reason || `登记 Telegram 已发布视频（messageId=${reg.telegramMessageId.toString()}）`,
        );
      });
    } catch (err: any) {
      emitSafetyEvent(
        {
          event: "tg_publish_register_failed",
          errorClass: "business",
          adminId: meta.adminId,
          note: `content=${id} messageId=${reg.telegramMessageId.toString()}`,
        },
        err,
      );
      return reply.status(500).send({
        error: "tg_publish_register_failed",
        userError: "tg_publish_register_failed",
        message: "登记失败，请确认数据合法后重试",
      });
    }

    return reply.send({
      ok: true,
      registerMode: "manual",
      messageId: reg.telegramMessageId.toString(),
      sentAt: tgSentAt.toISOString(),
      channelLabel: channelLabelForAudit,
      freeChannelCode: freeCodeToUse,
      chatMasked: chatMaskedForAudit,
      chatFingerprint: fingerprintToUse,
      videoFileIdRemark: reg.videoFileIdRemark || null,
    });
  }

  const adminCmsPrismaHolder: any = { prisma: null };

  fastify.post(
    "/admin/contents/:id/publish-to-channel",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      adminCmsPrismaHolder.prisma = prisma;
      const rawBody = req.body || {};
      const meta = adminMeta(req);

      let messageId: bigint;
      let videoFileIdRemark: string | null = null;
      let caption: string | null = null;
      let freeChannelCode: string | null = null;
      let fingerprint: string | null = null;
      let reason: string | null = null;

      if (typeof rawBody.telegramMessageId !== "undefined") {
        const reg = ZREGISTER_TELEGRAM_PUBLISH.parse(rawBody);
        messageId = BigInt(String(reg.telegramMessageId));
        videoFileIdRemark = reg.videoFileIdRemark || null;
        caption = reg.caption || null;
        freeChannelCode = reg.freeChannelCode || null;
        fingerprint = reg.telegramChatFingerprint || null;
        reason = reg.reason || null;
      } else {
        const legacy = ZPUBLISH_VIDEO.parse(rawBody);
        return reply.status(410).send({
          error: "publish_bot_api_deprecated",
          userError: "publish_bot_api_deprecated",
          message:
            "首期发布方式已改为「运营手动上传 Telegram + 后台登记」：请在 Telegram 客户端中手动上传/转发视频至频道，获得 messageId 与频道指纹后到登记表单填写；不再支持直接调用 Bot 上传。",
        });
      }

      return handleRegisterTelegramPublish(
        id,
        {
          telegramMessageId: messageId,
          telegramChatFingerprint: fingerprint,
          freeChannelCode,
          videoFileIdRemark,
          caption,
          reason,
        },
        meta,
        reply,
      );
    },
  );

  fastify.post(
    "/admin/contents/:id/register-telegram-publish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      adminCmsPrismaHolder.prisma = prisma;
      const body = ZREGISTER_TELEGRAM_PUBLISH.parse(req.body || {});
      const meta = adminMeta(req);
      const messageId = BigInt(String(body.telegramMessageId));
      return handleRegisterTelegramPublish(
        id,
        {
          telegramMessageId: messageId,
          telegramChatFingerprint: body.telegramChatFingerprint || null,
          freeChannelCode: body.freeChannelCode || null,
          videoFileIdRemark: body.videoFileIdRemark || null,
          caption: body.caption || null,
          reason: body.reason || null,
        },
        meta,
        reply,
      );
    },
  );

  // ===========================================================================
  // CATEGORIES (Step 2 left)
  // ===========================================================================
  const ZCAT_CREATE = z.object({
    name: z.string().trim().min(1).max(100),
    slug: z.string().trim().min(1).max(80),
    /** 仅接受已校验的公开封面素材，禁止后台再手填任意图片 URL。 */
    iconAssetId: z.string().uuid().optional().nullable(),
    sortOrder: z.number().int().min(0).optional().default(0),
    status: z.enum(["active", "inactive", "archived"]).optional().default("active"),
    reason: z.string().max(500).optional(),
  });
  const ZCAT_EDIT = ZCAT_CREATE.partial().extend({ id: z.string().uuid() });

  async function resolveCategoryIconUrl(iconAssetId: string): Promise<string> {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: iconAssetId },
      select: { id: true, kind: true, status: true, storagePublicUrl: true },
    });
    if (!asset || asset.kind !== "cover_image" || asset.status !== "ready" || !asset.storagePublicUrl) {
      throw new Error("category_icon_asset_invalid");
    }
    return asset.storagePublicUrl;
  }

  fastify.get(
    "/admin/categories",
    { preHandler: [requireAdmin("category:view")] },
    async (_req, reply) => {
      const rows = await prisma.category.findMany({
        orderBy: [{ sortOrder: "desc" }, { createdAt: "asc" }],
        include: { _count: { select: { contents: true } } },
      });
      return reply.send({
        data: rows.map((r: any) => ({ ...r, contentCount: r._count?.contents || 0 })),
      });
    },
  );

  fastify.post(
    "/admin/categories",
    { preHandler: [requireAdmin("category:edit")] },
    async (req: any, reply) => {
      const body = ZCAT_CREATE.parse(req.body);
      const meta = adminMeta(req);
      const { reason, iconAssetId, ...payload } = body;
      let iconUrl: string | null = null;
      if (iconAssetId) {
        try {
          iconUrl = await resolveCategoryIconUrl(iconAssetId);
        } catch {
          return reply.status(400).send({ error: "category_icon_asset_invalid", message: "分类图标素材不存在、未校验完成或不可公开展示" });
        }
      }
      const res = await prisma.$transaction(async (tx: any) => {
        const cr = await tx.category.create({ data: { ...payload, iconUrl } });
        await writeAudit(tx, meta, "category.create", "category", cr.id, null, serialize(cr), reason);
        return cr;
      });
      return reply.status(201).send({ ok: true, id: res.id });
    },
  );

  fastify.patch(
    "/admin/categories/:id",
    { preHandler: [requireAdmin("category:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZCAT_EDIT.omit({ id: true }).parse(req.body);
      const meta = adminMeta(req);
      const { reason, iconAssetId, ...payload } = body;
      const before = await prisma.category.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      const data: any = {};
      for (const k of Object.keys(payload)) if ((payload as any)[k] !== undefined) (data as any)[k] = (payload as any)[k];
      if (iconAssetId !== undefined) {
        if (iconAssetId === null) {
          data.iconUrl = null;
        } else {
          try {
            data.iconUrl = await resolveCategoryIconUrl(iconAssetId);
          } catch {
            return reply.status(400).send({ error: "category_icon_asset_invalid", message: "分类图标素材不存在、未校验完成或不可公开展示" });
          }
        }
      }
      const result = await prisma.$transaction(async (tx: any) => {
        const after = await tx.category.update({ where: { id }, data });
        await writeAudit(tx, meta, "category.update", "category", id, serialize(before), serialize(after), reason);
        return after;
      });
      return reply.send({ ok: true, id: result.id });
    },
  );

  fastify.delete(
    "/admin/categories/:id",
    { preHandler: [requireAdmin("category:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const { reason } = ZAUDIT_REASON.parse(req.query || {});
      const meta = adminMeta(req);
      const before = await prisma.category.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      const relatedCount = await prisma.contentCategory.count({ where: { categoryId: id } });
      if (relatedCount > 0) {
        return reply.status(409).send({ error: "not_empty", message: "该分类下仍有关联内容，先清空后删除" });
      }
      await prisma.$transaction(async (tx: any) => {
        await tx.category.delete({ where: { id } });
        await writeAudit(tx, meta, "category.delete", "category", id, serialize(before), null, reason);
      });
      return reply.send({ ok: true });
    },
  );

  // ===========================================================================
  // BANNERS (Step 2 right) — slot/sort/status/startsAt/endsAt + safe response
  // ===========================================================================
  const ZBAN_CREATE = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(500).optional().nullable(),
    /** 新 Banner 只能引用已校验完成的封面素材，禁止运营手填图片 URL。 */
    imageAssetId: z.string().uuid(),
    actionLabel: z.string().max(40).optional().default("查看"),
    slot: z.string().max(32).optional().default("home_primary"),
    targetType: BannerTargetTypeZ,
    targetId: z.string().max(128).optional().nullable(),
    externalUrl: z.string().max(1000).optional().nullable(),
    status: BannerStatusZ.optional().default("draft"),
    sortOrder: z.number().int().min(0).optional().default(0),
    startsAt: z.string().datetime().optional().nullable(),
    endsAt: z.string().datetime().optional().nullable(),
    categoryId: z.string().uuid().optional().nullable(),
    reason: z.string().max(500).optional(),
  });
  const ZBAN_EDIT = ZBAN_CREATE.partial().extend({ id: z.string().uuid() });

  function stripBanner(row: any) {
    return { ...row };
  }

  function isAllowedBannerExternalUrl(url: string): boolean {
    const trimmed = String(url || "").trim();
    if (!trimmed) return false;
    if (/^https:\/\/t\.me\/joinchat\//i.test(trimmed)) return false;
    if (/^https:\/\/t\.me\/\+/i.test(trimmed)) return false;
    if (/\/invoice|\/checkout|\/pay|\/payment/i.test(trimmed)) return false;
    return /^https:\/\/(?:[^/\s]+\.)?[^/\s]+/i.test(trimmed) || /^https:\/\/t\.me\/[A-Za-z0-9_]{3,64}$/i.test(trimmed);
  }

  function normalizeBannerPayload(input: any) {
    const output = { ...input } as any;
    if (output.targetType === "external") {
      output.targetId = null;
      output.externalUrl = output.externalUrl ? String(output.externalUrl).trim() : null;
      if (!output.externalUrl || !isAllowedBannerExternalUrl(output.externalUrl)) {
        throw new Error("external_url_invalid");
      }
      return output;
    }
    output.externalUrl = null;
    if (output.targetType === "membership") {
      output.targetId = "membership";
      return output;
    }
    if (!output.targetId) {
      throw new Error("banner_target_required");
    }
    return output;
  }

  async function resolveBannerImageUrl(imageAssetId: string): Promise<string> {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: imageAssetId },
      select: { id: true, kind: true, status: true, storagePublicUrl: true },
    });
    if (!asset || asset.kind !== "cover_image" || asset.status !== "ready" || !asset.storagePublicUrl) {
      throw new Error("banner_image_asset_invalid");
    }
    return asset.storagePublicUrl;
  }

  const ZBANNER_IMAGE_ASSETS_QP = z.object({
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(60),
  });

  /** Banner 专用图库：只返回已验证、可公开展示的封面素材。 */
  fastify.get(
    "/admin/banner-image-assets",
    { preHandler: [requireAdmin("homepage:view")] },
    async (req: any, reply) => {
      const query = ZBANNER_IMAGE_ASSETS_QP.parse(req.query || {});
      const rows = await prisma.mediaAsset.findMany({
        where: {
          kind: "cover_image",
          status: "ready",
          storagePublicUrl: { not: null },
          ...(query.q ? { originalFilename: { contains: query.q, mode: "insensitive" } } : {}),
        },
        orderBy: [{ updatedAt: "desc" }],
        take: query.limit,
        select: {
          id: true,
          originalFilename: true,
          storagePublicUrl: true,
          contentLength: true,
          widthPixels: true,
          heightPixels: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return reply.send({
        data: rows.map((row: any) => ({
          id: row.id,
          originalFilename: row.originalFilename || "未命名图片",
          imageUrl: row.storagePublicUrl,
          contentLength: row.contentLength != null ? String(row.contentLength) : null,
          widthPixels: row.widthPixels,
          heightPixels: row.heightPixels,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      });
    },
  );

  fastify.get(
    "/admin/banners",
    { preHandler: [requireAdmin("homepage:view")] },
    async (_req, reply) => {
      const rows = await prisma.banner.findMany({
        orderBy: [{ slot: "asc" }, { sortOrder: "desc" }, { updatedAt: "desc" }],
      });
      return reply.send({ data: rows.map((r: any) => stripBanner(r)) });
    },
  );

  fastify.post(
    "/admin/banners",
    { preHandler: [requireAdmin("homepage:edit")] },
    async (req: any, reply) => {
      const body = ZBAN_CREATE.parse(req.body);
      const meta = adminMeta(req);
      const { reason, startsAt, endsAt, imageAssetId, ...rawPayload } = body;
      let payload: any;
      try {
        payload = {
          ...normalizeBannerPayload(rawPayload),
          imageUrl: await resolveBannerImageUrl(imageAssetId),
        };
      } catch (error: any) {
        return reply.status(400).send({
          error: error?.message || "invalid_banner_payload",
          message: error?.message === "banner_image_asset_invalid"
            ? "Banner 图片必须从已上传且校验完成的封面素材中选择。"
            : "Banner 跳转目标不合法：仅允许内容/分类/内容包/会员页，或受控 HTTPS / 公开 Telegram 链接。",
        });
      }
      const res = await prisma.$transaction(async (tx: any) => {
        const cr = await tx.banner.create({
          data: {
            ...payload,
            startsAt: startsAt ? new Date(startsAt) : null,
            endsAt: endsAt ? new Date(endsAt) : null,
          },
        });
        await writeAudit(tx, meta, "banner.create", "banner", cr.id, null, serialize(cr), reason);
        return cr;
      });
      return reply.status(201).send({ ok: true, id: res.id });
    },
  );

  fastify.patch(
    "/admin/banners/:id",
    { preHandler: [requireAdmin("homepage:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZBAN_EDIT.omit({ id: true }).parse(req.body);
      const meta = adminMeta(req);
      const { reason, startsAt, endsAt, imageAssetId, ...payloadInput } = body;
      const before = await prisma.banner.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      let payload: any;
      try {
        payload = normalizeBannerPayload({
          targetType: payloadInput.targetType ?? before.targetType,
          targetId: payloadInput.targetId ?? before.targetId,
          externalUrl: payloadInput.externalUrl ?? before.externalUrl,
          title: payloadInput.title ?? before.title,
          description: payloadInput.description ?? before.description,
          imageUrl: imageAssetId !== undefined ? await resolveBannerImageUrl(imageAssetId) : before.imageUrl,
          actionLabel: payloadInput.actionLabel ?? before.actionLabel,
          slot: payloadInput.slot ?? before.slot,
          status: payloadInput.status ?? before.status,
          sortOrder: payloadInput.sortOrder ?? before.sortOrder,
          categoryId: payloadInput.categoryId ?? before.categoryId,
        });
      } catch (error: any) {
        return reply.status(400).send({
          error: error?.message || "invalid_banner_target",
          message: "Banner 跳转目标不合法：仅允许内容/分类/内容包/会员页，或受控 HTTPS / 公开 Telegram 链接。",
        });
      }
      const data: any = {};
      for (const k of Object.keys(payload)) {
        const v = (payload as any)[k];
        if (v === undefined) continue;
        (data as any)[k] = v;
      }
      if (startsAt !== undefined) data.startsAt = startsAt ? new Date(startsAt) : null;
      if (endsAt !== undefined) data.endsAt = endsAt ? new Date(endsAt) : null;
      const result = await prisma.$transaction(async (tx: any) => {
        const after = await tx.banner.update({ where: { id }, data });
        await writeAudit(tx, meta, "banner.update", "banner", id, serialize(before), serialize(after), reason);
        return after;
      });
      return reply.send({ ok: true, id: result.id });
    },
  );

  fastify.delete(
    "/admin/banners/:id",
    { preHandler: [requireAdmin("homepage:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const { reason } = ZAUDIT_REASON.parse(req.query || {});
      const meta = adminMeta(req);
      const before = await prisma.banner.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      await prisma.$transaction(async (tx: any) => {
        await tx.banner.delete({ where: { id } });
        await writeAudit(tx, meta, "banner.delete", "banner", id, serialize(before), null, reason);
      });
      return reply.send({ ok: true });
    },
  );

  // ===========================================================================
  // HOMEPAGE PUBLISH (Step 3 BE-R4) — single version published only
  // ===========================================================================
  const ZHOME_CONFIG = z.object({
    bannerIds: z.array(z.string().uuid()).max(3).optional().default([]),
    recommendContentIds: z.array(z.string().uuid()).max(100).optional().default([]),
    featuredContentIds: z.array(z.string().uuid()).max(1).optional().default([]),
    categoryOrderIds: z.array(z.string().uuid()).max(4).optional().default([]),
  });
  const ZHOME_DRAFT_PUT = z.object({
    versionLabel: z.string().max(80).optional().nullable(),
    note: z.string().max(500).optional().nullable(),
    config: ZHOME_CONFIG,
    reason: z.string().max(500).optional(),
  });
  const ZHOME_PUBLISH = z.object({
    id: z.string().uuid(),
    versionLabel: z.string().max(80).optional().nullable(),
    publishedNote: z.string().max(500).optional().nullable(),
    reason: z.string().max(500).optional(),
  });

  fastify.get(
    "/admin/homepage/draft",
    { preHandler: [requireAdmin("homepage:view")] },
    async (_req, reply) => {
      const draft = await prisma.homepageVersion.findFirst({
        where: { status: "draft" },
        orderBy: [{ updatedAt: "desc" }],
      });
      return reply.send({ draft: draft ?? null });
    },
  );

  fastify.get(
    "/admin/homepage/published",
    { preHandler: [requireAdmin("homepage:view")] },
    async (_req, reply) => {
      const published = await prisma.homepageVersion.findFirst({
        where: { status: "published" },
        include: { publisher: { select: { id: true, displayName: true, email: true } } },
      });
      const versions = await prisma.homepageVersion.findMany({
        where: { status: { in: ["published", "archived"] } },
        take: 20,
        orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
        include: { publisher: { select: { id: true, displayName: true, email: true } } },
      });
      return reply.send({ published: published ?? null, recent: versions });
    },
  );

  fastify.put(
    "/admin/homepage/draft",
    { preHandler: [requireAdmin("homepage:edit")] },
    async (req: any, reply) => {
      const body = ZHOME_DRAFT_PUT.parse(req.body);
      const meta = adminMeta(req);
      const before = await prisma.homepageVersion.findFirst({
        where: { status: "draft" },
        orderBy: [{ updatedAt: "desc" }],
      });

      const result = await prisma.$transaction(async (tx: any) => {
        let after;
        if (!before) {
          after = await tx.homepageVersion.create({
            data: {
              status: "draft",
              versionLabel: body.versionLabel ?? null,
              note: body.note ?? null,
              config: body.config,
            },
          });
        } else {
          after = await tx.homepageVersion.update({
            where: { id: before.id },
            data: {
              versionLabel: body.versionLabel ?? null,
              note: body.note ?? null,
              config: body.config,
            },
          });
        }
        await writeAudit(
          tx, meta,
          before ? "homepage.update_draft" : "homepage.create_draft",
          "homepage", after.id,
          serialize(before?.config ?? null),
          serialize(after.config),
          body.reason,
        );
        return after;
      });
      return reply.send({ ok: true, id: result.id });
    },
  );

  fastify.post(
    "/admin/homepage/publish",
    { preHandler: [requireAdmin("homepage:publish")] },
    async (req: any, reply) => {
      const body = ZHOME_PUBLISH.parse(req.body);
      const meta = adminMeta(req);
      const beforeDraft = await prisma.homepageVersion.findUnique({ where: { id: body.id } });
      if (!beforeDraft) return reply.status(404).send({ error: "not_found" });
      if (beforeDraft.status === "published") {
        return reply.status(409).send({ error: "already_published", message: "该版本已经发布" });
      }
      const config = beforeDraft.config as any;

      const [banns, rec, feat, cats] = await Promise.all([
        config?.bannerIds?.length ? prisma.banner.count({ where: { id: { in: config.bannerIds } } }) : Promise.resolve(0),
        config?.recommendContentIds?.length ? prisma.content.count({ where: { id: { in: config.recommendContentIds } } }) : Promise.resolve(0),
        config?.featuredContentIds?.length ? prisma.content.count({ where: { id: { in: config.featuredContentIds } } }) : Promise.resolve(0),
        config?.categoryOrderIds?.length ? prisma.category.count({ where: { id: { in: config.categoryOrderIds } } }) : Promise.resolve(0),
      ]);
      const errors: string[] = [];
      if (banns !== (config?.bannerIds?.length || 0)) errors.push("banner 存在无效 ID");
      if (rec !== (config?.recommendContentIds?.length || 0)) errors.push("recommend 存在无效内容 ID");
      if (feat !== (config?.featuredContentIds?.length || 0)) errors.push("featured 存在无效内容 ID");
      if (cats !== (config?.categoryOrderIds?.length || 0)) errors.push("category 存在无效分类 ID");
      if (errors.length) return reply.status(400).send({ error: "invalid_refs", details: errors });

      const now = new Date();
      const result = await prisma.$transaction(async (tx: any) => {
        const prev = await tx.homepageVersion.findFirst({ where: { status: "published" } });
        if (prev) {
          await tx.homepageVersion.update({ where: { id: prev.id }, data: { status: "archived" } });
        }
        const published = await tx.homepageVersion.update({
          where: { id: body.id },
          data: {
            status: "published",
            publishedAt: now,
            publishedBy: meta.adminId,
            versionLabel: body.versionLabel ?? beforeDraft.versionLabel,
            publishedNote: body.publishedNote ?? null,
          },
        });
        await writeAudit(tx, meta, "homepage.publish", "homepage", published.id, serialize(beforeDraft), serialize(published), body.reason);
        if (prev) {
          await writeAudit(
            tx, meta, "homepage.archive_published", "homepage", prev.id,
            "published", "archived",
            `自动归档：被新版本 ${published.id} 替换`,
          );
        }
        return published;
      });
      return reply.send({ ok: true, id: result.id, publishedAt: result.publishedAt });
    },
  );

  // ===========================================================================
  // MEDIA ASSETS (P0 S1：上传素材封面/试看/完整视频 → 预签名 URL 浏览器直传)
  // 权限：content:edit / content:publish
  // ===========================================================================
  const ZKIND = z.enum(["cover_image", "preview_video", "full_video"]);
  const ZMEDIA_INIT = z.object({
    kind: ZKIND,
    originalFilename: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(128),
    contentLength: z.number().int().min(1),
    durationSeconds: z.number().int().min(1).max(86_400).optional().nullable(),
    expectedChecksumSha256: z.string().trim().max(128).optional().nullable(),
    note: z.string().max(500).optional().nullable(),
  });
  const ZMEDIA_COMPLETE = z.object({
    ok: z.boolean(),
    etag: z.string().max(128).optional().nullable(),
    reportedContentLength: z.number().int().min(0).optional().nullable(),
    reportedChecksumSha256: z.string().max(128).optional().nullable(),
    error: z.string().max(256).optional().nullable(),
    reason: z.string().max(500).optional(),
  });
  const ZMEDIA_STATUS_DELETE_REASON = z.object({ reason: z.string().max(500).optional() });

  fastify.post(
    "/admin/media/init-upload",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const body = ZMEDIA_INIT.parse(req.body);
      if (body.kind === "full_video") {
        return reply.status(409).send({
          error: "multipart_required",
          message: "完整视频必须使用 Multipart Upload 分片上传，请改走 /admin/contents/:contentId/assets/multipart/initiate。",
        });
      }
      const meta = adminMeta(req);
      let storage: ReturnType<typeof requireObjectStorageEnv> | null = null;
      try {
        storage = requireObjectStorageEnv();
      } catch (e) {
        emitSafetyEvent({ event: "media_init_upload_env_missing", errorClass: "exhausted", adminId: meta.adminId, retryHint: 0 });
        return reply.status(503).send({ error: "object_storage_unavailable", userError: "对象存储服务未上线，请联系技术支持" });
      }
      if (body.contentLength > 2 * 1024 * 1024 * 1024) {
        return reply.status(400).send({ error: "file_too_large", userError: "完整视频文件大小上限 2GB，请分段或压缩后再试" });
      }
      if (body.kind === "cover_image" && body.contentLength > 20 * 1024 * 1024) {
        return reply.status(400).send({ error: "cover_too_large", userError: "封面图片大小上限 20MB" });
      }
      if (body.kind === "preview_video" && body.contentLength > 800 * 1024 * 1024) {
        return reply.status(400).send({ error: "preview_too_large", userError: "试看视频大小上限 800MB（建议 30–60 秒有水印 H.264）" });
      }
      const id = cryptoRandomUuid();
      let signed: Awaited<ReturnType<typeof createPresignedPutUpload>>;
      try {
        signed = await createPresignedPutUpload({
          kind: body.kind,
          originalFilename: body.originalFilename,
          mimeType: body.mimeType,
          contentLength: body.contentLength,
          expectedChecksumSha256: body.expectedChecksumSha256 || null,
          adminId: meta.adminId,
          note: body.note || null,
        });
      } catch (e) {
        emitSafetyEvent({ event: "media_init_upload_presign_failed", errorClass: "unknown", adminId: meta.adminId, retryHint: 1, note: `kind=${body.kind} len=${body.contentLength}` });
        return reply.status(503).send({ error: "object_storage_presign_failed", userError: "对象存储服务暂不可用，请稍后重试" });
      }
      const backend = objectStorageBackend();
      const asset = await prisma.$transaction(async (tx: any) => {
        const row = await tx.mediaAsset.create({
          data: {
            id,
            kind: body.kind,
            status: "uploading",
            storageBackend: backend,
            ownerAdminId: meta.adminId,
            originalFilename: body.originalFilename,
            mimeType: body.mimeType,
            contentLength: BigInt(body.contentLength),
            durationSeconds: body.kind === "cover_image" ? null : (body.durationSeconds ?? null),
            checksumSha256: body.expectedChecksumSha256 || null,
            storageBucket: storage!.bucket,
            storageRegion: storage!.region,
            storageKey: signed.key,
            expiresAt: signed.expiresAt,
            note: body.note || null,
          },
        });
        await writeAudit(tx, meta, "media.init_upload", "media_asset", row.id, null, serialize({ kind: row.kind, backend, bucket: storage!.bucket, keyLen: signed.key.length }), body.note || null);
        return row;
      });
      return reply.send({
        mediaAssetId: asset.id,
        uploadUrl: signed.url,
        storageBucket: storage!.bucket,
        storageRegion: storage!.region,
        storageKey: signed.key,
        uploadExpiresAt: signed.expiresAt.toISOString(),
        expectedHttpHeaders: signed.headers,
      });
    },
  );

  fastify.post(
    "/admin/media/:id/complete",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZMEDIA_COMPLETE.parse(req.body);
      const meta = adminMeta(req);
      const asset = await prisma.mediaAsset.findUnique({ where: { id } });
      if (!asset) return reply.status(404).send({ error: "not_found" });
      if (asset.status === "deleted") return reply.status(410).send({ error: "asset_deleted" });
      if (!body.ok || body.error) {
        emitSafetyEvent({
          event: "media_upload_client_reported_failed",
          errorClass: "business",
          adminId: meta.adminId,
          productId: asset.id,
          note: `kind=${asset.kind} client_err_len=${(body.error || "").length}`,
        });
        const updated = await prisma.$transaction(async (tx: any) => {
          const after = await tx.mediaAsset.update({
            where: { id },
            data: { status: "failed", lastErrorClass: null, lastErrorNote: truncateNote(body.error || "client_reported_failed", 500) },
          });
          await writeAudit(tx, meta, "media.complete_failed", "media_asset", id, null, serialize({ status: after.status, errorLen: (body.error || "").length }), body.reason || null);
          return after;
        });
        return reply.send({ ok: false, id: updated.id, status: updated.status });
      }
      let storageEnv: ReturnType<typeof requireObjectStorageEnv>;
      try { storageEnv = requireObjectStorageEnv(); } catch {
        emitSafetyEvent({ event: "media_complete_storage_env_missing", errorClass: "exhausted", adminId: meta.adminId, retryHint: 0 });
        return reply.status(503).send({ error: "object_storage_unavailable", userError: "对象存储服务未上线，无法校验上传结果" });
      }
      if (!asset.storageBucket || !asset.storageKey) {
        return reply.status(400).send({ error: "asset_storage_uninitialized", userError: "上传记录未初始化存储 Key，请重新发起上传" });
      }
      const verify = await headObject(asset.storageBucket, asset.storageKey);
      let finalStatus: "ready" | "failed" = "failed";
      let contentLengthFinal = asset.contentLength;
      let etagFinal = body.etag || null;
      if (verify.ok && verify.head) {
        const reported = body.reportedContentLength ? Number(body.reportedContentLength) : null;
        const s3len = typeof (verify.head as any).ContentLength === "number" ? Number((verify.head as any).ContentLength) : null;
        if (reported && s3len && reported !== s3len) {
          emitSafetyEvent({ event: "media_complete_length_mismatch", errorClass: "conflict", adminId: meta.adminId, note: `reported=${reported} s3=${s3len} kind=${asset.kind}` });
        } else {
          finalStatus = "ready";
          if (s3len) contentLengthFinal = BigInt(s3len);
          const etagRaw = (verify.head as any).ETag as string | undefined;
          if (etagRaw) etagFinal = etagRaw.replace(/^"|"$/g, "");
        }
      } else {
        emitSafetyEvent({
          event: "media_complete_head_verify_failed",
          errorClass: verify.userError && /not_found/.test(verify.userError) ? "business" : "timeout",
          adminId: meta.adminId,
          retryHint: 1,
          note: `kind=${asset.kind} uerr_len=${(verify.userError || "").length}`,
        });
      }
      const publicUrl = finalStatus === "ready" && asset.kind !== "full_video"
        ? makePublicUrl(storageEnv.bucket, storageEnv.region, asset.storageKey, storageEnv)
        : undefined;
      const updated = await prisma.$transaction(async (tx: any) => {
        const after = await tx.mediaAsset.update({
          where: { id },
          data: {
            status: finalStatus,
            contentLength: contentLengthFinal,
            storageEtag: etagFinal,
            storagePublicUrl: publicUrl || null,
            lastVerifiedAt: new Date(),
          },
        });
        await writeAudit(tx, meta, `media.complete_${finalStatus}`, "media_asset", id, null, serialize({ status: after.status, etagLen: (etagFinal || "").length, hasPublicUrl: !!publicUrl }), body.reason || null);
        return after;
      });
      return reply.send({ ok: finalStatus === "ready", id: updated.id, status: updated.status, publicUrl: updated.storagePublicUrl, contentLength: updated.contentLength ? String(updated.contentLength) : null });
    },
  );

  fastify.get(
    "/admin/media/:id/preview",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const asset = await prisma.mediaAsset.findUnique({
        where: { id },
        select: { kind: true, status: true, storagePublicUrl: true },
      });
      if (!asset || asset.kind !== "cover_image" || asset.status !== "ready" || !asset.storagePublicUrl) {
        return reply.status(404).send({ error: "not_found" });
      }
      // 受控入口只用于已登录后台的封面查看；浏览器随后跳转到公开封面对象。
      return reply.header("Cache-Control", "private, max-age=300").redirect(asset.storagePublicUrl, 302);
    },
  );

  fastify.get(
    "/admin/media/:id",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const row = await prisma.mediaAsset.findUnique({ where: { id } });
      if (!row) return reply.status(404).send({ error: "not_found" });
      return reply.send({
        id: row.id,
        kind: row.kind,
        status: row.status,
        storageBackend: row.storageBackend,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        contentLength: row.contentLength ? String(row.contentLength) : null,
        storageBucket: row.storageBucket,
        storageRegion: row.storageRegion,
        storageKey: row.storageKey,
        storageEtag: row.storageEtag,
        storagePublicUrl: row.storagePublicUrl,
        durationSeconds: row.durationSeconds,
        widthPixels: row.widthPixels,
        heightPixels: row.heightPixels,
        hasWatermark: row.hasWatermark,
        note: row.note,
        expiresAt: row.expiresAt,
        lastVerifiedAt: row.lastVerifiedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    },
  );

  fastify.post(
    "/admin/media/:id/delete",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZMEDIA_STATUS_DELETE_REASON.safeParse(req.body || {}).data || {};
      const meta = adminMeta(req);
      const asset = await prisma.mediaAsset.findUnique({ where: { id } });
      if (!asset) return reply.status(404).send({ error: "not_found" });
      if (asset.storageBucket && asset.storageKey) {
        void deleteObjectSafe(asset.storageBucket, asset.storageKey, meta.adminId);
      }
      const updated = await prisma.$transaction(async (tx: any) => {
        const after = await tx.mediaAsset.update({ where: { id }, data: { status: "deleted", note: truncateNote(`软删除：${body.reason || asset.note || ""}`, 500) } });
        await writeAudit(tx, meta, "media.delete", "media_asset", id, null, serialize({ status: after.status }), body.reason || null);
        return after;
      });
      return reply.send({ ok: true, id: updated.id, status: updated.status });
    },
  );

  // ===========================================================================
  // 【P0-素材上传发布】Bot 发布任务 3 条 API
  // Security:
  //   - 前端不能提交 chatId / telegramMessageId / target_chat_*；所有目标只由服务端根据 channelKind（枚举）解析
  //   - 所有 3 条路由 requireAdmin("content:publish")（editor 及以上）
  // ===========================================================================
  fastify.post(
    "/admin/contents/:id/start-telegram-publish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const contentId = z.string().uuid().parse(req.params.id);
      const body = ZSTART_PUBLISH.parse(req.body);
      const meta = adminMeta(req);
      const result = await queueTelegramPublishForContent({
        prisma,
        contentId,
        meta,
        channelKinds: body.channelKinds,
        telegramTags: body.telegramTags,
        reason: body.reason,
      });
      if (!result.ok) return reply.status(result.status).send({ error: result.error, message: result.message, details: result.details });
      return reply.status(201).send({
        ok: true,
        jobs: result.jobs.map((j: any) => ({
          id: j.id,
          channelKind: j.channelKind,
          status: j.status,
          jobToken: j.jobToken,
          mediaAssetId: j.mediaAssetId,
          videoAssetId: j.videoAssetId,
          targetFreeChannelCode: j.targetFreeChannelCode,
          createdAt: j.createdAt,
        })),
        normalizedTelegramTags: result.normalizedTelegramTags,
      });
    },
  );

  fastify.get(
    "/admin/contents/:id/publish-jobs",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const contentId = z.string().uuid().parse(req.params.id);
      const qp = ZPUBLISH_JOBS_QP.parse(req.query);
      const rows = await prisma.telegramPublishJob.findMany({
        where: { contentId },
        orderBy: [{ createdAt: "desc" }],
        take: qp.limit,
        include: {
          mediaAsset: { select: { id: true, kind: true, originalFilename: true, status: true, storagePublicUrl: true, contentLength: true, durationSeconds: true } },
          videoAsset: { select: { id: true, kind: true, originalFilename: true, status: true, byteSize: true } },
          admin: { select: { id: true, email: true, displayName: true } },
          cancelledByAdmin: { select: { id: true, email: true, displayName: true } },
        },
      });
      // 脱敏：绝不在前端展示 fingerprint/masked 之外的任何频道明文标识
      return reply.send({
        items: rows.map((r: any) => ({
          id: r.id,
          contentId: r.contentId,
          packageId: r.packageId,
          mediaAsset: r.mediaAsset
            ? {
                ...r.mediaAsset,
                contentLength: r.mediaAsset.contentLength != null ? String(r.mediaAsset.contentLength) : null,
              }
            : null,
          videoAsset: r.videoAsset
            ? {
                ...r.videoAsset,
                byteSize: r.videoAsset.byteSize != null ? String(r.videoAsset.byteSize) : null,
              }
            : null,
          admin: r.admin,
          cancelledByAdmin: r.cancelledByAdmin,
          channelKind: r.channelKind,
          targetFreeChannelCode: r.targetFreeChannelCode,
          targetChatMasked: r.targetChatMasked,
          status: r.status,
          queueName: r.queueName,
          mediaAssetId: r.mediaAssetId,
          videoAssetId: r.videoAssetId,
          attempt: r.attempt,
          maxAttempts: r.maxAttempts,
          lastErrorClass: r.lastErrorClass,
          lastErrorNote: r.lastErrorNote,
          lastAttemptedAt: r.lastAttemptedAt,
          nextRetryAt: r.nextRetryAt,
          telegramMessageId: r.telegramMessageId ? String(r.telegramMessageId) : null,
          telegramMethod: r.telegramMethod,
          parseMode: r.parseMode,
          telegramTags: normalizeStoredTelegramTags(r.telegramTagsJson),
          sentAt: r.sentAt,
          cancelledAt: r.cancelledAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      });
    },
  );

  fastify.get(
    "/admin/channel-messages",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const qp = ZCHANNEL_MESSAGES_QP.parse(req.query || {});
      const rows = await (prisma as any).telegramChannelMessage.findMany({
        where: {
          associationStatus: qp.status,
          managedChannel: qp.purpose ? { purpose: qp.purpose } : undefined,
        },
        include: {
          managedChannel: { select: { id: true, title: true, username: true, purpose: true, packageId: true } },
        },
        orderBy: [{ postedAt: "desc" }],
        take: qp.limit,
      });
      return reply.send({ items: rows.map((row: any) => serializeChannelMessageRow(row)) });
    },
  );

  fastify.get(
    "/admin/contents/:id/linkable-channel-messages",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const contentId = ZID.parse(req.params.id);
      const qp = ZCHANNEL_MESSAGES_QP.parse(req.query || {});
      const content = await prisma.content.findUnique({
        where: { id: contentId },
        select: { id: true, accessType: true, packageId: true, title: true },
      });
      if (!content) return reply.status(404).send({ error: "not_found", message: "内容不存在" });
      const filter = getAllowedChannelMessageFilter({ accessType: content.accessType as AccessTypeBound, packageId: content.packageId });
      if (!filter) {
        return reply.status(409).send({ error: "channel_message_link_not_supported", message: "当前内容类型不支持频道消息关联。" });
      }
      const rows = await (prisma as any).telegramChannelMessage.findMany({
        where: {
          associationStatus: qp.status || "unlinked",
          managedChannel: {
            purpose: filter.purpose,
            ...(filter.packageId ? { packageId: filter.packageId } : {}),
          },
        },
        include: {
          managedChannel: { select: { id: true, title: true, username: true, purpose: true, packageId: true } },
        },
        orderBy: [{ postedAt: "desc" }],
        take: qp.limit,
      });
      const currentLink = await (prisma as any).telegramChannelMessage.findFirst({
        where: {
          contentId,
          associationStatus: "linked",
          managedChannel: {
            purpose: filter.purpose,
            ...(filter.packageId ? { packageId: filter.packageId } : {}),
          },
        },
        include: {
          managedChannel: { select: { id: true, title: true, username: true, purpose: true, packageId: true } },
        },
      });
      return reply.send({
        contentId,
        accessType: content.accessType,
        currentLink: currentLink ? serializeChannelMessageRow(currentLink) : null,
        items: rows.map((row: any) => serializeChannelMessageRow(row)),
      });
    },
  );

  fastify.post(
    "/admin/contents/:id/link-channel-message",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const contentId = ZID.parse(req.params.id);
      const body = ZLINK_CHANNEL_MESSAGE.parse(req.body || {});
      const meta = adminMeta(req);
      const content = await prisma.content.findUnique({
        where: { id: contentId },
        select: { id: true, title: true, accessType: true, packageId: true, telegramMessageId: true, telegramSentAt: true, telegramChatFingerprint: true },
      });
      if (!content) return reply.status(404).send({ error: "not_found", message: "内容不存在" });
      const filter = getAllowedChannelMessageFilter({ accessType: content.accessType as AccessTypeBound, packageId: content.packageId });
      if (!filter) {
        return reply.status(409).send({ error: "channel_message_link_not_supported", message: "当前内容类型不支持频道消息关联。" });
      }
      const rawRow = await (prisma as any).telegramChannelMessage.findUnique({
        where: { id: body.channelMessageId },
        include: {
          managedChannel: {
            select: { id: true, title: true, username: true, purpose: true, packageId: true, chatIdCiphertextB64: true, deprecatedChatIdBig: true },
          },
        },
      });
      if (!rawRow) return reply.status(404).send({ error: "channel_message_not_found", message: "频道消息不存在" });
      if (rawRow.associationStatus !== "unlinked" || rawRow.contentId) {
        return reply.status(409).send({ error: "channel_message_already_linked", message: "该频道消息已关联，不能重复绑定。" });
      }
      if (rawRow.managedChannel?.purpose !== filter.purpose || (filter.packageId && rawRow.managedChannel?.packageId !== filter.packageId)) {
        return reply.status(409).send({ error: "channel_message_purpose_mismatch", message: "该频道消息与当前内容的访问类型或内容包不匹配。" });
      }
      const chatId = rawRow.managedChannel?.chatIdCiphertextB64
        ? (() => { try { return decryptChatIdAesGcm(rawRow.managedChannel.chatIdCiphertextB64); } catch { return null; } })()
        : (typeof rawRow.managedChannel?.deprecatedChatIdBig === "bigint" ? rawRow.managedChannel.deprecatedChatIdBig : null);
      const chatFingerprint = chatId ? chatIdFingerprint(chatId) : null;
      const linkedAt = new Date();
      const after = await prisma.$transaction(async (tx: any) => {
        const existingForContent = await tx.telegramChannelMessage.findFirst({
          where: {
            contentId,
            associationStatus: "linked",
            managedChannel: {
              purpose: filter.purpose,
              ...(filter.packageId ? { packageId: filter.packageId } : {}),
            },
          },
        });
        if (existingForContent) {
          throw Object.assign(new Error("content_already_has_linked_message"), { statusCode: 409, code: "CONTENT_ALREADY_LINKED" });
        }
        const current = await tx.telegramChannelMessage.findUnique({ where: { id: body.channelMessageId } });
        if (!current || current.associationStatus !== "unlinked" || current.contentId) {
          throw Object.assign(new Error("channel_message_already_linked"), { statusCode: 409 });
        }
        await tx.telegramChannelMessage.update({
          where: { id: body.channelMessageId },
          data: {
            associationStatus: "linked",
            contentId,
            linkedAt,
            linkedBy: meta.adminId,
          },
        });
        const updatedContent = await tx.content.update({
          where: { id: contentId },
          data: {
            telegramMessageId: rawRow.messageId,
            telegramSentAt: rawRow.postedAt,
            telegramChatFingerprint: chatFingerprint,
            lastEditorId: meta.adminId,
          },
        });
        await writeAudit(
          tx,
          meta,
          "content.channel_message.link",
          "content",
          contentId,
          stripSensitiveFields({
            telegramMessageId: content.telegramMessageId,
            telegramSentAt: content.telegramSentAt,
            telegramChatFingerprint: content.telegramChatFingerprint,
          }),
          stripSensitiveFields({
            telegramMessageId: rawRow.messageId,
            telegramSentAt: rawRow.postedAt,
            telegramChatFingerprint: chatFingerprint,
            channelMessageId: rawRow.id,
            channelLabel: rawRow.managedChannel?.title || rawRow.managedChannel?.username || "受控频道",
          }),
          body.reason || "关联频道消息到内容",
        );
        return updatedContent;
      }).catch((err: any) => {
        if (err?.statusCode === 409) return err;
        throw err;
      });
      if (after instanceof Error) {
        const afterErr = after as Error & { code?: string };
        return reply.status(409).send({
          error: afterErr.code === "CONTENT_ALREADY_LINKED" ? "content_already_has_linked_message" : "channel_message_already_linked",
          message: afterErr.code === "CONTENT_ALREADY_LINKED" ? "当前内容已关联一条频道消息，如需更换请先解除关联。" : "该频道消息已关联，不能重复绑定。",
        });
      }
      return reply.send({
        ok: true,
        contentId,
        messageKind: rawRow.mediaKind,
        postedAt: rawRow.postedAt ? new Date(rawRow.postedAt).toISOString() : null,
        channelLabel: rawRow.managedChannel?.title || rawRow.managedChannel?.username || "受控频道",
        status: "linked",
        currentLink: serializeChannelMessageRow({
          ...rawRow,
          associationStatus: "linked",
          contentId,
          linkedAt,
        }),
      });
    },
  );

  fastify.post(
    "/admin/contents/:id/unlink-channel-message",
    { preHandler: [requireAdmin()] },
    async (req: any, reply) => {
      const contentId = ZID.parse(req.params.id);
      const body = ZAUDIT_REASON.parse(req.body || {});
      const meta = adminMeta(req);
      if (meta.adminRole !== "super_admin") {
        return reply.status(403).send({ error: "forbidden", message: "权限不足，需要 super_admin" });
      }
      const linked = await (prisma as any).telegramChannelMessage.findFirst({
        where: { contentId, associationStatus: "linked" },
        orderBy: { linkedAt: "desc" },
        include: { managedChannel: { select: { id: true, title: true, username: true } } },
      });
      if (!linked) {
        return reply.status(404).send({ error: "channel_message_not_linked", message: "当前内容没有已关联的频道消息。" });
      }
      const beforeContent = await prisma.content.findUnique({
        where: { id: contentId },
        select: { telegramMessageId: true, telegramSentAt: true, telegramChatFingerprint: true },
      });
      await prisma.$transaction(async (tx: any) => {
        await tx.telegramChannelMessage.update({
          where: { id: linked.id },
          data: {
            associationStatus: "unlinked",
            contentId: null,
            linkedAt: null,
            linkedBy: null,
          },
        });
        await tx.content.update({
          where: { id: contentId },
          data: {
            telegramMessageId: null,
            telegramSentAt: null,
            telegramChatFingerprint: null,
            lastEditorId: meta.adminId,
          },
        });
        await writeAudit(
          tx,
          meta,
          "content.channel_message.unlink",
          "content",
          contentId,
          stripSensitiveFields({
            channelMessageId: linked.id,
            telegramMessageId: beforeContent?.telegramMessageId,
            telegramSentAt: beforeContent?.telegramSentAt,
            telegramChatFingerprint: beforeContent?.telegramChatFingerprint,
          }),
          stripSensitiveFields({
            channelMessageId: null,
            telegramMessageId: null,
            telegramSentAt: null,
            telegramChatFingerprint: null,
          }),
          body.reason || "解除频道消息关联",
        );
      });
      return reply.send({ ok: true, contentId, status: "unlinked" });
    },
  );

  fastify.post(
    "/admin/telegram-publish-jobs/:id/cancel",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZAUDIT_REASON.safeParse(req.body || {}).data || {};
      const meta = adminMeta(req);
      const job = await prisma.telegramPublishJob.findUnique({ where: { id } });
      if (!job) return reply.status(404).send({ error: "not_found" });
      // 仅 queued / failed / retried_exhausted 可取消（已发送的需要走撤回/deleteMessage 另外独立 API）
      if (!["queued", "failed", "retried_exhausted"].includes(job.status)) {
        return reply.status(409).send({ error: "job_status_not_cancellable", message: `当前 status=${job.status}；仅 queued/failed/retried_exhausted 可取消。已发送内容如需撤回请调用撤回独立接口。` });
      }
      const queueHandle = getPublishQueueHandle();
      const updated = await prisma.$transaction(async (tx: any) => {
        const after = await tx.telegramPublishJob.update({
          where: { id },
          data: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledByAdminId: meta.adminId,
          },
        });
        await writeAudit(tx, meta, "telegram_publish_job.cancel", "telegram_publish_job", id, null, serialize({ status: after.status, jobToken_fp: safeHexDigest(after.jobToken, 16) }), body.reason || null);
        return after;
      });
      if (queueHandle && updated.jobToken) { try { await queueHandle.remove(updated.jobToken); } catch { /* ignore */ } }
      return reply.send({ ok: true, id: updated.id, status: updated.status, cancelledAt: updated.cancelledAt });
    },
  );

  void SENSITIVE_MASK;
}

function cryptoRandomUuid(): string {
  // 简单 UUID v4 生成（Node 14+ 无 crypto.randomUUID fallback，避免依赖 uuid 包）
  const r = randomBytes(16);
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  const hex = r.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function safeHexDigest(input: string, len = 32): string {
  return createHash("sha256").update(input).digest("hex").slice(0, Math.max(8, len));
}

function truncateNote(s: unknown, n: number): string | null {
  if (s == null) return null;
  const v = String(s);
  return v.length > n ? `${v.slice(0, Math.max(0, n - 3))}...` : v;
}

// ===========================================================================
// CONTENT PACKAGES
// - 后台需要能补齐「内容包」这个前台会员页核心对象
// - 频道映射仍由 Channels 页面完成，这里只维护包与商品本身
// ===========================================================================
async function adminPackageRoutes(fastify: any) {
  const prisma = (fastify as any).prisma as PrismaClient;

  const PackageStatusZ = z.enum(["draft", "published", "offline"]);
  const ProductStatusZ = z.enum(["active", "inactive"]);
  const CurrencyZ = z.string().trim().min(2).max(16).transform((value) => value.toUpperCase());
  const PriceMinorZ = z.union([z.string(), z.number(), z.bigint()]).transform((value) => String(value).trim()).refine(
    (value) => /^\d+$/.test(value),
    "priceMinor 必须是非负整数的最小货币单位值",
  );

  const ZPACKAGE_INPUT = z.object({
    title: z.string().trim().min(1).max(200),
    coverUrl: z.string().trim().url().max(500).optional().nullable(),
    status: PackageStatusZ.default("draft"),
    productTitle: z.string().trim().min(1).max(200),
    priceMinor: PriceMinorZ,
    currency: CurrencyZ.default("XTR"),
    productStatus: ProductStatusZ.default("active"),
    reason: z.string().max(500).optional(),
  });

  async function serializePackages() {
    const rows = await prisma.contentPackage.findMany({
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: {
        product: { select: { id: true, title: true, status: true, priceMinor: true, currency: true } },
        _count: { select: { contents: true } },
      },
    });
    return rows.map((row: any) => ({
      id: row.id,
      title: row.title,
      coverUrl: row.coverUrl ?? null,
      status: row.status,
      productId: row.productId ?? null,
      productTitle: row.product?.title ?? null,
      productActive: row.product?.status === "active",
      productStatus: row.product?.status ?? "inactive",
      priceMinor: row.product?.priceMinor?.toString() ?? null,
      currency: row.product?.currency ?? null,
      channelConfigured:
        resolvePackageChannelId({ channelId: row.channelId, channelIdCiphertext: row.channelIdCiphertext }) != null,
      contentsCount: row._count?.contents || 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  fastify.get(
    "/admin/packages",
    { preHandler: [requireAdmin("content:view")] },
    async (_req: any, reply: any) => {
      return reply.send({ data: await serializePackages() });
    },
  );

  fastify.post(
    "/admin/packages",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply: any) => {
      const body = ZPACKAGE_INPUT.parse(req.body);
      const meta = adminMeta(req);
      const created = await prisma.$transaction(async (tx: any) => {
        const product = await tx.product.create({
          data: {
            type: "package",
            title: body.productTitle,
            priceMinor: BigInt(body.priceMinor),
            currency: body.currency,
            status: body.productStatus,
          },
        });
        const contentPackage = await tx.contentPackage.create({
          data: {
            title: body.title,
            coverUrl: body.coverUrl ?? null,
            status: body.status,
            productId: product.id,
          },
        });
        await writeAudit(tx, meta, "package.create", "content_package", contentPackage.id, null, serialize({
          title: contentPackage.title,
          status: contentPackage.status,
          productId: product.id,
          currency: product.currency,
          priceMinor: product.priceMinor.toString(),
        }), body.reason);
        return contentPackage;
      });
      return reply.status(201).send({ ok: true, id: created.id });
    },
  );

  fastify.patch(
    "/admin/packages/:id",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply: any) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZPACKAGE_INPUT.partial().parse(req.body);
      const meta = adminMeta(req);
      const before = await prisma.contentPackage.findUnique({
        where: { id },
        include: { product: true },
      });
      if (!before) return reply.status(404).send({ error: "not_found" });

      const updated = await prisma.$transaction(async (tx: any) => {
        let productId = before.productId;
        if (body.productTitle || body.priceMinor || body.currency || body.productStatus) {
          if (before.productId) {
            await tx.product.update({
              where: { id: before.productId },
              data: {
                title: body.productTitle ?? before.product?.title,
                priceMinor: body.priceMinor ? BigInt(body.priceMinor) : before.product?.priceMinor,
                currency: body.currency ?? before.product?.currency,
                status: body.productStatus ?? before.product?.status,
              },
            });
          } else {
            const createdProduct = await tx.product.create({
              data: {
                type: "package",
                title: body.productTitle || body.title || before.title,
                priceMinor: BigInt(body.priceMinor || "0"),
                currency: body.currency || "XTR",
                status: body.productStatus || "active",
              },
            });
            productId = createdProduct.id;
          }
        }

        const after = await tx.contentPackage.update({
          where: { id },
          data: {
            title: body.title ?? undefined,
            coverUrl: body.coverUrl ?? undefined,
            status: body.status ?? undefined,
            productId: productId ?? undefined,
          },
        });
        await writeAudit(tx, meta, "package.update", "content_package", id, serialize({
          title: before.title,
          status: before.status,
          productId: before.productId,
          productTitle: before.product?.title ?? null,
          priceMinor: before.product?.priceMinor?.toString() ?? null,
          currency: before.product?.currency ?? null,
        }), serialize({
          title: body.title ?? before.title,
          status: body.status ?? before.status,
          productId,
          productTitle: body.productTitle ?? before.product?.title ?? null,
          priceMinor: body.priceMinor ?? before.product?.priceMinor?.toString() ?? null,
          currency: body.currency ?? before.product?.currency ?? null,
        }), body.reason);
        return after;
      });
      return reply.send({ ok: true, id: updated.id });
    },
  );
}

export { adminPackageRoutes };
