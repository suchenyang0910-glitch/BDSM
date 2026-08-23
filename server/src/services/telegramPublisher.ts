// ============================================================================
// telegramPublisher：Bot 发布任务队列（BullMQ + Redis）+ 缺 Redis 时 DB 轮询 fallback
//
// 【Security Boundary】
//   - 路由层 / 前端绝不提交 chatId，只允许提交 TelegramPublishChannelKind（枚举）
//     + targetFreeChannelCode（白名单内 code）。明文 chatId 仅在本文件内部：
//       ① resolveJobTargetChannelRef() 解析；
//       ② 直接传入 telegramBot.sendMediaFromStorage；
//     绝不写入审计日志、绝不写入队列 payload、绝不返回前端。
//   - 队列 payload 仅存 { jobToken: string }（唯一随机串），其余从 DB 查。
//     避免 BullMQ Redis 持久化 / 审计 / UI 暴露敏感字段。
//   - 所有对象存储 / Telegram Bot / 数据库原始错误：
//     → emitSafetyEvent（stderr 一行结构化审计）
//     → 返回 userError / lastErrorClass / lastErrorNote（仅业务语义 + 长度脱敏）
//
// 【Fallback 设计】
//   - 缺 REDIS_URL 时：启动打印 structuredLog WARN telegram_publisher_fallback_db_polling
//     + fastify.onReady setInterval 每 15s 扫 DB：
//       status=queued 或 (status=failed 且 nextRetryAt<=now AND attempt<maxAttempts)
//     + 调用 processPublishJob()。
//   - 有 REDIS_URL 但 BullMQ 构造失败时：emitSafetyEvent 后仍挂 DB 轮询兜底，不崩。
// ============================================================================

import crypto from "crypto";
import type { PrismaClient, TelegramPublishJob, MediaAsset, Content, ContentPackage, TelegramPublishChannelKind } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { emitSafetyEvent, emitStructuredLog } from "../utils/structuredError.js";
import { decryptChatIdAesGcm, chatIdIndexKey, hmacSha256Hex } from "../utils/crypto.js";

import {
  sendMediaFromStorage,
  refMembershipMain,
  refRawChatId,
  chatIdFingerprint,
  maskChatIdSafe,
  type ChannelRef,
  type TelegramBotSlot,
  type SendMediaFromStoragePayload,
} from "./telegramBot.js";

import {
  refFreeChannelByCode,
  resolveFreeChannelCodeToChatId,
  maskFreeChannelSafe,
  isValidFreeChannelCode,
} from "./freeChannels.js";

import { resolvePackageChannelId } from "./channelCrypto.js";

import { headObject, streamObjectForRead, requireObjectStorageEnv } from "./objectStorage.js";
import { appendTelegramTagLine, normalizeTelegramHashtagsFromInputs } from "./seoMetadata.js";

// ====================== 常量配置 ======================
const DEFAULT_QUEUE_NAME = "telegram-publish-default";
const DEFAULT_BOT_SLOT: TelegramBotSlot = "invite_bot";
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_RETRY_SECONDS = 5;
const DB_POLL_INTERVAL_MS = 15_000;
const BOT_DEEPLINK_PREFIX = "https://t.me/InTune_bdsm_bot?startapp=content_";
const WEB_DIRECT_LINK_PREFIX = "https://bdsm.linkx.club/?content=";

// ====================== 类型定义 ======================
type JobToken = string;

type PublishQueueHandle = {
  add: (jobToken: JobToken) => Promise<void>;
  remove: (jobToken: JobToken) => Promise<void>;
  stop: () => Promise<void>;
  mode: "bullmq" | "db_polling_fallback";
  _pollTimer?: NodeJS.Timeout;
};

type ResolvedTarget = {
  channelRef: ChannelRef;
  chatFingerprint: string;
  chatMasked: string;
  chatId: bigint;
  managedChannelId: string | null;
};

// ====================== 工具函数（与 adminCms.ts 一致，避免跨层循环依赖）======================
function truncateNote(s: unknown, n: number): string | null {
  if (s == null) return null;
  const v = String(s);
  return v.length > n ? `${v.slice(0, Math.max(0, n - 3))}...` : v;
}

function safeHexDigest(input: string, len = 32): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, Math.max(8, len));
}

// 给运营侧后台的免费频道试看文案模板（HTML parse_mode，同时放两种链接）
export function buildPreviewVideoCaption(content: Pick<Content, "id" | "title" | "description">): {
  caption: string;
  parseMode: "HTML";
} {
  const safeTitle = escapeHtml(String(content.title || "未命名内容"));
  const safeDesc = escapeHtml(
    String(content.description || "30–60 秒试看说明（运营需确保上传前已加水印）")
  ).slice(0, 280);
  const tgDeep = `${BOT_DEEPLINK_PREFIX}${encodeURIComponent(content.id)}`;
  const webDirect = `${WEB_DIRECT_LINK_PREFIX}${encodeURIComponent(content.id)}`;
  const caption = [
    `<b>《${safeTitle}》</b>`,
    "",
    `${safeDesc}`,
    "完整内容已收录于同频。",
    "",
    "点击进入 Mini App：",
    `<a href="${tgDeep}">同频 Mini App</a>`,
    `（无法打开 Mini App？<a href="${webDirect}">点击网页版</a>）`,
  ].join("\n");
  return { caption, parseMode: "HTML" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ====================== 目标频道解析：明文 chatId 仅在此函数内短暂存活 ======================
async function resolveJobTargetChannelRef(
  job: Pick<TelegramPublishJob, "channelKind" | "targetFreeChannelCode" | "contentId" | "packageId">,
  extras: {
    prisma: PrismaClient;
  }
): Promise<ResolvedTarget> {
  const kind: TelegramPublishChannelKind = job.channelKind as any;
  switch (kind) {
    case "public_free_preview": {
      if (!job.targetFreeChannelCode || !isValidFreeChannelCode(job.targetFreeChannelCode)) {
        throw new Error(`[publisher:public_free_preview] missing/invalid targetFreeChannelCode`);
      }
      const channelRef = refFreeChannelByCode(job.targetFreeChannelCode);
      const chatId = resolveFreeChannelCodeToChatId(job.targetFreeChannelCode);
      return {
        channelRef,
        chatFingerprint: chatIdFingerprint(chatId),
        chatMasked: maskFreeChannelSafe(job.targetFreeChannelCode),
        chatId,
        managedChannelId: null,
      };
    }
    case "membership_full": {
      const row = await extras.prisma.content.findUnique({
        where: { id: job.contentId || "" },
        select: { id: true },
      });
      if (!row) throw new Error(`[publisher:membership_full] content not found`);
      const membershipManaged = await extras.prisma.adminManagedChannel.findFirst({
        where: { purpose: "membership_main" },
        select: { deprecatedChatIdBig: true, chatIdCiphertextB64: true },
        orderBy: [{ updatedAt: "desc" }],
      });
      let cid: bigint | null = null;
      if (typeof membershipManaged?.deprecatedChatIdBig === "bigint") {
        cid = membershipManaged.deprecatedChatIdBig;
      } else if (membershipManaged?.chatIdCiphertextB64) {
        try { cid = decryptChatIdAesGcm(membershipManaged.chatIdCiphertextB64); } catch { cid = null; }
      }
      if (cid == null) {
        const membershipRaw = process.env.TELEGRAM_CHANNEL_MEMBERSHIP ?? process.env.MEMBERSHIP_CHANNEL_ID ?? null;
        if (!membershipRaw || !/^-?\d{6,22}$/.test(String(membershipRaw))) {
          throw new Error(`[publisher:membership_full] membership channel missing: neither adminManagedChannels(purpose=membership_main) nor TELEGRAM_CHANNEL_MEMBERSHIP is configured`);
        }
        cid = BigInt(membershipRaw);
      }
      const managed = await extras.prisma.adminManagedChannel.findUnique({
        where: { chatIdHmac: chatIdIndexKey(cid) },
        select: { id: true },
      });
      return {
        channelRef: refRawChatId(cid),
        chatFingerprint: chatIdFingerprint(cid),
        chatMasked: maskChatIdSafe(cid),
        chatId: cid,
        managedChannelId: managed?.id || null,
      };
    }
    case "package_full": {
      if (!job.packageId) throw new Error(`[publisher:package_full] missing packageId`);
      const pkg = await extras.prisma.contentPackage.findUnique({
        where: { id: job.packageId },
        select: { id: true, channelId: true, channelIdCiphertext: true },
      });
      if (!pkg) throw new Error(`[publisher:package_full] package not found`);
      const cid = resolvePackageChannelId({ channelId: pkg.channelId, channelIdCiphertext: pkg.channelIdCiphertext });
      if (cid == null) throw new Error(`[publisher:package_full] package channel not configured`);
      const managed = await extras.prisma.adminManagedChannel.findUnique({
        where: { chatIdHmac: chatIdIndexKey(cid) },
        select: { id: true },
      });
      return {
        channelRef: refRawChatId(cid),
        chatFingerprint: chatIdFingerprint(cid),
        chatMasked: maskChatIdSafe(cid),
        chatId: cid,
        managedChannelId: managed?.id || null,
      };
    }
    case "manual_target":
    default:
      throw new Error(`[publisher] unsupported channelKind: ${String(kind)}`);
  }
}

// ====================== 素材 → TG API 方法 / payload 构造 ======================
function resolveTgMethodForAsset(
  asset: Pick<MediaAsset, "kind" | "mimeType" | "originalFilename">
): { tgMethod: "sendPhoto" | "sendVideo"; mediaFilename: string; mediaContentType: string; supportsStreaming?: boolean } {
  const kind = asset.kind as any;
  const filename = asset.originalFilename || `${kind}_${safeHexDigest(String(asset.kind || "a"), 12)}`;
  const contentType = asset.mimeType || (kind === "cover_image" ? "image/jpeg" : "video/mp4");
  if (kind === "cover_image") {
    return { tgMethod: "sendPhoto", mediaFilename: filename, mediaContentType: contentType };
  }
  return {
    tgMethod: "sendVideo",
    mediaFilename: filename,
    mediaContentType: contentType,
    supportsStreaming: true,
  };
}

// ====================== 核心作业处理函数（同步/队列/DB 轮询 都走这一个函数）======================
type PublishJobIncludes = TelegramPublishJob & {
  mediaAsset: MediaAsset | null;
  content: ({ id: string; title: string; description: string | null; accessType: string; packageId: string | null }) | null;
  package: ({ id: string; title: string }) | null;
};

export async function processPublishJob(
  prisma: PrismaClient,
  jobData: { jobToken: JobToken },
  ctx: { botSlotOverride?: TelegramBotSlot } = {}
): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  // Step 0: 找到 job 行 + 持乐观锁 update status=processing where status in (queued|failed|retried_exhausted? 不允许 exhausted)
  let job: PublishJobIncludes | null = null;
  try {
    job = await prisma.telegramPublishJob.findUnique({
      where: { jobToken: jobData.jobToken },
      include: {
        mediaAsset: true,
        content: { select: { id: true, title: true, description: true, accessType: true, packageId: true } },
        package: { select: { id: true, title: true } },
      },
    }) as unknown as PublishJobIncludes | null;
  } catch (err) {
    emitSafetyEvent({ event: "tg_publish_job_find_failed", errorClass: "db_error", note: `token_len=${String(jobData.jobToken).length}` }, err);
    return { ok: false, reason: "db_find_job_failed" };
  }
  if (!job) {
    emitSafetyEvent({ event: "tg_publish_job_not_found", errorClass: "not_found", note: `token_fp=${safeHexDigest(String(jobData.jobToken), 16)}` });
    return { ok: false, skipped: true, reason: "job_not_found" };
  }
  if (job.status === "sent" || job.status === "cancelled") {
    return { ok: true, skipped: true, reason: `already_${job.status}` };
  }
  if (job.status === "retried_exhausted") {
    return { ok: false, skipped: true, reason: "retried_exhausted_skip" };
  }
  const initialJobId = job.id;

  // 拿锁：CAS update 避免双 Worker 重复发送（DB 轮询 & BullMQ 并行时）
  try {
    const now = new Date();
    const locked = await prisma.telegramPublishJob.updateMany({
      where: {
        id: initialJobId,
        status: { in: ["queued", "failed"] },
      },
      data: { status: "processing", lastAttemptedAt: now, attempt: { increment: 1 } },
    });
    if (locked.count === 0) {
      return { ok: false, skipped: true, reason: "race_locked_by_another_worker" };
    }
    // 重新读以同步最新 attempt 值
    job = await prisma.telegramPublishJob.findUnique({
      where: { id: initialJobId },
      include: {
        mediaAsset: true,
        content: { select: { id: true, title: true, description: true, accessType: true, packageId: true } },
        package: { select: { id: true, title: true } },
      },
    }) as unknown as PublishJobIncludes | null;
    if (!job) return { ok: false, reason: "job_vanished_after_lock" };
  } catch (err) {
    emitSafetyEvent({ event: "tg_publish_job_lock_failed", errorClass: "db_error", note: `id_fp=${safeHexDigest(initialJobId, 12)}` }, err);
    return { ok: false, reason: "db_lock_failed" };
  }

  const asset: MediaAsset | null = job.mediaAsset;
  if (!asset || asset.status !== "ready" || !asset.storageBucket || !asset.storageKey) {
    await markJobFailed(prisma, job.id, {
      lastErrorClass: "asset_not_ready",
      lastErrorNote: `status=${asset?.status || "null"} key_len=${String(asset?.storageKey || "").length}`,
      bumpRetry: true,
    });
    return { ok: false, reason: "asset_not_ready" };
  }

  // Step 1: requireObjectStorageEnv + HeadObject 二次校验（上传后可能被删/覆盖）
  let resolved: ResolvedTarget;
  try {
    requireObjectStorageEnv();
    await headObject(asset.storageBucket, asset.storageKey);
  } catch (err) {
    await markJobFailed(prisma, job.id, {
      lastErrorClass: "object_storage_head_failed",
      lastErrorNote: truncateNote(err instanceof Error ? err.message : String(err), 180),
      bumpRetry: true,
    });
    return { ok: false, reason: "head_object_failed" };
  }

  // Step 2: 解析目标 ChannelRef（仅此处出现明文 chatId → 直接传入 sendMediaFromStorage）
  try {
    resolved = await resolveJobTargetChannelRef(job, { prisma });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitSafetyEvent({ event: "tg_publish_resolve_target_failed", errorClass: "channel_ref_invalid", note: `msg_len=${msg.length}` }, err);
    await markJobFailed(prisma, job.id, {
      lastErrorClass: "channel_ref_invalid",
      lastErrorNote: msg.includes("missing or invalid") || msg.includes("TELEGRAM_")
        ? "target_channel_env_unconfigured"
        : truncateNote(msg, 180),
      bumpRetry: false,
      exhaust: true,
    });
    return { ok: false, reason: "target_channel_invalid" };
  }

  // Step 3: 组装 caption（public_free_preview 才走模板；其余纯无 caption 或未来扩展）
  const normalizedTelegramTags = normalizeTelegramHashtagsFromInputs([
    Array.isArray((job as any).telegramTagsJson) ? (job as any).telegramTagsJson : [],
  ]);
  const isPreviewKind = job.channelKind === "public_free_preview" && asset.kind === "preview_video";
  let captionBundle: { caption?: string; parseMode?: "HTML" } = {};
  if (typeof job.captionText === "string" && job.captionText.trim()) {
    captionBundle = {
      caption: appendTelegramTagLine(job.captionText, normalizedTelegramTags),
      parseMode: job.parseMode === "HTML" ? "HTML" : undefined,
    };
  } else if (isPreviewKind && job.content) {
    const previewBundle = buildPreviewVideoCaption(job.content);
    captionBundle = {
      caption: appendTelegramTagLine(previewBundle.caption, normalizedTelegramTags),
      parseMode: previewBundle.parseMode,
    };
  } else if (normalizedTelegramTags.length > 0) {
    captionBundle = { caption: normalizedTelegramTags.join(" ") };
  }

  // Step 4: 流式读对象存储 → 组装 multipart payload → 调 sendMediaFromStorage
  let streamCleanup: { client?: any; command?: any } = {};
  try {
    const meta = resolveTgMethodForAsset(asset);
    const { client, command, sseErrorEvent } = streamObjectForRead(asset.storageBucket, asset.storageKey);
    streamCleanup = { client, command };
    // 把 S3 响应 body 作为 ReadableStream 直接交给 Blob body
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp: any = await (client as any).send(command);
    if (!resp || !resp.Body) {
      emitSafetyEvent({ ...sseErrorEvent, note: `${sseErrorEvent.note} empty_body` });
      throw new Error("s3_empty_body");
    }
    const readable = resp.Body as unknown as NodeJS.ReadableStream;
    const payload: SendMediaFromStoragePayload = {
      tgMethod: meta.tgMethod,
      mediaFilename: meta.mediaFilename,
      mediaContentType: meta.mediaContentType,
      mediaBody: readable as any,
      supportsStreaming: meta.supportsStreaming,
      caption: captionBundle.caption,
      parseMode: captionBundle.parseMode,
    };
    const slot: TelegramBotSlot | undefined = ctx.botSlotOverride || (job.botKey === "primary" || job.botKey === "invite_bot" ? "invite_bot" : (job.botKey as TelegramBotSlot));
    const result = await sendMediaFromStorage(slot, resolved.channelRef, payload);

    if (!result.success || !result.messageId) {
      const errCode = result.errorCode ?? 500;
      await markJobFailed(prisma, job.id, {
        lastErrorClass: "tg_bot_send_failed",
        lastErrorNote: truncateNote(`code=${errCode} ${result.errorNote || ""}`, 180),
        bumpRetry: true,
      });
      return { ok: false, reason: "tg_send_failed" };
    }

    // Step 5: 成功！事务内更新 job + content/package（回填 messageId / sentAt / chatFingerprint）
    const now = new Date();
    const assetUpdateData: any = {};
    if (typeof result.width === "number") assetUpdateData.widthPixels = result.width;
    if (typeof result.height === "number") assetUpdateData.heightPixels = result.height;
    if (typeof result.durationSeconds === "number") assetUpdateData.durationSeconds = result.durationSeconds;
    await prisma.$transaction(async (tx) => {
      await tx.telegramPublishJob.update({
        where: { id: job!.id },
        data: {
          status: "sent",
          sentAt: now,
          telegramMethod: meta.tgMethod,
          telegramMessageId: BigInt(result.messageId!),
          telegramFileId: result.telegramFileId ?? null,
          telegramFileUniqueId: result.telegramFileUniqueId ?? null,
          targetChatFingerprint: resolved.chatFingerprint,
          targetChatMasked: resolved.chatMasked,
          captionText: captionBundle.caption ?? null,
          parseMode: captionBundle.parseMode ?? null,
          lastErrorClass: null,
          lastErrorNote: null,
          nextRetryAt: null,
        },
      });
      if (job!.contentId) {
        await tx.content.update({
          where: { id: job!.contentId },
          data: {
            telegramMessageId: BigInt(result.messageId!),
            telegramSentAt: now,
            telegramChatFingerprint: resolved.chatFingerprint,
          },
        });
        if (resolved.managedChannelId) {
          await (tx as any).telegramChannelMessage.upsert({
            where: {
              managedChannelId_messageId: {
                managedChannelId: resolved.managedChannelId,
                messageId: BigInt(result.messageId!),
              },
            },
            create: {
              managedChannelId: resolved.managedChannelId,
              messageId: BigInt(result.messageId!),
              mediaKind: meta.tgMethod === "sendPhoto" ? "photo" : "video",
              captionFingerprint: captionBundle.caption ? hmacSha256Hex(`telegram_channel_caption:${captionBundle.caption}`) : null,
              postedAt: now,
              associationStatus: "linked",
              contentId: job!.contentId,
              linkedAt: now,
              linkedBy: job!.adminId || null,
            },
            update: {
              mediaKind: meta.tgMethod === "sendPhoto" ? "photo" : "video",
              captionFingerprint: captionBundle.caption ? hmacSha256Hex(`telegram_channel_caption:${captionBundle.caption}`) : null,
              postedAt: now,
              associationStatus: "linked",
              contentId: job!.contentId,
              linkedAt: now,
              linkedBy: job!.adminId || null,
            },
          });
        }
      }
      if (job!.packageId) {
        // 注意：content_package 目前无独立 telegram_message_id 列（需要时再补 migration），先不写。
      }
      if (job!.mediaAssetId && (asset.kind === "full_video" || asset.kind === "preview_video") && Object.keys(assetUpdateData).length > 0) {
        await tx.mediaAsset.update({
          where: { id: job!.mediaAssetId },
          data: assetUpdateData,
        });
      }
    });
    return { ok: true };
  } catch (err) {
    emitSafetyEvent({ event: "tg_publish_process_unhandled_error", errorClass: "internal", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
    await markJobFailed(prisma, job.id, {
      lastErrorClass: "publish_process_internal",
      lastErrorNote: truncateNote(err instanceof Error ? err.message : String(err), 180),
      bumpRetry: true,
    });
    return { ok: false, reason: "process_internal_error" };
  } finally {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c: any = streamCleanup.client;
      if (c && typeof c.destroy === "function") c.destroy();
    } catch {
      /* ignore */
    }
  }
}

// ====================== 失败回写 + 指数退避 ======================
async function markJobFailed(
  prisma: PrismaClient,
  jobId: string,
  opts: { lastErrorClass: string; lastErrorNote: string | null; bumpRetry?: boolean; exhaust?: boolean }
): Promise<void> {
  try {
    const current = await prisma.telegramPublishJob.findUnique({ where: { id: jobId }, select: { attempt: true, maxAttempts: true } });
    const attempt = current?.attempt ?? 0;
    const maxAttempts = current?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const willExhaust = Boolean(opts.exhaust) || attempt >= maxAttempts;
    const nextRetryAt = willExhaust
      ? null
      : new Date(Date.now() + BASE_RETRY_SECONDS * 1000 * Math.pow(2, Math.max(0, attempt)));
    await prisma.telegramPublishJob.update({
      where: { id: jobId },
      data: {
        status: willExhaust ? "retried_exhausted" : "failed",
        lastErrorClass: opts.lastErrorClass,
        lastErrorNote: opts.lastErrorNote,
        nextRetryAt: nextRetryAt ?? undefined,
      },
    });
  } catch (err) {
    emitSafetyEvent({ event: "tg_publish_mark_failed_failed", errorClass: "db_error", note: `job_fp=${safeHexDigest(jobId, 12)}` }, err);
  }
}

// ====================== Queue 初始化：BullMQ or DB 轮询 fallback ======================
let _sharedHandle: PublishQueueHandle | null = null;

export function getPublishQueueHandle(): PublishQueueHandle | null {
  return _sharedHandle;
}

export async function initTelegramPublisher(fastify: FastifyInstance): Promise<PublishQueueHandle> {
  if (_sharedHandle) return _sharedHandle;
  const prisma = (fastify as any).prisma as PrismaClient;
  const redisUrl = String(process.env.REDIS_URL || "").trim();

  let mode: PublishQueueHandle["mode"] = "db_polling_fallback";
  let bullQueue: any = null;
  let bullWorker: any = null;

  if (redisUrl && redisUrl.length >= 8) {
    try {
      // 延迟动态 import：缺 bullmq 包不崩
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Queue, Worker } = require("bullmq");
      bullQueue = new Queue(DEFAULT_QUEUE_NAME, {
        connection: redisUrl,
        defaultJobOptions: {
          attempts: DEFAULT_MAX_ATTEMPTS,
          removeOnComplete: 1000,
          removeOnFail: 5000,
          backoff: { type: "exponential", delay: BASE_RETRY_SECONDS * 1000 },
        },
      });
      bullWorker = new Worker(
        DEFAULT_QUEUE_NAME,
        async (jobRun: any) => {
          const data = jobRun && jobRun.data ? (jobRun.data as { jobToken?: string }) : {};
          if (!data.jobToken) return;
          try {
            await processPublishJob(prisma, { jobToken: data.jobToken });
          } catch (err) {
            emitSafetyEvent({ event: "tg_publish_bull_worker_crash", errorClass: "worker_crash", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
          }
        },
        { connection: redisUrl, concurrency: 2 }
      );
      bullWorker.on("failed", (_j: any, err: any) => {
        emitSafetyEvent({ event: "tg_publish_bull_job_failed", errorClass: "bullmq_failed", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
      });
      mode = "bullmq";
    } catch (err) {
      emitSafetyEvent({ event: "tg_publish_bullmq_init_failed", errorClass: "bullmq_init_failed", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
      mode = "db_polling_fallback";
    }
  } else {
    emitStructuredLog({
      event: "telegram_publisher_fallback_db_polling",
      counts: { interval_ms: DB_POLL_INTERVAL_MS },
      note: "REDIS_URL empty — BullMQ disabled, falling back to DB polling scheduler (single-node only).",
    });
  }

  const handle: PublishQueueHandle = {
    mode,
    async add(jobToken: JobToken) {
      if (!jobToken) return;
      if (mode === "bullmq" && bullQueue) {
        await bullQueue.add(`job_${safeHexDigest(jobToken, 8)}`, { jobToken });
        return;
      }
      // DB 轮询模式：只要 DB job.status=queued，下一轮会自动扫到 → 无需额外动作
      emitStructuredLog({ event: "tg_publish_enqueue_db_mode", counts: { enqueued: 1 }, note: `token_fp=${safeHexDigest(jobToken, 12)}` });
    },
    async remove(jobToken: JobToken) {
      if (!jobToken) return;
      if (mode === "bullmq" && bullQueue) {
        try {
          const jobs = await bullQueue.getJobs(["waiting", "delayed", "active"]);
          for (const j of jobs) {
            if (j && j.data && j.data.jobToken === jobToken) {
              await j.remove();
            }
          }
        } catch (err) {
          emitSafetyEvent({ event: "tg_publish_bull_remove_failed", errorClass: "bull_queue_error", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
        }
      }
    },
    async stop() {
      if (handle._pollTimer) {
        clearInterval(handle._pollTimer);
        handle._pollTimer = undefined;
      }
      if (bullWorker) {
        try { await bullWorker.close(); } catch { /* ignore */ }
      }
      if (bullQueue) {
        try { await bullQueue.close(); } catch { /* ignore */ }
      }
      _sharedHandle = null;
    },
  };

  // DB 轮询 fallback：无论是否 BullMQ，挂一个兜底（双保险，防 BullMQ 挂了后静默丢任务）
  fastify.addHook("onReady", (done: any) => {
    handle._pollTimer = setInterval(async () => {
      try {
        const now = new Date();
        const rows = await prisma.telegramPublishJob.findMany({
          where: {
            OR: [
              { status: "queued" },
              { status: "failed", nextRetryAt: { lte: now } },
            ],
          },
          orderBy: [{ createdAt: "asc" }],
          take: 8,
          select: { jobToken: true },
        });
        for (const r of rows) {
          try {
            await processPublishJob(prisma, { jobToken: r.jobToken });
          } catch (err) {
            emitSafetyEvent({ event: "tg_publish_db_poll_crash", errorClass: "internal", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
          }
        }
      } catch (err) {
        emitSafetyEvent({ event: "tg_publish_db_poll_scan_failed", errorClass: "db_error", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
      }
    }, DB_POLL_INTERVAL_MS);
    handle._pollTimer.unref?.();
    done();
  });

  _sharedHandle = handle;
  return handle;
}

export const TELEGRAM_PUBLISHER_CONSTANTS = Object.freeze({
  DEFAULT_QUEUE_NAME,
  DEFAULT_BOT_SLOT,
  DEFAULT_MAX_ATTEMPTS,
  BASE_RETRY_SECONDS,
  DB_POLL_INTERVAL_MS,
});
