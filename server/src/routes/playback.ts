import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createPlaybackDeliverySigner } from "../services/playbackDelivery.js";
import type { PlaybackConfig } from "../services/playbackConfig.js";
import {
  applyPlaybackProgress,
  derivePlaybackDeviceHash,
  enforcePlaybackDeviceLimit,
  getPlaybackStatusSummary,
  resolvePlaybackCreateAccess,
} from "../services/playbackSessions.js";
import { processPlaybackRevokeOutboxBatch } from "../services/playbackRevocation.js";

const heartbeatSchema = z.object({
  eventName: z.enum(["start", "progress", "pause", "complete"]).default("progress"),
  positionSec: z.coerce.number().min(0).max(86_400),
  durationSec: z.coerce.number().min(0).max(86_400).optional().nullable(),
  quality: z.string().trim().max(32).optional().nullable(),
});

const sessionCreateSchema = z.object({
  purpose: z.enum(["play", "prefetch"]).optional().default("play"),
});

const legacyHeartbeatSchema = z.object({
  eventName: z.enum(["progress", "pause", "complete"]).default("progress"),
  positionSec: z.coerce.number().min(0).max(86_400),
  durationSec: z.coerce.number().min(0).max(86_400).optional().nullable(),
  quality: z.string().trim().max(32).optional().nullable(),
});

const endSchema = z.object({
  eventName: z.enum(["leave", "complete"]).default("leave"),
  positionSec: z.coerce.number().min(0).max(86_400).optional().default(0),
  durationSec: z.coerce.number().min(0).max(86_400).optional().nullable(),
  quality: z.string().trim().max(32).optional().nullable(),
});

function requireUser(req: any, reply: any, done: any) {
  if (!req.userId) return reply.status(401).send({ error: "unauthorized", message: "未登录" });
  done();
}

function errorHttpStatus(error: string) {
  switch (error) {
    case "unauthorized":
      return 401;
    case "user_suspended":
    case "content_not_found":
      return 404;
    case "content_not_published":
    case "entitlement_required":
    case "entitlement_expired":
      return 403;
    case "video_delivery_not_configured":
      return 503;
    default:
      return 409;
  }
}

async function writePlaybackProgress(input: {
  prisma: any;
  userId: string;
  contentId: string;
  sessionId: string;
  eventName: "playback_start" | "playback_progress" | "playback_pause" | "playback_complete" | "playback_leave";
  occurredAt: Date;
  positionSec: number;
  durationSec: number | null;
  quality: string | null;
  completed: boolean;
}) {
  await input.prisma.$transaction(async (tx: any) => {
    await tx.watchEvent.create({
      data: {
        userId: input.userId,
        contentId: input.contentId,
        sessionId: input.sessionId,
        source: "platform_playback",
        eventName: input.eventName,
        occurredAt: input.occurredAt,
        positionSec: input.positionSec,
        quality: input.quality,
      },
    });
    await tx.watchProgress.upsert({
      where: { userId_contentId: { userId: input.userId, contentId: input.contentId } },
      update: {
        positionSec: input.positionSec,
        durationSec: input.durationSec ?? undefined,
        lastPlayedAt: input.occurredAt,
        completedAt: input.completed ? input.occurredAt : null,
      },
      create: {
        userId: input.userId,
        contentId: input.contentId,
        positionSec: input.positionSec,
        durationSec: input.durationSec ?? undefined,
        lastPlayedAt: input.occurredAt,
        completedAt: input.completed ? input.occurredAt : null,
      },
    });
  });
}

export default async function playbackRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;
  const playbackConfig = (fastify as any).playbackConfig as PlaybackConfig;
  const signingKey = String(process.env.VIDEO_CDN_SIGNING_KEY || "");
  const signer = createPlaybackDeliverySigner({
    cdnBaseUrl: playbackConfig.cdnBaseUrl || "https://video.invalid",
    signingMode: playbackConfig.signingMode || "signed_cookie",
    sessionTtlSeconds: playbackConfig.sessionTtlSeconds,
    signingKey,
  });

  fastify.get("/contents/:contentId/playback-status", async (req, reply) => {
    const { contentId } = (req.params || {}) as { contentId: string };
    const summary = await getPlaybackStatusSummary(prisma, playbackConfig, {
      contentId,
      userId: (req as any).userId,
    });
    return reply.status(summary.httpStatus).send(summary.body);
  });

  fastify.post("/contents/:contentId/playback-session", { preHandler: [requireUser] }, async (req, reply) => {
    await processPlaybackRevokeOutboxBatch(prisma, { signer, limit: 20 });
    const { contentId } = (req.params || {}) as { contentId: string };
    const userId = (req as any).userId as string;
    const body = sessionCreateSchema.parse(req.body || {});
    const access = await resolvePlaybackCreateAccess(prisma, playbackConfig, { contentId, userId });
    if (!access.ok) {
      return reply.status(errorHttpStatus(access.error)).send({ error: access.error });
    }
    if (body.purpose === "prefetch" && access.deliveryVariant !== "preview") {
      return reply.status(409).send({ error: "prefetch_not_allowed" });
    }

    const deviceHash = derivePlaybackDeviceHash({
      userId,
      userAgent: req.headers["user-agent"] as string | undefined,
      acceptLanguage: req.headers["accept-language"] as string | undefined,
      platform: req.headers["sec-ch-ua-platform"] as string | undefined,
      signingKey,
    });
    const deviceLimit = await enforcePlaybackDeviceLimit(prisma, {
      userId,
      currentDeviceHash: deviceHash,
      maxActiveDevices: playbackConfig.maxActiveDevices,
    });
    if (!deviceLimit.ok) {
      return reply.status(409).send({ error: deviceLimit.error });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + playbackConfig.sessionTtlSeconds * 1000);
    const reused = await prisma.playbackSession.findFirst({
      where: {
        userId,
        contentId,
        deviceHash,
        status: "active",
        expiresAt: { gt: now },
      },
      orderBy: [{ updatedAt: "desc" }],
    });

    const session = reused
      ? await prisma.playbackSession.update({
          where: { id: reused.id },
          data: {
            expiresAt,
            lastHeartbeatAt: now,
            entitlementId: access.entitlementId,
          },
        })
      : await prisma.playbackSession.create({
          data: {
            userId,
            contentId,
            entitlementId: access.entitlementId,
            status: "active",
            deliveryMode: playbackConfig.mode === "enabled" ? "enabled" : "poc",
            deviceHash,
            expiresAt,
            lastHeartbeatAt: now,
          },
        });

    await prisma.playbackGrant.updateMany({
      where: {
        playbackSessionId: session.id,
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });
    const issued = await signer.issue({
      sessionId: session.id,
      contentId,
      expiresAt,
      variant: access.deliveryVariant,
    });
    await prisma.playbackGrant.create({
      data: {
        playbackSessionId: session.id,
        contentId,
        tokenFingerprint: issued.tokenFingerprint,
        scopePath: issued.scopePath,
        expiresAt,
      },
    });
    reply.header("set-cookie", issued.responseHeaders["set-cookie"]);
    if (body.purpose !== "prefetch") {
      await writePlaybackProgress({
        prisma,
        userId,
        contentId,
        sessionId: session.id,
        eventName: "playback_start",
        occurredAt: now,
        positionSec: 0,
        durationSec: access.content.durationSeconds ?? null,
        quality: null,
        completed: false,
      });
    }
    return reply.send({
      ok: true,
      sessionId: session.id,
      expiresAt: expiresAt.toISOString(),
      heartbeatIntervalSeconds: playbackConfig.heartbeatIntervalSeconds,
      deliveryVariant: access.deliveryVariant,
      purpose: body.purpose,
      manifestUrl: issued.manifestUrl,
    });
  });

  fastify.post("/playback-sessions/:sessionId/heartbeat", { preHandler: [requireUser] }, async (req, reply) => {
    await processPlaybackRevokeOutboxBatch(prisma, { signer, limit: 20 });
    const userId = (req as any).userId as string;
    const { sessionId } = (req.params || {}) as { sessionId: string };
    const body = heartbeatSchema.safeParse(req.body as any).success
      ? heartbeatSchema.parse(req.body as any)
      : legacyHeartbeatSchema.parse(req.body as any);
    const session = await prisma.playbackSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.userId !== userId) {
      return reply.status(404).send({ error: "not_found" });
    }
    if (session.revokedAt || session.status !== "active" || session.expiresAt.getTime() <= Date.now()) {
      await prisma.playbackSession.updateMany({
        where: { id: sessionId, status: "active" },
        data: { status: "expired", revokedAt: new Date() },
      });
      return reply.status(409).send({ error: "playback_session_inactive" });
    }

    const normalized = applyPlaybackProgress({
      positionSec: body.positionSec,
      durationSec: body.durationSec ?? null,
      eventName: body.eventName === "start" ? "progress" : body.eventName,
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + playbackConfig.sessionTtlSeconds * 1000);
    await prisma.playbackSession.update({
      where: { id: sessionId },
      data: {
        lastHeartbeatAt: now,
        expiresAt,
      },
    });
    await writePlaybackProgress({
      prisma,
      userId,
      contentId: session.contentId,
      sessionId: session.id,
      eventName:
        body.eventName === "start"
          ? "playback_start"
          : body.eventName === "pause"
            ? "playback_pause"
            : body.eventName === "complete"
              ? "playback_complete"
              : "playback_progress",
      occurredAt: now,
      positionSec: normalized.positionSec,
      durationSec: normalized.durationSec,
      quality: body.quality || null,
      completed: normalized.completed,
    });
    return reply.send({
      ok: true,
      sessionId: session.id,
      expiresAt: expiresAt.toISOString(),
      completed: normalized.completed,
    });
  });

  fastify.post("/playback-sessions/:sessionId/end", { preHandler: [requireUser] }, async (req, reply) => {
    const userId = (req as any).userId as string;
    const { sessionId } = (req.params || {}) as { sessionId: string };
    const body = endSchema.parse(req.body as any);
    const session = await prisma.playbackSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.userId !== userId) {
      return reply.status(404).send({ error: "not_found" });
    }
    const normalized = applyPlaybackProgress({
      positionSec: body.positionSec,
      durationSec: body.durationSec ?? null,
      eventName: body.eventName,
    });
    const now = new Date();
    await prisma.$transaction(async (tx: any) => {
      await tx.playbackSession.update({
        where: { id: sessionId },
        data: {
          status: "expired",
          expiresAt: now,
          revokedAt: now,
          lastHeartbeatAt: now,
        },
      });
      await tx.playbackGrant.updateMany({
        where: {
          playbackSessionId: sessionId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      });
    });
    await writePlaybackProgress({
      prisma,
      userId,
      contentId: session.contentId,
      sessionId: session.id,
      eventName: body.eventName === "complete" ? "playback_complete" : "playback_leave",
      occurredAt: now,
      positionSec: normalized.positionSec,
      durationSec: normalized.durationSec,
      quality: body.quality || null,
      completed: normalized.completed,
    });
    return reply.send({ ok: true });
  });
}
