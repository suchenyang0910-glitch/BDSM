import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  buildCommunityHlsManifestKey,
  buildCommunityHlsPrefix,
  createCommunityMultipartPartUploadUrl,
  createCommunityMultipartUpload,
  createCommunityPresignedUpload,
  generateCommunityObjectKey,
  getPrivateMultipartPartSizeBytes,
  headObject,
  listCommunityMultipartParts,
  normalizeHeadMetadata,
  requireObjectStorageEnv,
  streamObjectForRead,
  completeCommunityMultipartUpload,
  createPrivatePresignedReadUrl,
} from "../services/objectStorage.js";
import {
  computeCommunityObjectSha256,
  generateCommunityImageThumbnail,
  inspectCommunityObjectMedia,
  loadCommunityMediaConfig,
  rewriteCommunityManifest,
} from "../services/communityMedia.js";
import { loadCommunityFeatureConfig, startOfCurrentUtcDay } from "../services/communityConfig.js";
import { z } from "zod";
import { emitSafetyEvent } from "../utils/structuredError.js";

const createUploadSchema = z.object({
  kind: z.enum(["image", "video"]),
  filename: z.string().trim().min(1).max(256),
  mimeType: z.string().trim().min(1).max(128),
  byteSize: z.coerce.bigint().positive(),
  sha256: z.string().trim().min(16).max(128),
});

const partCompleteSchema = z.object({
  etag: z.string().trim().min(1).max(256),
  bytes: z.coerce.bigint().positive(),
  checksum: z.string().trim().min(8).max(128).optional(),
});

const completeUploadSchema = z.object({
  proof: z.object({
    etag: z.string().trim().min(1).max(256).optional(),
  }).optional(),
});

function requireUser(req: any, reply: any): string | null {
  const userId = typeof req.userId === "string" && req.userId ? req.userId : null;
  if (!userId) {
    reply.status(401).send({ error: "unauthorized", message: "请先登录。" });
    return null;
  }
  return userId;
}

function communityImageMimeAllowed(mimeType: string) {
  return /^(image\/jpeg|image\/png|image\/webp)$/i.test(mimeType);
}

function communityVideoMimeAllowed(mimeType: string) {
  return /^(video\/mp4|video\/webm|video\/quicktime)$/i.test(mimeType);
}

function nextUploadSessionExpiry() {
  return new Date(Date.now() + 15 * 60_000);
}

function isPrismaUniqueConflict(error: any) {
  return !!error && typeof error === "object" && error.code === "P2002";
}

async function hasActiveCommunityVideoCreatorGrant(prisma: any, userId: string) {
  const grant = await (prisma as any).communityVideoCreatorGrant?.findUnique?.({
    where: { userId },
    select: { active: true },
  });
  return !!grant?.active;
}

async function requireOwnedPendingPost(prisma: any, postId: string, userId: string) {
  const post = await prisma.communityPost.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true, status: true },
  });
  if (!post) return { error: { status: 404, body: { error: "community_post_not_found", message: "圈子帖子不存在。" } } };
  if (post.authorId !== userId) return { error: { status: 403, body: { error: "community_post_forbidden", message: "只有帖子作者可上传圈子媒体。" } } };
  if (post.status !== "pending") return { error: { status: 409, body: { error: "community_post_not_pending", message: "只有待审帖子允许继续上传媒体。" } } };
  return { post };
}

async function loadReadableCommunityAsset(prisma: any, postId: string, assetId: string, viewerUserId?: string | null) {
  const asset = await prisma.communityPostAsset.findFirst({
    where: { id: assetId, postId },
    include: {
      post: {
        select: {
          id: true,
          status: true,
          authorId: true,
        },
      },
    },
  });
  if (!asset || !asset.post) return null;
  if (asset.post.status === "published" && asset.moderationStatus === "approved") return asset;
  if (
    viewerUserId &&
    asset.kind === "image" &&
    asset.post.authorId === viewerUserId &&
    (asset.post.status === "pending" || asset.post.status === "rejected")
  ) {
    return asset;
  }
  return null;
}

export default async function communityMediaRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;
  const featureConfig = loadCommunityFeatureConfig(process.env);
  const mediaConfig = loadCommunityMediaConfig(process.env);

  if (!featureConfig.enabled) {
    return;
  }

  if (featureConfig.postingEnabled) fastify.post("/community/posts/:postId/assets/upload-session", async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = createUploadSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_community_upload", details: parsed.error.issues });
    const postId = String(req.params?.postId || "").trim();
    const owned = await requireOwnedPendingPost(prisma, postId, userId);
    if ("error" in owned) {
      const error = owned.error!;
      return reply.status(error.status).send(error.body);
    }
    const body = parsed.data;
    if (body.kind === "image" && !featureConfig.imageUploadEnabled) {
      return reply.status(503).send({ error: "community_image_upload_unavailable", message: "圈子图片上传正在进行对象存储验收，暂未开放。" });
    }
    if (body.kind === "image" && !communityImageMimeAllowed(body.mimeType)) {
      return reply.status(400).send({ error: "community_image_mime_invalid", message: "圈子图片仅支持 JPG/PNG/WEBP。" });
    }
    if (body.kind === "video" && !communityVideoMimeAllowed(body.mimeType)) {
      return reply.status(400).send({ error: "community_video_mime_invalid", message: "圈子短视频仅支持 MP4/WEBM/MOV。" });
    }
    if (body.kind === "image" && body.byteSize > featureConfig.maxImageBytesPerAsset) {
      return reply.status(400).send({ error: "community_image_too_large", message: "圈子图片单张不能超过 10MB。" });
    }
    if (body.kind === "video" && body.byteSize > featureConfig.maxVideoBytesPerAsset) {
      return reply.status(400).send({ error: "community_video_too_large", message: "圈子短视频不能超过 300MiB。" });
    }
    if (body.kind === "video" && !featureConfig.videoUploadEnabled) {
      return reply.status(403).send({ error: "community_video_upload_disabled", message: "圈子短视频上传尚未开放。" });
    }
    if (body.kind === "video" && !(await hasActiveCommunityVideoCreatorGrant(prisma, userId))) {
      return reply.status(403).send({ error: "community_video_creator_required", message: "仅白名单创作者可上传圈子短视频。" });
    }

    const assetId = randomUUID();
    const sessionId = randomUUID();
    const objectKey = generateCommunityObjectKey(body.kind === "image" ? "image_source" : "video_source", postId, assetId, body.filename);
    const thumbnailObjectKey = body.kind === "image" ? generateCommunityObjectKey("image_thumbnail", postId, assetId, body.filename) : null;
    const posterObjectKey = body.kind === "video" ? generateCommunityObjectKey("video_poster", postId, assetId, body.filename) : null;
    const playbackManifestKey = body.kind === "video" ? buildCommunityHlsManifestKey(postId, assetId) : null;
    const playbackPrefixKey = body.kind === "video" ? buildCommunityHlsPrefix(postId, assetId) : null;
    const partSize = body.kind === "video" ? getPrivateMultipartPartSizeBytes() : null;
    const totalParts = body.kind === "video" ? Math.ceil(Number(body.byteSize) / getPrivateMultipartPartSizeBytes()) : null;

    let uploadTarget:
      | { uploadUrl: string; uploadExpiresAt: Date; expectedHttpHeaders: Record<string, string>; storageUploadId?: string | null }
      | null = null;
    try {
      uploadTarget = body.kind === "image"
        ? await createCommunityPresignedUpload({
            sessionId,
            objectKey,
            mimeType: body.mimeType,
            contentLength: Number(body.byteSize),
            expectedSha256: body.sha256,
          })
        : {
            ...(await createCommunityMultipartUpload({
              sessionId,
              objectKey,
              mimeType: body.mimeType,
              expectedSha256: body.sha256,
            })),
            uploadUrl: "",
            uploadExpiresAt: nextUploadSessionExpiry(),
            expectedHttpHeaders: {},
          };
    } catch (error) {
      emitSafetyEvent({ event: "community_upload_init_failed", errorClass: "unknown", userId, note: `post=${postId}` }, error);
      return reply.status(503).send({ error: "community_object_storage_unavailable", message: "对象存储暂不可用，请稍后再试。" });
    }

    try {
      await prisma.$transaction(async (tx: any) => {
        const lockedPosts = await tx.$queryRawUnsafe(`SELECT id, author_id, status FROM "community_posts" WHERE id = $1 FOR UPDATE`, postId) as Array<any>;
        const lockedPost = Array.isArray(lockedPosts) ? lockedPosts[0] : null;
        if (!lockedPost) {
          throw Object.assign(new Error("community_post_not_found"), {
            statusCode: 404,
            payload: { error: "community_post_not_found", message: "圈子帖子不存在。" },
          });
        }
        if (String(lockedPost.author_id) !== userId) {
          throw Object.assign(new Error("community_post_forbidden"), {
            statusCode: 403,
            payload: { error: "community_post_forbidden", message: "只有帖子作者可上传圈子媒体。" },
          });
        }
        if (String(lockedPost.status) !== "pending") {
          throw Object.assign(new Error("community_post_not_pending"), {
            statusCode: 409,
            payload: { error: "community_post_not_pending", message: "只有待审帖子允许继续上传媒体。" },
          });
        }
        const [assetAggregate, imageCount, videoCount, imageBytesAggregate, dailyVideoUploads] = await Promise.all([
          tx.communityPostAsset.aggregate({ where: { postId }, _max: { ordinal: true } }),
          tx.communityPostAsset.count({ where: { postId, kind: "image" } }),
          tx.communityPostAsset.count({ where: { postId, kind: "video" } }),
          tx.communityUploadSession.aggregate({
            where: { postId, asset: { is: { kind: "image" } } },
            _sum: { expectedSize: true },
          }),
          body.kind === "video"
            ? tx.communityUploadSession.count({
                where: {
                  createdByUserId: userId,
                  createdAt: { gte: startOfCurrentUtcDay() },
                  asset: { is: { kind: "video" } },
                },
              })
            : Promise.resolve(0),
        ]);
        const nextOrdinal = typeof assetAggregate?._max?.ordinal === "number" ? assetAggregate._max.ordinal + 1 : 0;
        const currentImageBytes = BigInt(String(imageBytesAggregate?._sum?.expectedSize || 0));
        if (body.kind === "image") {
          if (videoCount > 0) {
            throw Object.assign(new Error("community_media_mix_forbidden"), {
              statusCode: 409,
              payload: { error: "community_media_mix_forbidden", message: "视频帖不能继续添加图片。" },
            });
          }
          if (imageCount >= featureConfig.maxImagesPerPost) {
            throw Object.assign(new Error("community_image_limit_exceeded"), {
              statusCode: 409,
              payload: { error: "community_image_limit_exceeded", message: "圈子帖子最多上传 9 张图片。" },
            });
          }
          if (currentImageBytes + body.byteSize > featureConfig.maxImageTotalBytesPerPost) {
            throw Object.assign(new Error("community_image_total_bytes_exceeded"), {
              statusCode: 409,
              payload: { error: "community_image_total_bytes_exceeded", message: "圈子图片总大小超出服务端上限。" },
            });
          }
        }
        if (body.kind === "video") {
          if (imageCount > 0 || videoCount > 0) {
            throw Object.assign(new Error("community_video_limit_exceeded"), {
              statusCode: 409,
              payload: { error: "community_video_limit_exceeded", message: "每个圈子帖子仅允许上传 1 个视频，且不能与图片混传。" },
            });
          }
          if (dailyVideoUploads >= featureConfig.maxVideoUploadsPerDay) {
            throw Object.assign(new Error("community_video_quota_exceeded"), {
              statusCode: 429,
              payload: { error: "community_video_quota_exceeded", message: "今日圈子短视频上传次数已达上限。" },
            });
          }
        }
      await tx.communityPostAsset.create({
        data: {
          id: assetId,
          postId,
          ordinal: nextOrdinal,
          kind: body.kind,
          objectKey,
          thumbnailObjectKey,
          posterObjectKey,
          playbackManifestKey,
          playbackPrefixKey,
          transcodeStatus: "pending",
          transcodeProgressPercent: 0,
          moderationStatus: "pending",
          transcodeQueueName: body.kind === "video" ? "community_transcode" : null,
          playbackQuotaBucket: body.kind === "video" ? "community_video" : null,
        },
      });
      await tx.communityUploadSession.create({
        data: {
          id: sessionId,
          postId,
          assetId,
          status: body.kind === "image" ? "initiated" : "uploading",
          objectKey,
          originalFilename: body.filename,
          expectedSize: body.byteSize,
          expectedMime: body.mimeType,
          expectedSha256: body.sha256,
          storageUploadId: body.kind === "video" ? uploadTarget?.storageUploadId || null : null,
          partSize,
          totalParts,
          expiresAt: nextUploadSessionExpiry(),
          createdByUserId: userId,
        },
      });
      await tx.communityPostAsset.update({
        where: { id: assetId },
        data: { uploadSessionId: sessionId },
      });
      await tx.communityPost.update({
        where: { id: postId },
        data: { mediaCount: { increment: 1 } },
      });
      });
    } catch (error: any) {
      if (typeof error?.statusCode === "number" && error?.payload) {
        return reply.status(error.statusCode).send(error.payload);
      }
      if (isPrismaUniqueConflict(error)) {
        emitSafetyEvent({ event: "community_asset_ordinal_conflict", errorClass: "conflict", userId, note: `post=${postId}` }, error);
        return reply.status(409).send({ error: "community_upload_conflict", message: "圈子媒体上传冲突，请重试。" });
      }
      throw error;
    }

    return reply.send({
      ok: true,
      postId,
      assetId,
      uploadSessionId: sessionId,
      uploadMode: body.kind === "image" ? "single_part" : "multipart",
      uploadUrl: uploadTarget?.uploadUrl || null,
      uploadExpiresAt: uploadTarget?.uploadExpiresAt?.toISOString() || null,
      expectedHttpHeaders: uploadTarget?.expectedHttpHeaders || {},
      partSize,
      totalParts,
    });
  });

  if (featureConfig.postingEnabled) fastify.post("/community/upload-sessions/:sessionId/parts/:partNumber/sign", async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const sessionId = String(req.params?.sessionId || "").trim();
    const partNumber = Number.parseInt(String(req.params?.partNumber || "0"), 10);
    const session = await prisma.communityUploadSession.findUnique({
      where: { id: sessionId },
      include: {
        post: { select: { authorId: true, status: true } },
      },
    });
    if (!session || !session.post) return reply.status(404).send({ error: "community_upload_session_not_found" });
    if (session.post.authorId !== userId) return reply.status(403).send({ error: "community_upload_session_forbidden" });
    if (session.post.status !== "pending") return reply.status(409).send({ error: "community_post_not_pending" });
    if (!session.storageUploadId || !session.totalParts || partNumber < 1 || partNumber > session.totalParts) {
      return reply.status(400).send({ error: "community_upload_part_invalid" });
    }
    const signed = await createCommunityMultipartPartUploadUrl({
      objectKey: session.objectKey,
      storageUploadId: session.storageUploadId,
      partNumber,
    }).catch(() => null);
    if (!signed) return reply.status(503).send({ error: "community_object_storage_unavailable" });
    await prisma.communityUploadSession.update({
      where: { id: sessionId },
      data: { status: "uploading", lastActivityAt: new Date(), expiresAt: nextUploadSessionExpiry() },
    });
    return reply.send({
      ok: true,
      partNumber,
      uploadUrl: signed.uploadUrl,
      uploadExpiresAt: signed.uploadExpiresAt.toISOString(),
      expectedHttpHeaders: signed.expectedHttpHeaders,
    });
  });

  if (featureConfig.postingEnabled) fastify.post("/community/upload-sessions/:sessionId/parts/:partNumber/complete", async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = partCompleteSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_community_upload_part", details: parsed.error.issues });
    const sessionId = String(req.params?.sessionId || "").trim();
    const partNumber = Number.parseInt(String(req.params?.partNumber || "0"), 10);
    const session = await prisma.communityUploadSession.findUnique({
      where: { id: sessionId },
      include: { post: { select: { authorId: true, status: true } } },
    });
    if (!session || !session.post) return reply.status(404).send({ error: "community_upload_session_not_found" });
    if (session.post.authorId !== userId) return reply.status(403).send({ error: "community_upload_session_forbidden" });
    if (session.post.status !== "pending") return reply.status(409).send({ error: "community_post_not_pending" });
    await prisma.$transaction(async (tx: any) => {
      await tx.communityUploadSessionPart.upsert({
        where: { uploadSessionId_partNumber: { uploadSessionId: sessionId, partNumber } },
        update: {
          etag: parsed.data.etag,
          bytes: parsed.data.bytes,
          checksum: parsed.data.checksum || null,
        },
        create: {
          uploadSessionId: sessionId,
          partNumber,
          etag: parsed.data.etag,
          bytes: parsed.data.bytes,
          checksum: parsed.data.checksum || null,
        },
      });
      const aggregate = await tx.communityUploadSessionPart.aggregate({
        where: { uploadSessionId: sessionId },
        _sum: { bytes: true },
      });
      await tx.communityUploadSession.update({
        where: { id: sessionId },
        data: {
          uploadedBytes: aggregate._sum.bytes || 0n,
          lastActivityAt: new Date(),
          expiresAt: nextUploadSessionExpiry(),
          status: "uploading",
        },
      });
    });
    return reply.send({ ok: true });
  });

  if (featureConfig.postingEnabled) fastify.post("/community/upload-sessions/:sessionId/complete", async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = completeUploadSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_community_upload_complete", details: parsed.error.issues });
    const sessionId = String(req.params?.sessionId || "").trim();
    const session = await prisma.communityUploadSession.findUnique({
      where: { id: sessionId },
      include: {
        asset: true,
        post: true,
        parts: { orderBy: { partNumber: "asc" } },
      },
    });
    if (!session || !session.asset || !session.post) return reply.status(404).send({ error: "community_upload_session_not_found" });
    if (session.createdByUserId !== userId) return reply.status(403).send({ error: "community_upload_session_forbidden" });
    if (session.post.status !== "pending") return reply.status(409).send({ error: "community_post_not_pending" });
    if (session.expiresAt.getTime() < Date.now()) return reply.status(409).send({ error: "community_upload_session_expired" });

    if (session.storageUploadId) {
      const remoteParts = await listCommunityMultipartParts(session.objectKey, session.storageUploadId).catch(() => null);
      if (!remoteParts) return reply.status(503).send({ error: "community_object_storage_unavailable" });
      const mergedParts = remoteParts.map((part: any) => ({ partNumber: part.partNumber, etag: part.etag }));
      if (session.totalParts && mergedParts.length < session.totalParts) {
        return reply.status(409).send({ error: "community_upload_parts_incomplete", message: "仍有分片未完成上传。" });
      }
      await completeCommunityMultipartUpload({
        objectKey: session.objectKey,
        storageUploadId: session.storageUploadId,
        parts: mergedParts,
      }).catch(async (error) => {
        emitSafetyEvent({ event: "community_multipart_complete_failed", errorClass: "unknown", userId, note: `session=${sessionId}` }, error);
        throw error;
      });
    }

    let storageEnv;
    try {
      storageEnv = requireObjectStorageEnv();
    } catch {
      return reply.status(503).send({ error: "community_object_storage_unavailable" });
    }
    const verify = await headObject(storageEnv.bucket, session.objectKey);
    if (!verify.ok || !verify.head) return reply.status(409).send({ error: "community_object_not_found", message: "对象存储中未找到上传文件。" });
    const meta = normalizeHeadMetadata(verify.head);
    const mismatches: string[] = [];
    if (meta.contentLength == null || meta.contentLength !== session.expectedSize) mismatches.push("byte_size");
    if ((meta.contentType || "").trim().toLowerCase() !== String(session.expectedMime || "").trim().toLowerCase()) mismatches.push("mime_type");
    let resolvedSha256 = (meta.metadataSha256 || "").trim();
    const expectedSha256 = String(session.expectedSha256 || "").trim();
    if (resolvedSha256 !== expectedSha256) {
      try {
        resolvedSha256 = await computeCommunityObjectSha256({ objectKey: session.objectKey, cfg: mediaConfig });
      } catch (error) {
        emitSafetyEvent({ event: "community_upload_object_hash_failed", errorClass: "unknown", userId, note: `session=${session.id}` }, error);
      }
    }
    if (resolvedSha256 !== expectedSha256) mismatches.push("sha256");
    if (meta.uploadSessionId && meta.uploadSessionId !== session.id) mismatches.push("upload_session_id");
    if (mismatches.length > 0) {
      emitSafetyEvent({
        event: "community_upload_metadata_mismatch",
        errorClass: "business",
        userId,
        note: `session=${session.id} mismatches=${mismatches.join(",")} expected_sha=${expectedSha256.slice(0, 12)} actual_sha=${resolvedSha256.slice(0, 12)}`,
      });
      return reply.status(409).send({ error: "community_object_metadata_mismatch", message: "上传对象校验失败。" });
    }

    let imageProbe: { width: number | null; height: number | null; aspectRatio: number | null } | null = null;
    if (session.asset.kind === "image") {
      imageProbe = await generateCommunityImageThumbnail({
        sourceObjectKey: session.objectKey,
        thumbnailObjectKey: session.asset.thumbnailObjectKey || generateCommunityObjectKey("image_thumbnail", session.postId, session.assetId, session.originalFilename),
      }).catch((error) => {
        emitSafetyEvent({ event: "community_image_thumbnail_failed", errorClass: "unknown", userId, note: `session=${sessionId}` }, error);
        throw error;
      });
    }

    let videoProbe: { width: number | null; height: number | null; durationSeconds: number | null } | null = null;
    if (session.asset.kind === "video") {
      try {
        videoProbe = await inspectCommunityObjectMedia({ objectKey: session.objectKey, cfg: mediaConfig });
      } catch (error: any) {
        emitSafetyEvent({ event: "community_video_probe_failed", errorClass: "unknown", userId, note: `session=${sessionId}` }, error);
        const message = String(error?.message || "");
        if (message.startsWith("community_ffprobe_failed:")) {
          return reply.status(409).send({ error: "community_video_probe_failed", message: "圈子短视频无法通过媒体校验。" });
        }
        return reply.status(503).send({ error: "community_media_validation_unavailable", message: "媒体校验暂不可用，请稍后重试。" });
      }
      const width = Number(videoProbe.width || 0);
      const height = Number(videoProbe.height || 0);
      const durationSeconds = Number(videoProbe.durationSeconds || 0);
      const longestEdge = Math.max(width, height);
      if (!width || !height || !durationSeconds) {
        return reply.status(409).send({ error: "community_video_probe_failed", message: "圈子短视频缺少有效的时长或分辨率信息。" });
      }
      if (durationSeconds < featureConfig.minVideoDurationSeconds || durationSeconds > featureConfig.maxVideoDurationSeconds) {
        return reply.status(409).send({ error: "community_video_duration_invalid", message: "圈子短视频时长超出允许范围。" });
      }
      if (
        width > featureConfig.maxVideoWidth ||
        height > featureConfig.maxVideoHeight ||
        longestEdge > featureConfig.maxVideoLongestEdge
      ) {
        return reply.status(409).send({ error: "community_video_resolution_invalid", message: "圈子短视频分辨率超出允许范围。" });
      }
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.communityUploadSession.update({
        where: { id: session.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          uploadedBytes: session.expectedSize,
          lastActivityAt: new Date(),
          expiresAt: nextUploadSessionExpiry(),
        },
      });
      await tx.communityPostAsset.update({
        where: { id: session.assetId },
        data: {
          objectKey: session.objectKey,
          uploadSessionId: session.id,
          moderationStatus: "pending",
          transcodeStatus: session.asset.kind === "image" ? "ready" : "pending",
          transcodeProgressPercent: session.asset.kind === "image" ? 100 : 0,
          playbackManifestKey: session.asset.kind === "video" ? (session.asset.playbackManifestKey || buildCommunityHlsManifestKey(session.postId, session.assetId)) : null,
          playbackPrefixKey: session.asset.kind === "video" ? (session.asset.playbackPrefixKey || buildCommunityHlsPrefix(session.postId, session.assetId)) : null,
          width: session.asset.kind === "image" ? imageProbe?.width || null : videoProbe?.width || null,
          height: session.asset.kind === "image" ? imageProbe?.height || null : videoProbe?.height || null,
          aspectRatio: session.asset.kind === "image" ? imageProbe?.aspectRatio || null : (
            videoProbe?.width && videoProbe?.height ? videoProbe.width / videoProbe.height : null
          ),
          durationSeconds: session.asset.kind === "video" ? videoProbe?.durationSeconds || null : null,
        },
      });
    });
    return reply.send({
      ok: true,
      assetId: session.assetId,
      status: session.asset.kind === "image" ? "ready_for_moderation" : "queued_for_transcode",
    });
  });

  fastify.get("/community/posts/:postId/assets/:assetId/image", async (req: any, reply) => {
    const postId = String(req.params?.postId || "").trim();
    const assetId = String(req.params?.assetId || "").trim();
    const asset = await loadReadableCommunityAsset(prisma, postId, assetId, typeof req.userId === "string" ? req.userId : null);
    if (!asset || asset.kind !== "image" || !asset.thumbnailObjectKey) return reply.status(404).send({ error: "community_media_not_found" });
    try {
      const signed = await createPrivatePresignedReadUrl(asset.thumbnailObjectKey, 30);
      const upstream = await fetch(signed.downloadUrl);
      if (!upstream.ok) return reply.status(404).send({ error: "community_media_not_found" });
      reply.header("Content-Type", upstream.headers.get("content-type") || "image/jpeg").header("Cache-Control", "private, no-store");
      return reply.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      return reply.status(503).send({ error: "community_media_unavailable" });
    }
  });

  fastify.get("/community/posts/:postId/assets/:assetId/poster", async (req: any, reply) => {
    const postId = String(req.params?.postId || "").trim();
    const assetId = String(req.params?.assetId || "").trim();
    const asset = await loadReadableCommunityAsset(prisma, postId, assetId, typeof req.userId === "string" ? req.userId : null);
    if (!asset || asset.kind !== "video" || !asset.posterObjectKey || asset.transcodeStatus !== "ready") return reply.status(404).send({ error: "community_media_not_found" });
    try {
      const signed = await createPrivatePresignedReadUrl(asset.posterObjectKey, 30);
      const upstream = await fetch(signed.downloadUrl);
      if (!upstream.ok) return reply.status(404).send({ error: "community_media_not_found" });
      reply.header("Content-Type", upstream.headers.get("content-type") || "image/jpeg").header("Cache-Control", "private, no-store");
      return reply.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      return reply.status(503).send({ error: "community_media_unavailable" });
    }
  });

  fastify.get("/community/media/:postId/videos/:assetId/*", async (req: any, reply) => {
    const postId = String(req.params?.postId || "").trim();
    const assetId = String(req.params?.assetId || "").trim();
    const relative = String(req.params?.["*"] || "").trim();
    const asset = await loadReadableCommunityAsset(prisma, postId, assetId, typeof req.userId === "string" ? req.userId : null);
    if (!asset || asset.kind !== "video" || asset.transcodeStatus !== "ready" || !asset.playbackPrefixKey || !asset.playbackManifestKey) {
      return reply.status(404).send({ error: "community_media_not_found" });
    }
    let objectKey: string | null = null;
    if (relative === "master.m3u8") objectKey = asset.playbackManifestKey;
    else if (/^[A-Za-z0-9._/-]+$/.test(relative) && !relative.includes("..")) objectKey = `${asset.playbackPrefixKey}/${relative}`;
    if (!objectKey) return reply.status(404).send({ error: "community_media_not_found" });
    if (relative.endsWith(".m3u8")) {
      try {
        const signed = await createPrivatePresignedReadUrl(objectKey, 30);
        const upstream = await fetch(signed.downloadUrl);
        if (!upstream.ok) return reply.status(404).send({ error: "community_media_not_found" });
        const body = rewriteCommunityManifest(postId, assetId, await upstream.text());
        return reply.header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8").header("Cache-Control", "private, no-store").send(body);
      } catch {
        return reply.status(503).send({ error: "community_media_unavailable" });
      }
    }
    try {
      const storage = requireObjectStorageEnv();
      const upstream = streamObjectForRead(storage.bucket, objectKey);
      const result: any = await upstream.client.send(upstream.command);
      if (!result?.Body || typeof result.Body.pipe !== "function") return reply.status(404).send({ error: "community_media_not_found" });
      reply.header("Content-Type", typeof result.ContentType === "string" ? result.ContentType : "video/iso.segment").header("Cache-Control", "private, no-store");
      return reply.send(result.Body);
    } catch {
      return reply.status(503).send({ error: "community_media_unavailable" });
    }
  });
}
