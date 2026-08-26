import type { PlaybackDeliverySigner } from "./playbackDelivery.js";

import { randomUUID } from "node:crypto";

export type PlaybackRevokeReason =
  | "refund"
  | "entitlement_revoked"
  | "entitlement_expired"
  | "content_unpublished"
  | "user_suspended"
  | "manual_admin";

export type QueuePlaybackRevokeInput = {
  userId?: string | null;
  contentId?: string | null;
  entitlementId?: string | null;
  sourceOrderId?: string | null;
  requestedByAdminId?: string | null;
  reason: PlaybackRevokeReason;
};

type RawOutboxRow = {
  id: string;
  user_id: string | null;
  content_id: string | null;
  entitlement_id: string | null;
  source_order_id: string | null;
  requested_by_admin_id: string | null;
  reason: PlaybackRevokeReason;
  status: "queued" | "processing" | "applied" | "failed";
  attempt_count: number;
  last_error_class: string | null;
  available_at: Date;
  locked_at: Date | null;
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function mapOutboxRow(row: RawOutboxRow | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    contentId: row.content_id,
    entitlementId: row.entitlement_id,
    sourceOrderId: row.source_order_id,
    requestedByAdminId: row.requested_by_admin_id,
    reason: row.reason,
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorClass: row.last_error_class,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildSessionWhere(input: {
  userId?: string | null;
  contentId?: string | null;
  entitlementId?: string | null;
  createdAt: Date;
  now: Date;
}) {
  const where: any = {
    OR: [
      { status: "active", expiresAt: { gt: input.now } },
      { revokedAt: { gte: input.createdAt } },
    ],
  };
  if (input.userId) where.userId = input.userId;
  if (input.contentId) where.contentId = input.contentId;
  if (input.entitlementId) where.entitlementId = input.entitlementId;
  return where;
}

export async function queuePlaybackRevoke(tx: any, input: QueuePlaybackRevokeInput) {
  const id = randomUUID();
  const rows = (await tx.$queryRawUnsafe(
    `INSERT INTO "playback_revoke_outbox"
      ("id","user_id","content_id","entitlement_id","source_order_id","requested_by_admin_id","reason","status")
     VALUES ($1,$2,$3,$4,$5,$6,$7::"PlaybackRevokeReason",'queued')
     RETURNING *`,
    id,
    input.userId || null,
    input.contentId || null,
    input.entitlementId || null,
    input.sourceOrderId || null,
    input.requestedByAdminId || null,
    input.reason,
  )) as RawOutboxRow[];
  return mapOutboxRow(rows[0]);
}

export async function queuePlaybackRevokesForEntitlements(
  tx: any,
  input: {
    revokedEntitlements: Array<{ id: string; userId: string }>;
    sourceOrderId?: string | null;
    requestedByAdminId?: string | null;
    reason: PlaybackRevokeReason;
  },
) {
  const rows = [];
  for (const item of input.revokedEntitlements) {
    rows.push(
      await queuePlaybackRevoke(tx, {
        userId: item.userId,
        entitlementId: item.id,
        sourceOrderId: input.sourceOrderId || null,
        requestedByAdminId: input.requestedByAdminId || null,
        reason: input.reason,
      }),
    );
  }
  return rows;
}

export async function processPlaybackRevokeOutboxBatch(
  prisma: any,
  input: { signer?: PlaybackDeliverySigner | null; limit?: number; now?: Date } = {},
) {
  const limit = Math.max(1, Math.min(50, input.limit || 10));
  const now = input.now || new Date();
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const claimed = await claimNextPlaybackRevokeOutbox(prisma, now);
    if (!claimed) break;
    const result = await processClaimedPlaybackRevokeOutbox(prisma, claimed, {
      signer: input.signer || null,
      now,
    });
    if (result.ok) processed += 1;
    else failed += 1;
  }
  return { processed, failed };
}

export async function claimNextPlaybackRevokeOutbox(prisma: any, now = new Date()) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT *
       FROM "playback_revoke_outbox"
      WHERE "status" IN ('queued','failed')
        AND "available_at" <= $1
      ORDER BY "created_at" ASC
      LIMIT 1`,
    now,
  )) as RawOutboxRow[];
  const row = rows[0];
  if (!row) return null;
  const claimed = await prisma.$executeRawUnsafe(
    `UPDATE "playback_revoke_outbox"
        SET "status"='processing',
            "locked_at"=$2,
            "attempt_count"="attempt_count"+1,
            "updated_at"=CURRENT_TIMESTAMP
      WHERE "id"=$1
        AND "status" IN ('queued','failed')`,
    row.id,
    now,
  );
  if (claimed !== 1) return null;
  return mapOutboxRow(
    ((await prisma.$queryRawUnsafe(
      `SELECT * FROM "playback_revoke_outbox" WHERE "id"=$1 LIMIT 1`,
      row.id,
    )) as RawOutboxRow[])[0],
  );
}

export async function processClaimedPlaybackRevokeOutbox(
  prisma: any,
  outbox: any,
  input: { signer?: PlaybackDeliverySigner | null; now?: Date } = {},
) {
  const now = input.now || new Date();
  const sessionWhere = buildSessionWhere({
    userId: outbox.userId,
    contentId: outbox.contentId,
    entitlementId: outbox.entitlementId,
    createdAt: outbox.createdAt,
    now,
  });
  try {
    const targetSessions = await prisma.playbackSession.findMany({
      where: sessionWhere,
      select: {
        id: true,
        userId: true,
        contentId: true,
      },
    });
    const targetIds = targetSessions.map((row: any) => row.id);
    if (targetIds.length > 0) {
      await prisma.playbackSession.updateMany({
        where: {
          id: { in: targetIds },
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      });
      await prisma.playbackGrant.updateMany({
        where: {
          playbackSessionId: { in: targetIds },
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      });
      if (input.signer?.revoke) {
        for (const session of targetSessions) {
          await input.signer.revoke({
            sessionId: session.id,
            contentId: session.contentId,
          });
        }
      }
    }
    await prisma.$executeRawUnsafe(
      `UPDATE "playback_revoke_outbox"
          SET "status"='applied',
              "processed_at"=$2,
              "locked_at"=NULL,
              "last_error_class"=NULL,
              "updated_at"=CURRENT_TIMESTAMP
        WHERE "id"=$1`,
      outbox.id,
      now,
    );
    return { ok: true as const, affectedSessionCount: targetIds.length };
  } catch {
    await prisma.$executeRawUnsafe(
      `UPDATE "playback_revoke_outbox"
          SET "status"='failed',
              "locked_at"=NULL,
              "last_error_class"='external_revoke_failed',
              "available_at"=$2,
              "updated_at"=CURRENT_TIMESTAMP
        WHERE "id"=$1`,
      outbox.id,
      new Date(now.getTime() + 30_000),
    );
    return { ok: false as const, errorClass: "external_revoke_failed" };
  }
}
