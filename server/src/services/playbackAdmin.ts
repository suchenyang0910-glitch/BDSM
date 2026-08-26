import { queuePlaybackRevoke } from "./playbackRevocation.js";

export async function revokePlaybackSessionsByUser(
  prisma: any,
  input: {
    userId: string;
    requestedByAdminId: string;
    reason: "user_suspended" | "manual_admin";
  },
) {
  return prisma.$transaction(async (tx: any) => {
    const outbox = await queuePlaybackRevoke(tx, {
      userId: input.userId,
      requestedByAdminId: input.requestedByAdminId,
      reason: input.reason,
    });
    const activeCount = await tx.playbackSession.count({
      where: {
        userId: input.userId,
        status: "active",
        revokedAt: null,
      },
    });
    return {
      outboxId: outbox?.id || "",
      activeCount,
    };
  });
}

export async function revokePlaybackSessionsByContent(
  prisma: any,
  input: {
    contentId: string;
    requestedByAdminId: string;
    reason: "content_unpublished" | "manual_admin";
  },
) {
  return prisma.$transaction(async (tx: any) => {
    const outbox = await queuePlaybackRevoke(tx, {
      contentId: input.contentId,
      requestedByAdminId: input.requestedByAdminId,
      reason: input.reason,
    });
    const activeCount = await tx.playbackSession.count({
      where: {
        contentId: input.contentId,
        status: "active",
        revokedAt: null,
      },
    });
    return {
      outboxId: outbox?.id || "",
      activeCount,
    };
  });
}
