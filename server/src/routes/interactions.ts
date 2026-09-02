import type { FastifyInstance } from "fastify";
import { z } from "zod";

const TARGET_TYPES = ["video_content", "article"] as const;
const COMMENT_PUBLIC_STATUS = ["approved"] as const;
const COMMENT_REPLY_TARGET_STATUS = ["approved"] as const;
const REPORT_REASON_CODES = ["spam", "abuse", "illegal", "sexual_violence", "other"] as const;
const COMMENT_DELETE_STATUS = ["approved", "pending", "hidden"] as const;

const targetQuerySchema = z.object({
  targetType: z.enum(TARGET_TYPES),
  targetId: z.string().trim().min(1).max(64),
});

const listCommentsQuerySchema = targetQuerySchema.extend({
  sort: z.enum(["hot", "new"]).default("hot"),
  cursor: z.string().trim().min(1).max(400).optional(),
  pageSize: z.coerce.number().int().min(1).max(30).default(20),
});

const createCommentSchema = z.object({
  targetType: z.enum(TARGET_TYPES),
  targetId: z.string().trim().min(1).max(64),
  parentId: z.string().trim().min(1).max(64).optional(),
  body: z.string().trim().min(2).max(500),
});

const toggleLikeSchema = z.object({
  targetType: z.enum(TARGET_TYPES),
  targetId: z.string().trim().min(1).max(64),
  subjectKind: z.enum(["target", "comment"]),
  commentId: z.string().trim().min(1).max(64).optional(),
});

const reportSchema = z.object({
  targetType: z.enum(TARGET_TYPES),
  targetId: z.string().trim().min(1).max(64),
  commentId: z.string().trim().min(1).max(64).optional(),
  reasonCode: z.enum(REPORT_REASON_CODES),
  detailText: z.string().trim().max(500).optional(),
});

const deleteCommentParamsSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

type CommentCursorPayload = {
  sort: "hot" | "new";
  id: string;
  createdAt: string;
  likeCount?: number;
  replyCount?: number;
};

function requireUser(req: any, reply: any, done: any) {
  if (!req.userId) return reply.status(401).send({ error: "unauthorized", message: "请先登录后再互动。" });
  done();
}

async function resolveVisibleTarget(prisma: any, targetType: (typeof TARGET_TYPES)[number], targetId: string) {
  if (targetType === "video_content") {
    const content = await prisma.content.findUnique({
      where: { id: targetId },
      select: { id: true, status: true, title: true, coverUrl: true, publishedAt: true },
    });
    if (!content || content.status !== "published") return null;
    return { id: content.id, title: content.title, subtitle: null, coverUrl: content.coverUrl || null, publishedAt: content.publishedAt };
  }
  const article = await prisma.article.findUnique({
    where: { id: targetId },
    select: { id: true, status: true, title: true, summary: true, coverImageUrl: true, publishedAt: true },
  });
  if (!article || article.status !== "published") return null;
  return { id: article.id, title: article.title, subtitle: article.summary || null, coverUrl: article.coverImageUrl || null, publishedAt: article.publishedAt };
}

async function requireVisibleTarget(prisma: any, targetType: (typeof TARGET_TYPES)[number], targetId: string, reply: any) {
  const target = await resolveVisibleTarget(prisma, targetType, targetId);
  if (!target) {
    reply.status(404).send({ error: "interaction_target_not_found", message: "互动目标不存在或未开放。" });
    return null;
  }
  return target;
}

async function requireVisibleComment(prisma: any, input: { id: string; targetType: (typeof TARGET_TYPES)[number]; targetId: string }) {
  return prisma.interactionComment.findFirst({
    where: {
      id: input.id,
      targetType: input.targetType,
      targetId: input.targetId,
      status: { in: COMMENT_REPLY_TARGET_STATUS as any },
    },
    include: { user: { select: { id: true, displayName: true, photoUrl: true } } },
  });
}

function serializeComment(row: any, viewerContext: { likedKeys: Set<string> }) {
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    parentId: row.parentId || null,
    rootId: row.rootId || null,
    body: row.body,
    likeCount: row.likeCount || 0,
    replyCount: row.replyCount || 0,
    status: row.status,
    createdAt: row.createdAt?.toISOString?.() || null,
    updatedAt: row.updatedAt?.toISOString?.() || null,
    author: row.user
      ? {
          id: row.user.id,
          displayName: row.user.displayName || "同频成员",
          photoUrl: row.user.photoUrl || null,
        }
      : null,
    likedByMe: viewerContext.likedKeys.has(`comment:${row.id}`),
    replies: Array.isArray(row.replies) ? row.replies.map((child: any) => serializeComment(child, viewerContext)) : [],
  };
}

function sortComments(items: any[], mode: "hot" | "new") {
  if (mode === "new") {
    return items.sort((a, b) => {
      const createdDelta = +new Date(b.createdAt) - +new Date(a.createdAt);
      if (createdDelta !== 0) return createdDelta;
      return String(b.id).localeCompare(String(a.id));
    });
  }
  return items.sort((a, b) => {
    if ((b.likeCount || 0) !== (a.likeCount || 0)) return (b.likeCount || 0) - (a.likeCount || 0);
    if ((b.replyCount || 0) !== (a.replyCount || 0)) return (b.replyCount || 0) - (a.replyCount || 0);
    const createdDelta = +new Date(b.createdAt) - +new Date(a.createdAt);
    if (createdDelta !== 0) return createdDelta;
    return String(b.id).localeCompare(String(a.id));
  });
}

function encodeCommentCursor(payload: CommentCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCommentCursor(input: string | undefined, expectedSort: "hot" | "new"): CommentCursorPayload | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as CommentCursorPayload;
    if (!parsed || parsed.sort !== expectedSort || !parsed.id || !parsed.createdAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isRowAfterCursor(row: any, cursor: CommentCursorPayload | null, sort: "hot" | "new"): boolean {
  if (!cursor) return true;
  const rowCreatedAt = new Date(row.createdAt).toISOString();
  if (sort === "new") {
    if (rowCreatedAt !== cursor.createdAt) return rowCreatedAt < cursor.createdAt;
    return String(row.id) < String(cursor.id);
  }
  const rowLikeCount = Number(row.likeCount || 0);
  const rowReplyCount = Number(row.replyCount || 0);
  const cursorLikeCount = Number(cursor.likeCount || 0);
  const cursorReplyCount = Number(cursor.replyCount || 0);
  if (rowLikeCount !== cursorLikeCount) return rowLikeCount < cursorLikeCount;
  if (rowReplyCount !== cursorReplyCount) return rowReplyCount < cursorReplyCount;
  if (rowCreatedAt !== cursor.createdAt) return rowCreatedAt < cursor.createdAt;
  return String(row.id) < String(cursor.id);
}

function buildNextCommentCursor(rows: any[], sort: "hot" | "new"): string | null {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return encodeCommentCursor({
    sort,
    id: String(last.id),
    createdAt: new Date(last.createdAt).toISOString(),
    likeCount: Number(last.likeCount || 0),
    replyCount: Number(last.replyCount || 0),
  });
}

async function loadViewerLikedKeys(prisma: any, userId: string | null, rows: any[]): Promise<Set<string>> {
  if (!userId) return new Set<string>();
  const commentIds = rows.flatMap((row) => [row.id].concat((row.replies || []).map((reply: any) => reply.id)));
  const likes = await prisma.interactionLike.findMany({
    where: {
      userId,
      OR: [
        { subjectKind: "target", targetType: rows[0]?.targetType || "video_content", targetId: rows[0]?.targetId || "" },
        commentIds.length > 0 ? { subjectKind: "comment", commentId: { in: commentIds } } : undefined,
      ].filter(Boolean),
    },
    select: { subjectKey: true },
  });
  return new Set(likes.map((item: any) => item.subjectKey));
}

async function assertCommentRateLimit(prisma: any, userId: string) {
  const windowStart = new Date(Date.now() - 10 * 60 * 1000);
  const recentCount = await prisma.interactionComment.count({
    where: { userId, createdAt: { gte: windowStart } },
  });
  if (recentCount >= 10) {
    throw Object.assign(new Error("comment_rate_limited"), {
      statusCode: 429,
      payload: { error: "interaction_rate_limited", message: "发言过于频繁，请稍后再试。" },
    });
  }
}

async function assertReportRateLimit(prisma: any, userId: string) {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000);
  const recentCount = await prisma.interactionReport.count({
    where: { reporterUserId: userId, createdAt: { gte: windowStart } },
  });
  if (recentCount >= 5) {
    throw Object.assign(new Error("report_rate_limited"), {
      statusCode: 429,
      payload: { error: "interaction_rate_limited", message: "举报过于频繁，请稍后再试。" },
    });
  }
}

function isHandledInteractionError(error: any): boolean {
  return !!error && typeof error === "object" && typeof error.statusCode === "number" && !!error.payload;
}

async function shouldAutoPublishComment(prisma: any, userId: string): Promise<boolean> {
  const approvedCount = await prisma.interactionComment.count({
    where: { userId, status: "approved" },
  });
  return approvedCount >= 1;
}

function buildCommentListWhere(input: {
  targetType: (typeof TARGET_TYPES)[number];
  targetId: string;
  cursor: CommentCursorPayload | null;
  sort: "hot" | "new";
}) {
  const baseWhere: Record<string, unknown> = {
    targetType: input.targetType,
    targetId: input.targetId,
    parentId: null,
    status: "approved",
  };
  if (!input.cursor) return baseWhere;

  const cursorCreatedAt = new Date(input.cursor.createdAt);
  if (Number.isNaN(cursorCreatedAt.getTime())) return baseWhere;

  if (input.sort === "new") {
    return {
      ...baseWhere,
      OR: [
        { createdAt: { lt: cursorCreatedAt } },
        {
          AND: [
            { createdAt: cursorCreatedAt },
            { id: { lt: input.cursor.id } },
          ],
        },
      ],
    };
  }

  const cursorLikeCount = Number(input.cursor.likeCount || 0);
  const cursorReplyCount = Number(input.cursor.replyCount || 0);
  return {
    ...baseWhere,
    OR: [
      { likeCount: { lt: cursorLikeCount } },
      {
        AND: [
          { likeCount: cursorLikeCount },
          { replyCount: { lt: cursorReplyCount } },
        ],
      },
      {
        AND: [
          { likeCount: cursorLikeCount },
          { replyCount: cursorReplyCount },
          { createdAt: { lt: cursorCreatedAt } },
        ],
      },
      {
        AND: [
          { likeCount: cursorLikeCount },
          { replyCount: cursorReplyCount },
          { createdAt: cursorCreatedAt },
          { id: { lt: input.cursor.id } },
        ],
      },
    ],
  };
}

function buildCommentOrderBy(sort: "hot" | "new") {
  if (sort === "new") {
    return [{ createdAt: "desc" }, { id: "desc" }] as const;
  }
  return [
    { likeCount: "desc" },
    { replyCount: "desc" },
    { createdAt: "desc" },
    { id: "desc" },
  ] as const;
}

function buildCommentDeleteScope(comment: any) {
  if (!comment.parentId) {
    return { rootId: comment.id };
  }
  return { rootId: comment.rootId || comment.parentId, commentId: comment.id };
}

export default async function interactionRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.get("/interactions/summary", async (req, reply) => {
    const parsed = targetQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_interaction_target", details: parsed.error.issues });
    const { targetType, targetId } = parsed.data;
    const target = await requireVisibleTarget(prisma, targetType, targetId, reply);
    if (!target) return;
    const userId = (req as any).userId as string | null;
    const [commentCount, likeCount, likedByMe] = await Promise.all([
      prisma.interactionComment.count({ where: { targetType, targetId, status: "approved" } }),
      prisma.interactionLike.count({ where: { subjectKind: "target", targetType, targetId } }),
      userId
        ? prisma.interactionLike.count({ where: { userId, subjectKind: "target", targetType, targetId } }).then((count: number) => count > 0)
        : Promise.resolve(false),
    ]);
    return {
      target,
      summary: { commentCount, likeCount, likedByMe },
    };
  });

  fastify.get("/interactions/comments", async (req, reply) => {
    const parsed = listCommentsQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_comment_query", details: parsed.error.issues });
    const { targetType, targetId, sort, cursor: rawCursor, pageSize } = parsed.data;
    const target = await requireVisibleTarget(prisma, targetType, targetId, reply);
    if (!target) return;
    const cursor = decodeCommentCursor(rawCursor, sort);
    if (rawCursor && !cursor) {
      return reply.status(400).send({ error: "invalid_comment_cursor", message: "评论分页游标无效或已过期。" });
    }

    const [total, topLevel] = await Promise.all([
      prisma.interactionComment.count({ where: { targetType, targetId, parentId: null, status: "approved" } }),
      prisma.interactionComment.findMany({
        where: buildCommentListWhere({ targetType, targetId, cursor, sort }),
        include: {
          user: { select: { id: true, displayName: true, photoUrl: true } },
          replies: {
            where: { status: "approved" },
            include: { user: { select: { id: true, displayName: true, photoUrl: true } } },
            orderBy: [{ createdAt: "asc" }],
            take: 3,
          },
        },
        orderBy: buildCommentOrderBy(sort) as any,
        take: pageSize + 1,
      }),
    ]);

    const hasMore = topLevel.length > pageSize;
    const pageRows = topLevel.slice(0, pageSize);
    const likedKeys = await loadViewerLikedKeys(prisma, ((req as any).userId as string | null) || null, pageRows);
    return {
      target,
      pageSize,
      total,
      cursor: rawCursor || null,
      nextCursor: hasMore ? buildNextCommentCursor(pageRows, sort) : null,
      items: pageRows.map((row: any) => serializeComment(row, { likedKeys })),
    };
  });

  fastify.post("/interactions/comments", { preHandler: [requireUser] }, async (req, reply) => {
    const parsed = createCommentSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_comment_input", details: parsed.error.issues });
    const { targetType, targetId, parentId, body } = parsed.data;
    const userId = (req as any).userId as string;
    const target = await requireVisibleTarget(prisma, targetType, targetId, reply);
    if (!target) return;

    try {
      await assertCommentRateLimit(prisma, userId);
    } catch (error: any) {
      if (isHandledInteractionError(error)) return reply.status(error.statusCode).send(error.payload);
      throw error;
    }

    let parent: any = null;
    if (parentId) {
      parent = await requireVisibleComment(prisma, { id: parentId, targetType, targetId });
      if (!parent) {
        return reply.status(404).send({ error: "parent_comment_not_found", message: "回复目标不存在或已不可见。" });
      }
      if (parent.parentId) {
        return reply.status(409).send({ error: "reply_depth_exceeded", message: "当前仅支持回复一级评论，不支持三级及以上嵌套。" });
      }
    }
    const status = await shouldAutoPublishComment(prisma, userId) ? "approved" : "pending";

    const created = await prisma.$transaction(async (tx: any) => {
      const row = await tx.interactionComment.create({
        data: {
          targetType,
          targetId,
          userId,
          parentId: parent ? parent.id : null,
          rootId: parent ? (parent.rootId || parent.id) : null,
          body,
          status,
        },
        include: { user: { select: { id: true, displayName: true, photoUrl: true } } },
      });
      if (parent && status === "approved") {
        await tx.interactionComment.update({
          where: { id: parent.id },
          data: { replyCount: { increment: 1 } },
        });
      }
      return row;
    });

    return reply.status(201).send({
      ok: true,
      comment: serializeComment(created, { likedKeys: new Set() }),
    });
  });

  fastify.post("/interactions/likes/toggle", { preHandler: [requireUser] }, async (req, reply) => {
    const parsed = toggleLikeSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_like_input", details: parsed.error.issues });
    const { targetType, targetId, subjectKind, commentId } = parsed.data;
    const userId = (req as any).userId as string;
    const target = await requireVisibleTarget(prisma, targetType, targetId, reply);
    if (!target) return;
    if (subjectKind === "comment" && !commentId) {
      return reply.status(400).send({ error: "comment_id_required", message: "评论点赞必须携带 commentId。" });
    }
    let comment: any = null;
    if (subjectKind === "comment") {
      comment = await requireVisibleComment(prisma, { id: commentId as string, targetType, targetId });
      if (!comment) return reply.status(404).send({ error: "comment_not_found", message: "评论不存在或已不可见。" });
    }
    const subjectKey = subjectKind === "comment" ? `comment:${commentId}` : `target:${targetType}:${targetId}`;
    const toggled = await prisma.$transaction(async (tx: any) => {
      const existing = await tx.interactionLike.findUnique({ where: { userId_subjectKey: { userId, subjectKey } } });
      if (existing) {
        await tx.interactionLike.delete({ where: { id: existing.id } });
        if (subjectKind === "comment") {
          await tx.interactionComment.update({
            where: { id: commentId as string },
            data: { likeCount: { decrement: 1 } },
          });
        }
        return { liked: false };
      }
      try {
        await tx.interactionLike.create({
          data: { userId, subjectKind, subjectKey, targetType, targetId, commentId: subjectKind === "comment" ? commentId : null },
        });
      } catch (error: any) {
        if (error?.code === "P2002") {
          return { liked: true };
        }
        throw error;
      }
      if (subjectKind === "comment") {
        await tx.interactionComment.update({
          where: { id: commentId as string },
          data: { likeCount: { increment: 1 } },
        });
      }
      return { liked: true };
    });

    const likeCount = subjectKind === "comment"
      ? await prisma.interactionComment.findUnique({ where: { id: commentId as string }, select: { likeCount: true } }).then((row: any) => row?.likeCount || 0)
      : await prisma.interactionLike.count({ where: { subjectKind: "target", targetType, targetId } });

    return { ok: true, liked: toggled.liked, likeCount };
  });

  fastify.post("/interactions/reports", { preHandler: [requireUser] }, async (req, reply) => {
    const parsed = reportSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_report_input", details: parsed.error.issues });
    const { targetType, targetId, commentId, reasonCode, detailText } = parsed.data;
    const userId = (req as any).userId as string;
    const target = await requireVisibleTarget(prisma, targetType, targetId, reply);
    if (!target) return;
    if (commentId) {
      const comment = await requireVisibleComment(prisma, { id: commentId, targetType, targetId });
      if (!comment) return reply.status(404).send({ error: "comment_not_found", message: "举报目标评论不存在或已不可见。" });
    }
    try {
      await assertReportRateLimit(prisma, userId);
    } catch (error: any) {
      if (isHandledInteractionError(error)) return reply.status(error.statusCode).send(error.payload);
      throw error;
    }
    const existing = await prisma.interactionReport.findFirst({
      where: {
        reporterUserId: userId,
        targetType,
        targetId,
        commentId: commentId || null,
        status: { in: ["open", "reviewing"] },
      },
      select: { id: true },
    });
    if (existing) {
      return reply.status(409).send({ error: "duplicate_report_open", message: "你已经举报过这条内容，管理员正在处理中。" });
    }
    let report;
    try {
      report = await prisma.interactionReport.create({
        data: {
          reporterUserId: userId,
          targetType,
          targetId,
          commentId: commentId || null,
          reasonCode,
          detailText: detailText || null,
        },
      });
    } catch (error: any) {
      if (error?.code === "P2002") {
        return reply.status(409).send({ error: "duplicate_report_open", message: "你已经举报过这条内容，管理员正在处理中。" });
      }
      throw error;
    }
    return reply.status(201).send({
      ok: true,
      report: {
        id: report.id,
        status: report.status,
        reasonCode: report.reasonCode,
        createdAt: report.createdAt.toISOString(),
      },
    });
  });

  fastify.delete<{ Params: { id: string } }>("/interactions/comments/:id", { preHandler: [requireUser] }, async (req, reply) => {
    const parsed = deleteCommentParamsSchema.safeParse(req.params || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_comment_delete", details: parsed.error.issues });
    const userId = (req as any).userId as string;
    const before = await prisma.interactionComment.findUnique({
      where: { id: parsed.data.id },
      include: {
        replies: { select: { id: true, status: true } },
      },
    });
    if (!before || !COMMENT_DELETE_STATUS.includes(before.status as any)) {
      return reply.status(404).send({ error: "comment_not_found", message: "评论不存在或已删除。" });
    }
    if (before.userId !== userId) {
      return reply.status(403).send({ error: "forbidden", message: "只能删除自己的评论。" });
    }
    const now = new Date();
    const scope = buildCommentDeleteScope(before);
    await prisma.$transaction(async (tx: any) => {
      await tx.interactionComment.update({
        where: { id: before.id },
        data: {
          status: "deleted",
          deletedAt: now,
          moderationReason: before.moderationReason || "self_deleted",
        },
      });
      if (!before.parentId) {
        const visibleReplyIds = before.replies.filter((item: any) => item.status === "approved" || item.status === "pending").map((item: any) => item.id);
        if (visibleReplyIds.length > 0) {
          await tx.interactionComment.updateMany({
            where: { id: { in: visibleReplyIds } },
            data: {
              status: "deleted",
              deletedAt: now,
              moderationReason: "root_comment_deleted_by_author",
            },
          });
        }
        await tx.interactionComment.update({
          where: { id: before.id },
          data: { replyCount: 0 },
        });
      } else if (scope.rootId) {
        const remainingReplies = await tx.interactionComment.count({
          where: {
            rootId: scope.rootId,
            parentId: before.parentId,
            status: "approved",
          },
        });
        await tx.interactionComment.update({
          where: { id: before.parentId },
          data: { replyCount: remainingReplies },
        });
      }
    });
    return { ok: true, deletedCommentId: before.id };
  });
}
