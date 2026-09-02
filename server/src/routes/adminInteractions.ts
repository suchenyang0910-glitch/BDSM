import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin, type AdminSession } from "./admin.js";
import { loadCommunityFeatureConfig } from "../services/communityConfig.js";

const listReportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["open", "reviewing", "actioned", "dismissed"]).optional(),
  targetType: z.enum(["video_content", "article", "circle_post"]).optional(),
  targetId: z.string().trim().min(1).max(64).optional(),
  commentId: z.string().trim().min(1).max(64).optional(),
});

const listCommentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["pending", "approved", "hidden", "rejected", "deleted"]).default("pending"),
  targetType: z.enum(["video_content", "article", "circle_post"]).optional(),
  targetId: z.string().trim().min(1).max(64).optional(),
});

const listCommunityPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["pending", "published", "hidden", "removed"]).optional(),
  keyword: z.string().trim().max(100).optional(),
});

const reviewReportSchema = z.object({
  status: z.enum(["reviewing", "actioned", "dismissed"]),
  resolutionNote: z.string().trim().max(500).optional(),
  commentStatus: z.enum(["approved", "hidden", "rejected", "deleted"]).optional(),
  commentReason: z.string().trim().max(500).optional(),
});

const moderateCommentSchema = z.object({
  status: z.enum(["approved", "hidden", "rejected", "deleted"]),
  reason: z.string().trim().max(500).optional(),
});

const moderateCommunityPostSchema = z.object({
  status: z.enum(["published", "hidden", "removed"]),
  reason: z.string().trim().max(500).optional(),
});

const pinCommunityPostSchema = z.object({
  pinned: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

function adminMeta(req: FastifyRequest) {
  const admin = (req as any).admin as AdminSession;
  return {
    adminId: admin.adminId,
    ipAddress: (req.ip as string) || null,
    userAgent: (req.headers["user-agent"] as string) || null,
  };
}

async function writeAudit(prisma: any, req: FastifyRequest, action: string, objectType: string, objectId: string, before: any, after: any, reason?: string) {
  const meta = adminMeta(req);
  await prisma.adminAuditLog.create({
    data: {
      adminId: meta.adminId,
      action,
      objectType,
      objectId,
      beforeValue: before,
      afterValue: after,
      reason: reason || null,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });
}

async function loadInteractionReportContext(prisma: any, reportId: string) {
  return prisma.interactionReport.findUnique({
    where: { id: reportId },
    include: {
      reporter: { select: { id: true, displayName: true } },
      comment: {
        include: {
          user: { select: { id: true, displayName: true } },
        },
      },
    },
  });
}

async function syncParentReplyCount(tx: any, comment: any) {
  if (!comment?.parentId) return;
  const remainingReplies = await tx.interactionComment.count({
    where: {
      parentId: comment.parentId,
      status: "approved",
    },
  });
  await tx.interactionComment.update({
    where: { id: comment.parentId },
    data: { replyCount: remainingReplies },
  });
}

async function syncCirclePostApprovedCommentCount(tx: any, postId: string) {
  const commentCount = await tx.interactionComment.count({
    where: {
      targetType: "circle_post",
      targetId: postId,
      status: "approved",
    },
  });
  await tx.communityPost.update({
    where: { id: postId },
    data: { commentCount },
  });
}

async function loadTargetBrief(prisma: any, targetType: string, targetId: string) {
  if (targetType === "video_content") {
    const content = await prisma.content.findUnique({
      where: { id: targetId },
      select: { id: true, title: true, status: true },
    });
    return content ? { id: content.id, title: content.title, status: content.status } : null;
  }
  if (targetType === "article") {
    const article = await prisma.article.findUnique({
      where: { id: targetId },
      select: { id: true, title: true, status: true },
    });
    return article ? { id: article.id, title: article.title, status: article.status } : null;
  }
  if (targetType === "circle_post") {
    const post = await prisma.communityPost.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        body: true,
        status: true,
      },
    });
    if (!post) return null;
    const title = String(post.body || "").trim().slice(0, 40) || post.id;
    return { id: post.id, title, status: post.status };
  }
  return { id: targetId, title: targetId, status: "unknown" };
}

function mapCommunityPostAsset(item: any) {
  return {
    id: item.id,
    ordinal: item.ordinal,
    kind: item.kind,
    width: item.width ?? null,
    height: item.height ?? null,
    aspectRatio: item.aspectRatio ?? null,
    durationSeconds: item.durationSeconds ?? null,
    transcodeStatus: item.transcodeStatus,
    transcodeProgressPercent: item.transcodeProgressPercent ?? 0,
    moderationStatus: item.moderationStatus,
    transcodeQueueName: item.transcodeQueueName || null,
    playbackQuotaBucket: item.playbackQuotaBucket || null,
  };
}

async function loadAuditEntries(prisma: any, objectType: string, objectId: string, page = 1, pageSize = 20) {
  const [total, items] = await Promise.all([
    prisma.adminAuditLog.count({ where: { objectType, objectId } }),
    prisma.adminAuditLog.findMany({
      where: { objectType, objectId },
      include: {
        admin: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: [{ createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    items: items.map((item: any) => ({
      id: item.id,
      action: item.action,
      reason: item.reason || null,
      beforeValue: item.beforeValue || null,
      afterValue: item.afterValue || null,
      createdAt: item.createdAt.toISOString(),
      admin: item.admin
        ? {
            id: item.admin.id,
            displayName: item.admin.displayName || item.admin.email || "管理员",
            email: item.admin.email || null,
          }
        : null,
    })),
  };
}

function validateCommunityAssetPrefixes(postId: string, asset: any): { ok: true } | { ok: false; error: string; message: string } {
  const expectedBase = asset.kind === "video"
    ? `community/posts/${postId}/videos/${asset.id}/`
    : `community/posts/${postId}/images/${asset.id}/`;
  if (!asset.objectKey || !String(asset.objectKey).startsWith(expectedBase)) {
    return { ok: false, error: "community_asset_prefix_invalid", message: "圈子媒体未使用独立 community 对象存储前缀。" };
  }
  if (asset.kind === "video") {
    if (asset.transcodeQueueName !== "community_transcode") {
      return { ok: false, error: "community_video_queue_invalid", message: "圈子短视频必须登记到独立 community_transcode 队列。" };
    }
    if (asset.playbackQuotaBucket !== "community_video") {
      return { ok: false, error: "community_video_quota_invalid", message: "圈子短视频必须使用独立 community_video 播放额度桶。" };
    }
  }
  return { ok: true };
}

export default async function adminInteractionRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;
  const communityFeatureConfig = loadCommunityFeatureConfig(process.env);

  function rejectDisabledCommunity(reply: any) {
    return reply.status(404).send({ error: "community_disabled", message: "圈子功能尚未开放。" });
  }

  fastify.get("/admin/interactions/comments", { preHandler: [requireAdmin("ticket:view")] }, async (req, reply) => {
    const parsed = listCommentsQuerySchema.parse(req.query || {});
    const { page, pageSize, status, targetType, targetId } = parsed;
    if (targetType === "circle_post" && !communityFeatureConfig.enabled) {
      return rejectDisabledCommunity(reply);
    }
    const where: any = { status };
    if (!communityFeatureConfig.enabled) {
      where.targetType = targetType && targetType !== "circle_post" ? targetType : { not: "circle_post" };
    }
    if (targetType) where.targetType = targetType;
    if (targetId) where.targetId = targetId;
    const [total, items] = await Promise.all([
      prisma.interactionComment.count({ where }),
      prisma.interactionComment.findMany({
        where,
        include: {
          user: { select: { id: true, displayName: true } },
          parent: {
            select: {
              id: true,
              body: true,
              user: { select: { id: true, displayName: true } },
            },
          },
          _count: { select: { reports: true } },
        },
        orderBy: [{ createdAt: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const targetIdsByType = items.reduce((acc: Record<string, Set<string>>, item: any) => {
      const bucket = acc[item.targetType] || new Set<string>();
      bucket.add(item.targetId);
      acc[item.targetType] = bucket;
      return acc;
    }, {} as Record<string, Set<string>>);
    const targetMap = new Map<string, { id: string; title: string; status: string } | null>();
    await Promise.all(
      (Object.entries(targetIdsByType) as Array<[string, Set<string>]>).flatMap(([type, ids]) =>
        Array.from(ids).map(async (id) => {
          targetMap.set(`${type}:${id}`, await loadTargetBrief(prisma, type, id));
        }),
      ),
    );
    return {
      total,
      page,
      pageSize,
      items: items.map((item: any) => ({
        id: item.id,
        targetType: item.targetType,
        targetId: item.targetId,
        parentId: item.parentId || null,
        rootId: item.rootId || null,
        body: item.body,
        status: item.status,
        likeCount: item.likeCount,
        replyCount: item.replyCount,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        moderatedAt: item.moderatedAt ? item.moderatedAt.toISOString() : null,
        moderationReason: item.moderationReason || null,
        reportCount: item._count?.reports || 0,
        author: item.user
          ? {
              id: item.user.id,
              displayName: item.user.displayName || "同频成员",
            }
          : null,
        parentComment: item.parent
          ? {
              id: item.parent.id,
              body: item.parent.body,
              author: item.parent.user
                ? {
                    id: item.parent.user.id,
                    displayName: item.parent.user.displayName || "同频成员",
                  }
                : null,
            }
          : null,
        target: targetMap.get(`${item.targetType}:${item.targetId}`),
      })),
    };
  });

  fastify.get("/admin/interactions/reports", { preHandler: [requireAdmin("ticket:view")] }, async (req, reply) => {
    const parsed = listReportsQuerySchema.parse(req.query || {});
    const { page, pageSize, status, targetType, targetId, commentId } = parsed;
    if (targetType === "circle_post" && !communityFeatureConfig.enabled) {
      return rejectDisabledCommunity(reply);
    }
    const where: any = {};
    if (!communityFeatureConfig.enabled) {
      where.targetType = targetType && targetType !== "circle_post" ? targetType : { not: "circle_post" };
    }
    if (status) where.status = status;
    if (targetType) where.targetType = targetType;
    if (targetId) where.targetId = targetId;
    if (commentId) where.commentId = commentId;
    const [total, items] = await Promise.all([
      prisma.interactionReport.count({ where }),
      prisma.interactionReport.findMany({
        where,
        include: {
          reporter: { select: { id: true, displayName: true } },
          reviewer: { select: { id: true, displayName: true, email: true } },
          comment: {
            select: { id: true, body: true, status: true, likeCount: true, replyCount: true },
          },
        },
        orderBy: [{ createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      page,
      pageSize,
      items: items.map((item: any) => ({
        id: item.id,
        status: item.status,
        targetType: item.targetType,
        targetId: item.targetId,
        reasonCode: item.reasonCode,
        detailText: item.detailText,
        createdAt: item.createdAt.toISOString(),
        reviewedAt: item.reviewedAt ? item.reviewedAt.toISOString() : null,
        resolutionNote: item.resolutionNote || null,
        reporter: item.reporter,
        reviewer: item.reviewer,
        comment: item.comment,
      })),
    };
  });

  fastify.get<{ Params: { id: string } }>("/admin/interactions/comments/:id/audit-logs", { preHandler: [requireAdmin("ticket:view")] }, async (req, reply) => {
    const id = String(req.params.id || "").trim();
    if (!id) return reply.status(400).send({ error: "invalid_comment_id" });
    return loadAuditEntries(prisma, "interaction_comment", id);
  });

  fastify.post<{ Params: { id: string } }>("/admin/interactions/reports/:id/review", { preHandler: [requireAdmin("ticket:resolve")] }, async (req, reply) => {
    const parsed = reviewReportSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_report_review", details: parsed.error.issues });
    const before = await loadInteractionReportContext(prisma, req.params.id);
    if (!before) return reply.status(404).send({ error: "interaction_report_not_found", message: "举报记录不存在。" });
    const meta = adminMeta(req);
    const payload = parsed.data;
    if (!before.commentId && payload.status === "actioned") {
      return reply.status(409).send({
        error: "target_level_action_not_supported",
        message: "E1 仅支持对举报评论执行已处理动作；文章/视频目标级举报当前只能标记为 reviewing 或 dismissed。",
      });
    }
    const after = await prisma.$transaction(async (tx: any) => {
      const updatedReport = await tx.interactionReport.update({
        where: { id: before.id },
        data: {
          status: payload.status,
          resolutionNote: payload.resolutionNote || null,
          reviewedBy: meta.adminId,
          reviewedAt: new Date(),
        },
      });
      if (before.commentId && payload.commentStatus) {
        const commentBefore = await tx.interactionComment.findUnique({
          where: { id: before.commentId },
          select: { id: true, parentId: true, status: true, targetType: true, targetId: true },
        });
        const updatedComment = await tx.interactionComment.update({
          where: { id: before.commentId },
          data: {
            status: payload.commentStatus,
            moderationReason: payload.commentReason || payload.resolutionNote || null,
            moderatedBy: meta.adminId,
            moderatedAt: new Date(),
          },
        });
        if (commentBefore && commentBefore.parentId && commentBefore.status !== updatedComment.status) {
          await syncParentReplyCount(tx, updatedComment);
        }
        if (commentBefore && commentBefore.targetType === "circle_post" && commentBefore.status !== updatedComment.status) {
          await syncCirclePostApprovedCommentCount(tx, commentBefore.targetId);
        }
      }
      return updatedReport;
    });
    const afterContext = await loadInteractionReportContext(prisma, after.id);
    await writeAudit(
      prisma,
      req,
      "interaction.report.review",
      "interaction_report",
      before.id,
      {
        status: before.status,
        resolutionNote: before.resolutionNote,
        commentStatus: before.comment?.status || null,
      },
      {
        status: afterContext?.status,
        resolutionNote: afterContext?.resolutionNote || null,
        commentStatus: afterContext?.comment?.status || null,
      },
      payload.resolutionNote,
    );
    return { ok: true, report: afterContext };
  });

  fastify.post<{ Params: { id: string } }>("/admin/interactions/comments/:id/moderate", { preHandler: [requireAdmin("ticket:resolve")] }, async (req, reply) => {
    const parsed = moderateCommentSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_comment_moderation", details: parsed.error.issues });
    const before = await prisma.interactionComment.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, displayName: true } } },
    });
    if (!before) return reply.status(404).send({ error: "interaction_comment_not_found", message: "评论不存在。" });
    const meta = adminMeta(req);
    const after = await prisma.$transaction(async (tx: any) => {
      const updated = await tx.interactionComment.update({
        where: { id: before.id },
        data: {
          status: parsed.data.status,
          moderationReason: parsed.data.reason || null,
          moderatedBy: meta.adminId,
          moderatedAt: new Date(),
        },
        include: { user: { select: { id: true, displayName: true } } },
      });
      if (before.parentId && before.status !== updated.status) {
        await syncParentReplyCount(tx, updated);
      }
      if (before.targetType === "circle_post" && before.status !== updated.status) {
        await syncCirclePostApprovedCommentCount(tx, before.targetId);
      }
      return updated;
    });
    await writeAudit(
      prisma,
      req,
      "interaction.comment.moderate",
      "interaction_comment",
      before.id,
      { status: before.status, moderationReason: before.moderationReason || null },
      { status: after.status, moderationReason: after.moderationReason || null },
      parsed.data.reason,
    );
    return { ok: true, comment: after };
  });

  if (communityFeatureConfig.enabled) fastify.get("/admin/community/posts", { preHandler: [requireAdmin("ticket:view")] }, async (req) => {
    const parsed = listCommunityPostsQuerySchema.parse(req.query || {});
    const { page, pageSize, status, keyword } = parsed;
    const where: any = {};
    if (status) where.status = status;
    if (keyword) {
      where.OR = [
        { body: { contains: keyword, mode: "insensitive" } },
        { topics: { has: keyword } },
        { author: { displayName: { contains: keyword, mode: "insensitive" } } },
      ];
    }
    const [total, items] = await Promise.all([
      prisma.communityPost.count({ where }),
      prisma.communityPost.findMany({
        where,
        include: {
          author: { select: { id: true, displayName: true, photoUrl: true } },
          assets: {
            orderBy: [{ ordinal: "asc" }],
            select: {
              id: true,
              ordinal: true,
              kind: true,
              width: true,
              height: true,
              aspectRatio: true,
              durationSeconds: true,
              transcodeStatus: true,
              transcodeProgressPercent: true,
              moderationStatus: true,
              transcodeQueueName: true,
              playbackQuotaBucket: true,
            },
          },
        },
        orderBy: [{ isPinned: "desc" }, { publishedAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      page,
      pageSize,
      items: items.map((item: any) => ({
        id: item.id,
        body: item.body,
        topics: item.topics || [],
        status: item.status,
        visibility: item.visibility,
        mediaCount: item.mediaCount,
        reactionCount: item.reactionCount,
        commentCount: item.commentCount,
        reportCount: item.reportCount,
        moderationReason: item.moderationReason || null,
        isPinned: !!item.isPinned,
        pinnedAt: item.pinnedAt ? item.pinnedAt.toISOString() : null,
        publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        author: item.author
          ? {
              id: item.author.id,
              displayName: item.author.displayName || "同频成员",
              photoUrl: item.author.photoUrl || null,
            }
          : null,
        assets: (item.assets || []).map(mapCommunityPostAsset),
      })),
    };
  });

  if (communityFeatureConfig.enabled) fastify.get<{ Params: { id: string } }>("/admin/community/posts/:id/audit-logs", { preHandler: [requireAdmin("ticket:view")] }, async (req, reply) => {
    const id = String(req.params.id || "").trim();
    if (!id) return reply.status(400).send({ error: "invalid_post_id" });
    return loadAuditEntries(prisma, "community_post", id);
  });

  if (communityFeatureConfig.enabled) fastify.post<{ Params: { id: string } }>("/admin/community/posts/:id/moderate", { preHandler: [requireAdmin("ticket:resolve")] }, async (req, reply) => {
    const parsed = moderateCommunityPostSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_community_post_moderation", details: parsed.error.issues });
    const before = await prisma.communityPost.findUnique({
      where: { id: req.params.id },
      include: {
        author: { select: { id: true, displayName: true } },
        assets: true,
      },
    });
    if (!before) return reply.status(404).send({ error: "community_post_not_found", message: "圈子帖子不存在。" });
    if (parsed.data.status === "published") {
      for (const asset of before.assets || []) {
        const prefixCheck = validateCommunityAssetPrefixes(before.id, asset);
        if (!prefixCheck.ok) {
          return reply.status(409).send(prefixCheck);
        }
        if (asset.moderationStatus !== "approved") {
          return reply.status(409).send({ error: "community_media_not_approved", message: "圈子媒体需先审核通过后才能发布帖子。" });
        }
        if (asset.kind === "video" && asset.transcodeStatus !== "ready") {
          return reply.status(409).send({ error: "community_video_not_ready", message: "圈子短视频尚未完成独立转码，不能发布。" });
        }
      }
    }
    const nextStatus = parsed.data.status;
    const after = await prisma.communityPost.update({
      where: { id: before.id },
      data: {
        status: nextStatus,
        moderationReason: parsed.data.reason || null,
        publishedAt: nextStatus === "published" ? (before.publishedAt || new Date()) : before.publishedAt,
        deletedAt: nextStatus === "removed" ? new Date() : null,
      },
      include: {
        author: { select: { id: true, displayName: true } },
        assets: true,
      },
    });
    await writeAudit(
      prisma,
      req,
      "community.post.moderate",
      "community_post",
      before.id,
      { status: before.status, isPinned: before.isPinned, moderationReason: before.moderationReason || null },
      { status: after.status, isPinned: after.isPinned, moderationReason: after.moderationReason || null },
      parsed.data.reason,
    );
    return {
      ok: true,
      post: {
        id: after.id,
        status: after.status,
        moderationReason: after.moderationReason || null,
        isPinned: !!after.isPinned,
        publishedAt: after.publishedAt ? after.publishedAt.toISOString() : null,
      },
    };
  });

  if (communityFeatureConfig.enabled) fastify.post<{ Params: { id: string } }>("/admin/community/posts/:id/pin", { preHandler: [requireAdmin("ticket:resolve")] }, async (req, reply) => {
    const parsed = pinCommunityPostSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_community_post_pin", details: parsed.error.issues });
    const before = await prisma.communityPost.findUnique({ where: { id: req.params.id } });
    if (!before) return reply.status(404).send({ error: "community_post_not_found", message: "圈子帖子不存在。" });
    const after = await prisma.communityPost.update({
      where: { id: before.id },
      data: {
        isPinned: parsed.data.pinned,
        pinnedAt: parsed.data.pinned ? new Date() : null,
      },
    });
    await writeAudit(
      prisma,
      req,
      parsed.data.pinned ? "community.post.pin" : "community.post.unpin",
      "community_post",
      before.id,
      { isPinned: before.isPinned, pinnedAt: before.pinnedAt ? before.pinnedAt.toISOString() : null },
      { isPinned: after.isPinned, pinnedAt: after.pinnedAt ? after.pinnedAt.toISOString() : null },
      parsed.data.reason,
    );
    return {
      ok: true,
      post: {
        id: after.id,
        isPinned: !!after.isPinned,
        pinnedAt: after.pinnedAt ? after.pinnedAt.toISOString() : null,
      },
    };
  });
}
