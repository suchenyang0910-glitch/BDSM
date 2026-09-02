import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin, type AdminSession } from "./admin.js";

const listReportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["open", "reviewing", "actioned", "dismissed"]).optional(),
  targetType: z.enum(["video_content", "article", "circle_post"]).optional(),
});

const listCommentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["pending", "approved", "hidden", "rejected", "deleted"]).default("pending"),
  targetType: z.enum(["video_content", "article", "circle_post"]).optional(),
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
  return { id: targetId, title: targetId, status: "unknown" };
}

export default async function adminInteractionRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.get("/admin/interactions/comments", { preHandler: [requireAdmin("ticket:view")] }, async (req) => {
    const parsed = listCommentsQuerySchema.parse(req.query || {});
    const { page, pageSize, status, targetType } = parsed;
    const where: any = { status };
    if (targetType) where.targetType = targetType;
    const [total, items] = await Promise.all([
      prisma.interactionComment.count({ where }),
      prisma.interactionComment.findMany({
        where,
        include: {
          user: { select: { id: true, displayName: true } },
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
        author: item.user
          ? {
              id: item.user.id,
              displayName: item.user.displayName || "同频成员",
            }
          : null,
        target: targetMap.get(`${item.targetType}:${item.targetId}`),
      })),
    };
  });

  fastify.get("/admin/interactions/reports", { preHandler: [requireAdmin("ticket:view")] }, async (req) => {
    const parsed = listReportsQuerySchema.parse(req.query || {});
    const { page, pageSize, status, targetType } = parsed;
    const where: any = {};
    if (status) where.status = status;
    if (targetType) where.targetType = targetType;
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
          select: { id: true, parentId: true, status: true },
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
    const after = await prisma.interactionComment.update({
      where: { id: before.id },
      data: {
        status: parsed.data.status,
        moderationReason: parsed.data.reason || null,
        moderatedBy: meta.adminId,
        moderatedAt: new Date(),
      },
      include: { user: { select: { id: true, displayName: true } } },
    });
    if (before.parentId && before.status !== after.status) {
      await prisma.$transaction(async (tx: any) => {
        await syncParentReplyCount(tx, after);
      });
    }
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
}
