import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { formatDuration } from "../utils/telegram.js";

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

const writeProgressSchema = z.object({
  eventName: z.enum(["start", "progress", "pause", "leave", "complete"]),
  positionSec: z.coerce.number().min(0).max(86_400),
  durationSec: z.coerce.number().min(0).max(86_400).optional().nullable(),
  quality: z.string().trim().max(32).optional().nullable(),
});

function requireUser(req: any, reply: any, done: any) {
  if (!req.userId) return reply.status(401).send({ error: "unauthorized", message: "未登录" });
  done();
}

function normalizeWholeSeconds(input: number | null | undefined): number | null {
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  return Math.max(0, Math.min(86_400, Math.floor(input)));
}

function shouldTreatProgressAsCompleted(positionSec: number, durationSec: number | null, eventName: string): boolean {
  if (eventName === "complete") return true;
  if (!durationSec || durationSec <= 0) return false;
  const safePosition = Math.max(0, Math.min(positionSec, durationSec));
  const remaining = Math.max(durationSec - safePosition, 0);
  return remaining < 30 || safePosition / durationSec >= 0.95;
}

function buildWatchProgressPayload(row: any) {
  const durationSeconds = normalizeWholeSeconds(row.durationSec ?? row.content?.durationSeconds) || 0;
  const positionSec = normalizeWholeSeconds(row.positionSec) || 0;
  const completed = !!row.completedAt;
  const resumePositionSec = completed ? 0 : positionSec;
  const progressPercent = durationSeconds > 0
    ? Math.max(0, Math.min(100, Math.round((Math.max(0, Math.min(positionSec, durationSeconds)) / durationSeconds) * 100)))
    : 0;

  return {
    contentId: row.contentId,
    title: row.content?.title || "未命名内容",
    coverUrl: row.content && (row.content.coverAsset || row.content.videoAssets?.[0])
      ? `/api/contents/${encodeURIComponent(row.contentId)}/cover`
      : null,
    accessType: row.content?.accessType || "public",
    durationSeconds: durationSeconds || null,
    duration: formatDuration(durationSeconds || undefined),
    positionSec,
    resumePositionSec,
    progressPercent,
    isFinished: completed,
    lastPlayedAt: row.lastPlayedAt ? row.lastPlayedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    publishedAt: row.content?.publishedAt ? row.content.publishedAt.toISOString() : null,
  };
}

function watchEventNameForClientEvent(eventName: z.infer<typeof writeProgressSchema>["eventName"]): string {
  switch (eventName) {
    case "start":
      return "watch_start";
    case "pause":
      return "watch_pause";
    case "leave":
      return "watch_leave";
    case "complete":
      return "watch_complete";
    default:
      return "watch_progress";
  }
}

export default async function watchProgressRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.get(
    "/user/watch-progress/history",
    { preHandler: [requireUser] },
    async (req, reply) => {
      const uid = (req as any).userId as string;
      const query = historyQuerySchema.parse(req.query as any);
      const skip = (query.page - 1) * query.pageSize;

      const where = {
        userId: uid,
        content: { status: "published" },
      };

      const [total, rows, recentRow] = await Promise.all([
        prisma.watchProgress.count({ where }),
        prisma.watchProgress.findMany({
          where,
          orderBy: [{ lastPlayedAt: "desc" }],
          skip,
          take: query.pageSize,
          include: {
            content: {
              select: {
                id: true,
                title: true,
                coverUrl: true,
                coverAsset: { select: { id: true } },
                videoAssets: { where: { kind: "cover", status: "verified", deletedAt: null }, take: 1, select: { id: true } },
                accessType: true,
                durationSeconds: true,
                publishedAt: true,
              },
            },
          },
        }),
        prisma.watchProgress.findFirst({
          where,
          orderBy: [{ lastPlayedAt: "desc" }],
          include: {
            content: {
              select: {
                id: true,
                title: true,
                coverUrl: true,
                coverAsset: { select: { id: true } },
                videoAssets: { where: { kind: "cover", status: "verified", deletedAt: null }, take: 1, select: { id: true } },
                accessType: true,
                durationSeconds: true,
                publishedAt: true,
              },
            },
          },
        }),
      ]);

      return reply.send({
        recent: recentRow ? buildWatchProgressPayload(recentRow) : null,
        items: rows.map((row: any) => buildWatchProgressPayload(row)),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      });
    },
  );

  fastify.post(
    "/contents/:id/watch-progress",
    { preHandler: [requireUser] },
    async (req, reply) => {
      const uid = (req as any).userId as string;
      const { id: contentId } = (req.params || {}) as { id: string };
      const body = writeProgressSchema.parse(req.body as any);

      const content = await prisma.content.findUnique({
        where: { id: contentId },
      select: { id: true, status: true, durationSeconds: true, title: true, coverUrl: true, accessType: true, publishedAt: true, coverAsset: { select: { id: true } }, videoAssets: { where: { kind: "cover", status: "verified", deletedAt: null }, take: 1, select: { id: true } } },
      });
      if (!content) {
        return reply.status(404).send({ error: "not_found", message: "内容不存在" });
      }
      if (content.status !== "published") {
        return reply.status(409).send({ error: "content_unavailable", message: "内容已下架或未上架" });
      }

      const durationSec = normalizeWholeSeconds(body.durationSec) ?? normalizeWholeSeconds(content.durationSeconds);
      const requestedPosition = normalizeWholeSeconds(body.positionSec) || 0;
      const cappedPosition = durationSec != null ? Math.min(requestedPosition, durationSec) : requestedPosition;
      const now = new Date();
      const completed = shouldTreatProgressAsCompleted(cappedPosition, durationSec, body.eventName);

      const row = await prisma.$transaction(async (tx: any) => {
        await tx.watchEvent.create({
          data: {
            userId: uid,
            contentId,
            eventName: watchEventNameForClientEvent(body.eventName),
            occurredAt: now,
            positionSec: cappedPosition,
            quality: body.quality || null,
          },
        });

        return tx.watchProgress.upsert({
          where: { userId_contentId: { userId: uid, contentId } },
          update: {
            positionSec: cappedPosition,
            durationSec: durationSec ?? undefined,
            lastPlayedAt: now,
            completedAt: completed ? now : null,
          },
          create: {
            userId: uid,
            contentId,
            positionSec: cappedPosition,
            durationSec: durationSec ?? undefined,
            lastPlayedAt: now,
            completedAt: completed ? now : null,
          },
          include: {
            content: {
              select: {
                id: true,
                title: true,
                coverUrl: true,
                coverAsset: { select: { id: true } },
                videoAssets: { where: { kind: "cover", status: "verified", deletedAt: null }, take: 1, select: { id: true } },
                accessType: true,
                durationSeconds: true,
                publishedAt: true,
              },
            },
          },
        });
      });

      return reply.send({
        ok: true,
        item: buildWatchProgressPayload(row),
      });
    },
  );

  fastify.delete(
    "/user/watch-progress/:contentId",
    { preHandler: [requireUser] },
    async (req, reply) => {
      const uid = (req as any).userId as string;
      const { contentId } = (req.params || {}) as { contentId: string };
      await prisma.watchProgress.deleteMany({ where: { userId: uid, contentId } });
      return reply.send({ ok: true });
    },
  );

  fastify.post(
    "/user/watch-progress/clear",
    { preHandler: [requireUser] },
    async (req, reply) => {
      const uid = (req as any).userId as string;
      const deleted = await prisma.watchProgress.deleteMany({ where: { userId: uid } });
      return reply.send({ ok: true, deleted: deleted.count });
    },
  );
}
