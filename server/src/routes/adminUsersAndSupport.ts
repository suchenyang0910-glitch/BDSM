import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireAdmin } from "./admin.js";
import {
  createChannelInvite,
  sendDirectMessage,
  maskChatIdSafe,
  chatIdFingerprint,
  TELEGRAM_CONFIG,
} from "../services/telegramBot.js";
import { resolveMembershipChannelRef } from "../services/membershipChannel.js";
import { processEntitlementGraceCleanup } from "../services/entitlementsCron.js";
import { revokePlaybackSessionsByUser } from "../services/playbackAdmin.js";
import type { ResourceType } from "@prisma/client";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

const RESOURCE_TYPE_SET: readonly ResourceType[] = ["content", "package", "membership_channel"] as const;

const listEntitlementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["active", "revoked", "expired"]).optional(),
  resourceType: z.enum(["content", "package", "membership_channel"]).optional(),
  removalStatus: z.enum(["none", "grace_period", "removed", "removal_failed", "renewed_during_grace"]).optional(),
  userId: z.string().min(1).optional(),
  telegramUserId: z.coerce.bigint().optional(),
  orderNo: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
});

const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().min(1).optional(),
  telegramUserId: z.coerce.bigint().optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  telegramBound: z.coerce.boolean().optional(),
  hasActiveEntitlement: z.coerce.boolean().optional(),
});

const grantEntitlementSchema = z.object({
  userId: z.string().min(1, { message: "userId 必填" }),
  resourceType: z.enum(["content", "package", "membership_channel"]),
  resourceId: z.string().min(1, { message: "resourceId 必填" }),
  reason: z.string().min(2, { message: "发放说明至少 2 个字符" }).max(1000),
  durationDays: z.coerce.number().int().min(1).max(3650).optional(),
  sourceOrderId: z.string().min(1).optional(),
  ticketId: z.string().min(1).optional(),
});

const resendInviteSchema = z.object({
  reason: z.string().min(2).max(1000),
  ttlSeconds: z.coerce.number().int().min(60).max(86400 * 30).optional(),
  memberLimit: z.coerce.number().int().min(1).max(99999).optional(),
});

const retryRemovalSchema = z.object({
  reason: z.string().min(2).max(1000),
});

const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  category: z.enum(["payment", "entitlement", "access", "refund", "other"]).optional(),
  assignedToId: z.string().min(1).optional(),
  unassignedOnly: z.coerce.boolean().optional(),
  mine: z.coerce.boolean().optional(),
  userId: z.string().min(1).optional(),
  telegramUserId: z.coerce.bigint().optional(),
  orderNo: z.string().min(1).optional(),
  entitlementId: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
});

const createTicketAdminSchema = z.object({
  userId: z.string().min(1),
  title: z.string().min(2).max(200),
  category: z.enum(["payment", "entitlement", "access", "refund", "other"]),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  description: z.string().max(5000).optional(),
  orderId: z.string().optional(),
  entitlementId: z.string().optional(),
  telegramUserId: z.coerce.bigint().optional(),
  initialNotePublic: z.string().max(5000).optional(),
});

const ticketActionSchema = z.object({
  reason: z.string().min(2).max(1000).optional(),
});

const noteSchema = z.object({
  note: z.string().min(1).max(5000),
  isPublic: z.boolean().default(false),
  actionRef: z.string().optional(),
});

const revokePlaybackSessionsSchema = z.object({
  reason: z.string().min(2).max(1000),
});

const setCommunityVideoCreatorSchema = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(2).max(500),
});

function entitlementRow(e: any) {
  return {
    id: e.id,
    userId: e.userId,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    status: e.status,
    startsAt: e.startsAt.toISOString(),
    expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
    graceEndsAt: e.graceEndsAt ? e.graceEndsAt.toISOString() : null,
    expiryReminderAt: e.expiryReminderAt ? e.expiryReminderAt.toISOString() : null,
    preGraceReminderAt: e.preGraceReminderAt ? e.preGraceReminderAt.toISOString() : null,
    expiryReminderCount: e.expiryReminderCount ?? 0,
    removalStatus: e.removalStatus ?? "none",
    removalAttemptedAt: e.removalAttemptedAt ? e.removalAttemptedAt.toISOString() : null,
    removedAt: e.removedAt ? e.removedAt.toISOString() : null,
    lastRemovalErrorCode: e.lastRemovalErrorCode ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    sourceOrder: e.sourceOrder
      ? {
          id: e.sourceOrder.id,
          orderNo: e.sourceOrder.orderNo,
          status: e.sourceOrder.status,
          amountMinor: e.sourceOrder.amountMinor?.toString() ?? null,
        }
      : null,
    user: e.user
      ? {
          id: e.user.id,
          displayName: e.user.displayName,
          username: e.user.username ?? null,
          telegramUserId: e.user.telegramUserId ? e.user.telegramUserId.toString() : null,
          status: e.user.status,
        }
      : null,
    resourceMeta: e.resourceMeta || null,
    // 【Security Boundary - 细节3】inviteLink 永不通过 JSON API 返回。
    // 邀请链接仅通过两种方式发放：1) Telegram 受控 Bot 私信；2) 服务端一次性 302 跳转。
    channelInvite:
      e.telegramInvites && e.telegramInvites.length > 0
        ? {
            id: e.telegramInvites[0].id,
            // inviteLink: 故意移除，永不返回明文链接
            expiresAt: e.telegramInvites[0].expiresAt ? e.telegramInvites[0].expiresAt.toISOString() : null,
            usedAt: e.telegramInvites[0].usedAt ? e.telegramInvites[0].usedAt.toISOString() : null,
            deliveryMethod: "telegram_dm_or_redirect",
          }
        : null,
  };
}

function ticketRow(t: any) {
  return {
    id: t.id,
    ticketNo: t.ticketNo,
    userId: t.userId,
    title: t.title,
    category: t.category,
    priority: t.priority,
    status: t.status,
    description: t.description ?? null,
    telegramUserId: t.telegramUserId ? t.telegramUserId.toString() : null,
    orderId: t.orderId ?? null,
    entitlementId: t.entitlementId ?? null,
    assignedToId: t.assignedToId ?? null,
    resolvedAt: t.resolvedAt ? t.resolvedAt.toISOString() : null,
    closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    user: t.user
      ? {
          id: t.user.id,
          displayName: t.user.displayName,
          username: t.user.username ?? null,
          telegramUserId: t.user.telegramUserId ? t.user.telegramUserId.toString() : null,
          status: t.user.status,
        }
      : null,
    sourceOrder: t.sourceOrder
      ? {
          id: t.sourceOrder.id,
          orderNo: t.sourceOrder.orderNo,
          status: t.sourceOrder.status,
        }
      : null,
    entitlement: t.entitlement
      ? { id: t.entitlement.id, resourceType: t.entitlement.resourceType, resourceId: t.entitlement.resourceId, status: t.entitlement.status }
      : null,
    assignedTo: t.assignedTo
      ? { id: t.assignedTo.id, email: t.assignedTo.email, displayName: t.assignedTo.displayName, role: t.assignedTo.role }
      : null,
    eventsCount: typeof t._count?.events === "number" ? t._count.events : undefined,
  };
}

function ticketEventRow(e: any) {
  return {
    id: e.id,
    ticketId: e.ticketId,
    type: e.type,
    authorType: e.authorType,
    authorUserId: e.authorUserId ?? null,
    authorAdminId: e.authorAdminId ?? null,
    note: e.note ?? null,
    actionRef: e.actionRef ?? null,
    oldStatus: e.oldStatus ?? null,
    newStatus: e.newStatus ?? null,
    createdAt: e.createdAt.toISOString(),
    authorUser: e.authorUser
      ? { id: e.authorUser.id, displayName: e.authorUser.displayName, username: e.authorUser.username ?? null, telegramUserId: e.authorUser.telegramUserId ? e.authorUser.telegramUserId.toString() : null }
      : null,
    authorAdmin: e.authorAdmin
      ? { id: e.authorAdmin.id, email: e.authorAdmin.email, displayName: e.authorAdmin.displayName, role: e.authorAdmin.role }
      : null,
  };
}

function generateTicketNo(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rnd = Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
  return `TKT${stamp}${rnd}`;
}

function communityVideoCreatorGrantRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    active: !!row.active,
    reason: row.reason ?? null,
    grantedAt: row.grantedAt ? new Date(row.grantedAt).toISOString() : null,
    revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
    grantedByAdmin: row.grantedByAdmin
      ? { id: row.grantedByAdmin.id, email: row.grantedByAdmin.email, displayName: row.grantedByAdmin.displayName, role: row.grantedByAdmin.role }
      : null,
    revokedByAdmin: row.revokedByAdmin
      ? { id: row.revokedByAdmin.id, email: row.revokedByAdmin.email, displayName: row.revokedByAdmin.displayName, role: row.revokedByAdmin.role }
      : null,
  };
}

const membershipChannelBigInt = (): null => {
  // 【Security Boundary - 细节2】路由层严禁直接从 env 取明文 chatId；
  // 所有频道操作一律通过 ChannelRef（如 refMembershipMain()）交给 telegramBot 服务层解析。
  return null;
};

export default async function adminUsersAndSupportRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  // ============================================================
  // BE-R3: Entitlements list (admin)
  // ============================================================
  fastify.get(
    "/admin/entitlements",
    { preHandler: [requireAdmin("entitlement:view")] },
    async (req, reply) => {
      const query = listEntitlementsQuerySchema.parse(req.query ?? {});
      const where: any = {};
      if (query.status) where.status = query.status;
      if (query.resourceType) where.resourceType = query.resourceType;
      if (query.removalStatus) where.removalStatus = query.removalStatus;
      if (query.userId) where.userId = query.userId;
      if (query.telegramUserId !== undefined) where.user = { telegramUserId: BigInt(query.telegramUserId) };
      if (query.resourceId) where.resourceId = query.resourceId;
      if (query.orderNo) where.sourceOrder = { orderNo: { contains: query.orderNo } };

      const skip = (query.page - 1) * query.pageSize;
      const take = query.pageSize;

      const [total, rows] = await Promise.all([
        prisma.entitlement.count({ where }),
        prisma.entitlement.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          skip,
          take,
          include: {
            sourceOrder: { select: { id: true, orderNo: true, status: true, amountMinor: true } },
            user: { select: { id: true, displayName: true, username: true, telegramUserId: true, status: true } },
            telegramInvites: { take: 1, orderBy: { createdAt: "desc" } },
          },
        }),
      ]);

      return reply.send({
        items: rows.map(entitlementRow),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/admin/entitlements/:id",
    { preHandler: [requireAdmin("entitlement:view")] },
    async (req, reply) => {
      const e = await prisma.entitlement.findUnique({
        where: { id: req.params.id },
        include: {
          sourceOrder: { select: { id: true, orderNo: true, status: true, amountMinor: true, currency: true, product: true, paidAt: true } },
          user: { select: { id: true, displayName: true, username: true, telegramUserId: true, status: true } },
          telegramInvites: { take: 5, orderBy: { createdAt: "desc" } },
        },
      });
      if (!e) return reply.status(404).send({ error: "not_found", message: "权益不存在" });
      return reply.send(entitlementRow(e));
    },
  );

  // ============================================================
  // BE-R4: Resend invite (regenerate telegram_invites row for membership_channel entitlement)
  // ============================================================
  fastify.post<{ Params: { id: string } }>(
    "/admin/entitlements/:id/resend-invite",
    { preHandler: [requireAdmin("entitlement:resend_invite")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const bodyParse = resendInviteSchema.safeParse(req.body ?? {});
      if (!bodyParse.success) return reply.status(400).send({ error: "bad_request", details: bodyParse.error.issues });
      const e = await prisma.entitlement.findUnique({
        where: { id: req.params.id },
        include: { user: true },
      });
      if (!e) return reply.status(404).send({ error: "not_found", message: "权益不存在" });
      if (e.status !== "active") return reply.status(409).send({ error: "conflict", message: `仅 active 权益可补发邀请，当前=${e.status}` });
      if (e.resourceType !== "membership_channel") {
        return reply.status(409).send({ error: "conflict", message: `仅会员频道权益可补发邀请（当前 resourceType=${e.resourceType}）` });
      }
      const tgid = e.user?.telegramUserId;
      if (!tgid) return reply.status(409).send({ error: "conflict", message: "该用户无 Telegram UID，无法创建频道邀请" });

      const before = entitlementRow(e);
      const now = new Date();
      let invite: Awaited<ReturnType<typeof createChannelInvite>>;
      try {
        // 【Security Boundary - 细节2】路由层只传 ChannelRef，不处理明文 chatId
        invite = await createChannelInvite({
          channel: await resolveMembershipChannelRef(prisma),
          name: `补发邀请 权益ID ${e.id.slice(0, 8)} admin ${admin.adminId.slice(0, 6)}`,
          ttlSeconds: bodyParse.data.ttlSeconds ?? 60 * 60 * 24 * 1,
          memberLimit: bodyParse.data.memberLimit ?? 1,
        });
      } catch (err: any) {
        const msg = err?.message || String(err);
        const isConfig =
          msg.includes("TELEGRAM_INVITE_BOT_KEY") ||
          msg.includes("TELEGRAM_CHANNEL_MEMBERSHIP") ||
          msg.includes("no valid invite Bot");
        return reply.status(isConfig ? 503 : 502).send({
          error: isConfig ? "telegram_not_configured" : "telegram_api_failed",
          message: msg,
          detail: isConfig
            ? { missingKeys: ["TELEGRAM_INVITE_BOT_KEY / TELEGRAM_BOTS", "TELEGRAM_CHANNEL_MEMBERSHIP"], doc: "https://core.telegram.org/bots/api" }
            : undefined,
        });
      }

      // 【Security Boundary - 细节3】JSON 响应中不含 inviteLink；通过 Bot 私信发给用户
      let dmSent = false;
      let dmError: string | null = null;
      try {
        const dm = await sendDirectMessage({
          telegramUserId: String(tgid),
          text:
            `【同频 · 邀请补发】\n` +
            `客服已为你重新生成会员频道邀请，请点击下方链接加入（有效期 ${Math.round((invite.ttlSeconds || 3600) / 360) / 10} 小时，限 1 人使用）：\n${invite.inviteLink}`,
          disableWebPagePreview: true,
        });
        dmSent = dm.success;
        if (!dm.success) dmError = dm.errorMessage || "sendMessage failed";
      } catch (err: any) {
        dmError = err?.message || "sendMessage threw";
      }

      const saved = await prisma.$transaction(async (tx: Tx) => {
        const created = await tx.telegramInvite.create({
          data: {
            userId: e.userId,
            entitlementId: e.id,
            channelId: invite._resolvedChannelId, // 细节2：仅在写入 DB 的同一调用栈中使用解析值
            inviteLink: invite.inviteLink,
            expiresAt: invite.expiresAt,
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: "admin.entitlement.resend_invite",
            objectType: "entitlement",
            objectId: e.id,
            beforeValue: before as any,
            // 审计记录中：只保留 chatId 指纹（HMAC）+ 脱敏显示，绝不记录明文 inviteLink
            afterValue: {
              ...before,
              lastInvite: {
                id: created.id,
                expiresAt: invite.expiresAt.toISOString(),
                channelFingerprint: chatIdFingerprint(invite._resolvedChannelId),
                channelMasked: maskChatIdSafe(invite._resolvedChannelId),
                delivery: { method: "telegram_dm", sent: dmSent, user: `uid:${e.userId}` },
              },
            } as any,
            reason: bodyParse.data.reason,
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
          },
        });
        return created;
      });

      // 【细节3强约束】响应中绝对不含 inviteLink 明文
      return reply.send({
        ok: true,
        entitlementId: e.id,
        invite: {
          id: saved.id,
          expiresAt: invite.expiresAt.toISOString(),
          deliveryMethod: dmSent ? "telegram_dm_sent" : "telegram_dm_failed",
          deliveryError: dmError,
        },
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/entitlements/:id/retry-removal",
    { preHandler: [requireAdmin("entitlement:retry_removal")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const bodyParse = retryRemovalSchema.safeParse(req.body ?? {});
      if (!bodyParse.success) return reply.status(400).send({ error: "bad_request", details: bodyParse.error.issues });

      const before = await prisma.entitlement.findUnique({
        where: { id: req.params.id },
        include: {
          sourceOrder: { select: { id: true, orderNo: true, status: true, amountMinor: true } },
          user: { select: { id: true, displayName: true, username: true, telegramUserId: true, status: true } },
          telegramInvites: { take: 1, orderBy: { createdAt: "desc" } },
        },
      });
      if (!before) return reply.status(404).send({ error: "not_found", message: "权益不存在" });
      if (!["membership_channel", "package"].includes(before.resourceType)) {
        return reply.status(409).send({ error: "conflict", message: "仅会员频道与内容包权益支持重试撤权" });
      }
      if (!before.expiresAt) {
        return reply.status(409).send({ error: "conflict", message: "永久权益不存在撤权宽限任务" });
      }

      const result = await processEntitlementGraceCleanup(prisma, before.id, { now: new Date() });

      const after = await prisma.entitlement.findUnique({
        where: { id: before.id },
        include: {
          sourceOrder: { select: { id: true, orderNo: true, status: true, amountMinor: true } },
          user: { select: { id: true, displayName: true, username: true, telegramUserId: true, status: true } },
          telegramInvites: { take: 1, orderBy: { createdAt: "desc" } },
        },
      });

      await prisma.adminAuditLog.create({
        data: {
          adminId: admin.adminId,
          action: "admin.entitlement.retry_removal",
          objectType: "entitlement",
          objectId: before.id,
          beforeValue: entitlementRow(before) as any,
          afterValue: after ? entitlementRow(after) as any : null,
          reason: bodyParse.data.reason,
          ipAddress: (req.ip as string) || null,
          userAgent: (req.headers["user-agent"] as string) || null,
        },
      });

      return reply.send({
        ok: result.ok,
        action: result.action,
        errorCode: result.errorCode ?? null,
        entitlement: after ? entitlementRow(after) : null,
      });
    },
  );

  // ============================================================
  // BE-R5: Grant entitlement directly (no order; for CS; requires adminId+reason; audit + optional telegram invite + optional ticket event)
  // ============================================================
  fastify.post(
    "/admin/entitlements/grant",
    { preHandler: [requireAdmin("entitlement:grant")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const parse = grantEntitlementSchema.safeParse(req.body ?? {});
      if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });
      const { userId, resourceType, resourceId, reason, durationDays, sourceOrderId, ticketId } = parse.data;

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, telegramUserId: true } });
      if (!user) return reply.status(404).send({ error: "not_found", message: "用户不存在" });

      // Basic existence sanity checks for non-membership types
      if (resourceType === "content") {
        const c = await prisma.content.count({ where: { id: resourceId } });
        if (c === 0) return reply.status(404).send({ error: "resource_not_found", message: "内容不存在" });
      } else if (resourceType === "package") {
        const p = await prisma.contentPackage.count({ where: { id: resourceId } });
        if (p === 0) return reply.status(404).send({ error: "resource_not_found", message: "内容包不存在" });
      } else if (resourceType === "membership_channel") {
        // canonical id for main membership; also allow specific resourceId match productId via Product.type=membership
        if (resourceId !== "membership-main") {
          const p = await prisma.product.count({ where: { id: resourceId, type: "membership" } });
          if (p === 0) return reply.status(404).send({ error: "resource_not_found", message: "会员产品不存在" });
        }
      }

      const startsAt = new Date();
      const expiresAt = durationDays ? new Date(startsAt.getTime() + durationDays * 86400 * 1000) : null;

      const txResult = await prisma.$transaction(async (tx: Tx) => {
        const created = await tx.entitlement.create({
          data: {
            userId,
            resourceType,
            resourceId,
            sourceOrderId: sourceOrderId || null,
            status: "active",
            startsAt,
            expiresAt,
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: "admin.entitlement.grant",
            objectType: "entitlement",
            objectId: created.id,
            beforeValue: null as any,
            afterValue: {
              id: created.id,
              userId,
              resourceType,
              resourceId,
              status: "active",
              startsAt: startsAt.toISOString(),
              expiresAt: expiresAt ? expiresAt.toISOString() : null,
              sourceOrderId: sourceOrderId || null,
              ticketId: ticketId || null,
            } as any,
            reason,
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
          },
        });
        let ticketEvent: any = null;
        if (ticketId) {
          const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
          if (ticket) {
            ticketEvent = await tx.ticketEvent.create({
              data: {
                ticketId,
                type: "action_taken",
                authorType: "admin",
                authorAdminId: admin.adminId,
                note: `发放权益（${resourceType} / ${resourceId.slice(0, 8)}…）：${reason}`,
                actionRef: created.id,
              },
            });
            if (ticket.status === "open") {
              await tx.supportTicket.update({
                where: { id: ticketId },
                data: { status: "in_progress" },
              });
            }
          }
        }
        return { created, ticketEvent };
      });

      let telegramInvite: any = null;
      if (resourceType === "membership_channel" && user.telegramUserId) {
        try {
          // 【Security Boundary - 细节2】路由层只传 ChannelRef
          const r = await createChannelInvite({
            channel: await resolveMembershipChannelRef(prisma),
            name: `客服直接发放 权益ID ${txResult.created.id.slice(0, 8)}`,
            ttlSeconds: 60 * 60 * 24 * 1,
            memberLimit: 1,
          });
          // 【Security Boundary - 细节3】JSON 响应中绝不包含 inviteLink 明文
          // 写入 DB 后仅通过 Telegram Bot 私信发送给用户
          let dmSent = false;
          let dmError: string | null = null;
          try {
            const dm = await sendDirectMessage({
              telegramUserId: String(user.telegramUserId),
              text:
                `【同频 · 会员权益已发放】\n` +
                `客服已为你开通会员频道访问权限，请点击下方链接加入（24 小时内有效，限 1 人使用）：\n${r.inviteLink}`,
              disableWebPagePreview: true,
            });
            dmSent = dm.success;
            if (!dm.success) dmError = dm.errorMessage || null;
          } catch (err: any) {
            dmError = err?.message || null;
          }
          const savedInvite = await prisma.telegramInvite.create({
            data: {
              userId,
              entitlementId: txResult.created.id,
              channelId: r._resolvedChannelId, // 细节2：同一调用栈中内部写入 DB，不暴露给 JSON
              inviteLink: r.inviteLink,
              expiresAt: r.expiresAt,
            },
          });
          telegramInvite = {
            id: savedInvite.id,
            expiresAt: r.expiresAt,
            deliveryMethod: dmSent ? "telegram_dm_sent" : "telegram_dm_failed",
            deliveryError: dmError,
          };
        } catch (err: any) {
          telegramInvite = { error: err?.message || "telegram invite creation failed" };
        }
      }

      // 【细节3】JSON 响应只返回 id + 交付状态，绝不含邀请链接明文
      return reply.status(201).send({
        ok: true,
        entitlement: entitlementRow({
          ...txResult.created,
          sourceOrder: null,
          user: null,
          telegramInvites: telegramInvite && !telegramInvite.error ? [{ id: telegramInvite.id, expiresAt: telegramInvite.expiresAt }] : [],
        }),
        ticketEvent: txResult.ticketEvent?.id || null,
        telegramInvite: telegramInvite?.error
          ? { error: telegramInvite.error }
          : telegramInvite
          ? {
              id: telegramInvite.id,
              expiresAt: telegramInvite.expiresAt?.toISOString?.() ?? telegramInvite.expiresAt,
              deliveryMethod: telegramInvite.deliveryMethod,
              deliveryError: telegramInvite.deliveryError ?? null,
            }
          : null,
      });
    },
  );

  // ============================================================
  // BE-R6: Admin list users + single lookup
  // ============================================================
  fastify.get(
    "/admin/users",
    { preHandler: [requireAdmin("user:view")] },
    async (req, reply) => {
      const query = listUsersQuerySchema.parse(req.query ?? {});
      const where: any = {};
      if (query.telegramUserId !== undefined) where.telegramUserId = BigInt(query.telegramUserId);
      if (query.telegramBound === true) where.telegramUserId = { not: null };
      if (query.telegramBound === false) where.telegramUserId = null;
      if (query.status) where.status = query.status;
      if (query.q) {
        const q = query.q.trim();
        where.OR = [
          { displayName: { contains: q } },
          { username: { contains: q, mode: "insensitive" } },
          /^\d+$/.test(q) ? { telegramUserId: BigInt(q) } : undefined,
        ].filter(Boolean);
      }
      if (query.hasActiveEntitlement !== undefined) {
        where.entitlements = query.hasActiveEntitlement
          ? { some: { status: "active" } }
          : { every: { status: { not: "active" } } };
      }

      const skip = (query.page - 1) * query.pageSize;
      const take = query.pageSize;

      const [total, rows] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          skip,
          take,
          include: {
            _count: { select: { orders: true, entitlements: true, supportTickets: true } },
            entitlements: { take: 10, orderBy: [{ status: "asc" }, { createdAt: "desc" }] },
          },
        }),
      ]);

      const items = rows.map((u: any) => {
        const actives = u.entitlements.filter((e: any) => e.status === "active");
        return {
          id: u.id,
          displayName: u.displayName,
          username: u.username ?? null,
          telegramUserId: u.telegramUserId ? u.telegramUserId.toString() : null,
          telegramFirstName: u.telegramFirstName ?? null,
          telegramLastName: u.telegramLastName ?? null,
          telegramLanguageCode: u.telegramLanguageCode ?? null,
          photoUrl: u.photoUrl ?? null,
          lastTelegramSeenAt: u.lastTelegramSeenAt ? u.lastTelegramSeenAt.toISOString() : null,
          status: u.status,
          createdAt: u.createdAt.toISOString(),
          ordersCount: u._count.orders,
          entitlementsCount: u._count.entitlements,
          activeEntitlementsCount: actives.length,
          ticketsCount: u._count.supportTickets,
          recentEntitlements: u.entitlements.map((e: any) => ({
            id: e.id,
            resourceType: e.resourceType,
            resourceId: e.resourceId,
            status: e.status,
            expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
          })),
        };
      });

      return reply.send({
        items,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/admin/users/:id",
    { preHandler: [requireAdmin("user:view")] },
    async (req, reply) => {
      const u = await prisma.user.findUnique({
        where: { id: req.params.id },
        include: {
          _count: { select: { orders: true, entitlements: true, supportTickets: true, telegramInvites: true } },
          orders: { take: 20, orderBy: { createdAt: "desc" }, include: { product: true, entitlements: true } },
          entitlements: { take: 30, orderBy: [{ createdAt: "desc" }], include: { telegramInvites: { take: 1, orderBy: { createdAt: "desc" } } } },
          supportTickets: { take: 10, orderBy: { createdAt: "desc" }, select: { id: true, ticketNo: true, title: true, status: true, priority: true, category: true, createdAt: true } },
        },
      });
      if (!u) return reply.status(404).send({ error: "not_found", message: "用户不存在" });
      const communityVideoCreatorGrant = await (prisma as any).communityVideoCreatorGrant.findUnique({
        where: { userId: req.params.id },
        include: {
          grantedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
          revokedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
        },
      });
      return reply.send({
        id: u.id,
        displayName: u.displayName,
        username: u.username ?? null,
        telegramUserId: u.telegramUserId ? u.telegramUserId.toString() : null,
        telegramFirstName: u.telegramFirstName ?? null,
        telegramLastName: u.telegramLastName ?? null,
        telegramLanguageCode: u.telegramLanguageCode ?? null,
        photoUrl: u.photoUrl ?? null,
        lastTelegramSeenAt: u.lastTelegramSeenAt ? u.lastTelegramSeenAt.toISOString() : null,
        status: u.status,
        createdAt: u.createdAt.toISOString(),
        counts: {
          orders: u._count.orders,
          entitlements: u._count.entitlements,
          tickets: u._count.supportTickets,
          telegramInvites: u._count.telegramInvites,
        },
        recentOrders: (u as any).orders.map((o: any) => ({
          id: o.id,
          orderNo: o.orderNo,
          status: o.status,
          amountMinor: o.amountMinor?.toString() ?? null,
          currency: o.currency,
          product: o.product ? { id: o.product.id, type: o.product.type, title: o.product.title } : null,
          paidAt: o.paidAt ? o.paidAt.toISOString() : null,
          createdAt: o.createdAt.toISOString(),
          entitlementsCount: o.entitlements?.length ?? 0,
        })),
        entitlements: (u as any).entitlements.map((e: any) => entitlementRow(e)),
        tickets: (u as any).supportTickets,
        communityVideoCreatorGrant: communityVideoCreatorGrantRow(communityVideoCreatorGrant),
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/users/:id/community-video-creator",
    { preHandler: [requireAdmin("community:manage_video_creator")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const parsed = setCommunityVideoCreatorSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: "bad_request", details: parsed.error.issues });

      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, displayName: true, username: true, telegramUserId: true },
      });
      if (!user) return reply.status(404).send({ error: "not_found", message: "用户不存在" });

      const before = await (prisma as any).communityVideoCreatorGrant.findUnique({
        where: { userId: req.params.id },
        include: {
          grantedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
          revokedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
        },
      });
      const now = new Date();

      const after = await prisma.$transaction(async (tx: any) => {
        let nextRow = before;
        if (parsed.data.active) {
          nextRow = before
            ? await tx.communityVideoCreatorGrant.update({
                where: { userId: req.params.id },
                data: {
                  active: true,
                  reason: parsed.data.reason,
                  grantedByAdminId: admin.adminId,
                  revokedByAdminId: null,
                  revokedAt: null,
                  grantedAt: before.active ? before.grantedAt : now,
                },
                include: {
                  grantedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
                  revokedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
                },
              })
            : await tx.communityVideoCreatorGrant.create({
                data: {
                  userId: req.params.id,
                  active: true,
                  reason: parsed.data.reason,
                  grantedByAdminId: admin.adminId,
                  grantedAt: now,
                },
                include: {
                  grantedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
                  revokedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
                },
              });
        } else if (before) {
          nextRow = await tx.communityVideoCreatorGrant.update({
            where: { userId: req.params.id },
            data: {
              active: false,
              reason: parsed.data.reason,
              revokedByAdminId: admin.adminId,
              revokedAt: now,
            },
            include: {
              grantedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
              revokedByAdmin: { select: { id: true, email: true, displayName: true, role: true } },
            },
          });
        }

        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: parsed.data.active ? "community.video_creator.grant" : "community.video_creator.revoke",
            objectType: "user",
            objectId: req.params.id,
            beforeValue: communityVideoCreatorGrantRow(before) as any,
            afterValue: communityVideoCreatorGrantRow(nextRow) as any,
            reason: parsed.data.reason,
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
          },
        });
        return nextRow;
      });

      return reply.send({
        ok: true,
        user: {
          id: user.id,
          displayName: user.displayName,
          username: user.username ?? null,
          telegramUserId: user.telegramUserId ? user.telegramUserId.toString() : null,
        },
        communityVideoCreatorGrant: communityVideoCreatorGrantRow(after),
      });
    },
  );

  // ============================================================
  // BE-R7: Support Ticket CRUD + state machine + events
  // ============================================================
  fastify.get(
    "/admin/tickets",
    { preHandler: [requireAdmin("ticket:view")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const q = listTicketsQuerySchema.parse(req.query ?? {});
      const where: any = {};
      if (q.status) where.status = q.status;
      if (q.priority) where.priority = q.priority;
      if (q.category) where.category = q.category;
      if (q.userId) where.userId = q.userId;
      if (q.telegramUserId !== undefined) where.telegramUserId = BigInt(q.telegramUserId);
      if (q.entitlementId) where.entitlementId = q.entitlementId;
      if (q.assignedToId) where.assignedToId = q.assignedToId;
      if (q.unassignedOnly) where.assignedToId = null;
      if (q.mine) where.assignedToId = admin.adminId;
      if (q.orderNo) where.sourceOrder = { orderNo: { contains: q.orderNo } };
      if (q.q) {
        const kw = q.q.trim();
        where.OR = [
          { title: { contains: kw } },
          { description: { contains: kw } },
          /^TKT/i.test(kw) ? { ticketNo: { contains: kw } } : undefined,
        ].filter(Boolean);
      }

      const skip = (q.page - 1) * q.pageSize;
      const take = q.pageSize;

      const include = {
        user: { select: { id: true, displayName: true, username: true, telegramUserId: true, status: true } },
        sourceOrder: { select: { id: true, orderNo: true, status: true } },
        entitlement: { select: { id: true, resourceType: true, resourceId: true, status: true } },
        assignedTo: { select: { id: true, email: true, displayName: true, role: true } },
        _count: { select: { events: true } },
      } as const;

      const [total, rows] = await Promise.all([
        prisma.supportTicket.count({ where }),
        prisma.supportTicket.findMany({
          where,
          orderBy: [
            { priority: "desc" },
            { createdAt: "desc" },
          ],
          skip,
          take,
          include,
        }),
      ]);

      return reply.send({
        items: rows.map(ticketRow),
        pagination: {
          page: q.page,
          pageSize: q.pageSize,
          total,
          totalPages: Math.ceil(total / q.pageSize),
        },
      });
    },
  );

  fastify.post(
    "/admin/tickets",
    { preHandler: [requireAdmin("ticket:note")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const parse = createTicketAdminSchema.safeParse(req.body ?? {});
      if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });
      const data = parse.data;
      const ticketNo = generateTicketNo();

      const created = await prisma.$transaction(async (tx: Tx) => {
        const t = await tx.supportTicket.create({
          data: {
            ticketNo,
            userId: data.userId,
            title: data.title,
            category: data.category,
            priority: data.priority,
            description: data.description ?? null,
            orderId: data.orderId || null,
            entitlementId: data.entitlementId || null,
            telegramUserId: data.telegramUserId ?? null,
            status: "open",
          },
          include: {
            user: true,
            sourceOrder: true,
            entitlement: true,
            assignedTo: true,
            _count: { select: { events: true } },
          },
        });
        const events: any[] = [
          tx.ticketEvent.create({
            data: {
              ticketId: t.id,
              type: "created",
              authorType: "admin",
              authorAdminId: admin.adminId,
              note: `管理员创建工单（${data.category}）${data.description ? `：${data.description.slice(0, 200)}` : ""}`,
              newStatus: "open",
            },
          }),
        ];
        if (data.initialNotePublic) {
          events.push(
            tx.ticketEvent.create({
              data: {
                ticketId: t.id,
                type: "note_public",
                authorType: "admin",
                authorAdminId: admin.adminId,
                note: data.initialNotePublic,
              },
            }),
          );
        }
        await Promise.all(events);
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: "admin.ticket.create",
            objectType: "ticket",
            objectId: t.ticketNo,
            reason: data.description ?? "客服代开单",
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
          },
        });
        return t;
      });

      return reply.status(201).send(ticketRow(created));
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/admin/tickets/:id",
    { preHandler: [requireAdmin("ticket:view")] },
    async (req, reply) => {
      const t = await prisma.supportTicket.findUnique({
        where: { id: req.params.id },
        include: {
          user: { select: { id: true, displayName: true, username: true, telegramUserId: true, status: true } },
          sourceOrder: { select: { id: true, orderNo: true, status: true, paidAt: true, product: true } },
          entitlement: { select: { id: true, resourceType: true, resourceId: true, status: true, startsAt: true, expiresAt: true, sourceOrder: true } },
          assignedTo: { select: { id: true, email: true, displayName: true, role: true } },
          events: {
            orderBy: { createdAt: "asc" },
            include: {
              authorUser: { select: { id: true, displayName: true, username: true, telegramUserId: true } },
              authorAdmin: { select: { id: true, email: true, displayName: true, role: true } },
            },
          },
          _count: { select: { events: true } },
        },
      });
      if (!t) return reply.status(404).send({ error: "not_found", message: "工单不存在" });
      return reply.send({
        ...ticketRow(t),
        events: (t as any).events.map(ticketEventRow),
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/users/:id/revoke-playback-sessions",
    { preHandler: [requireAdmin("*")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      if (admin.role !== "super_admin") {
        return reply.status(403).send({ error: "forbidden", message: "权限不足，需要 super_admin" });
      }
      const parse = revokePlaybackSessionsSchema.safeParse(req.body ?? {});
      if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });

      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, status: true },
      });
      if (!user) return reply.status(404).send({ error: "not_found", message: "用户不存在" });

      const result = await revokePlaybackSessionsByUser(prisma, {
        userId: user.id,
        requestedByAdminId: admin.adminId,
        reason: user.status === "suspended" ? "user_suspended" : "manual_admin",
      });
      await prisma.adminAuditLog.create({
        data: {
          adminId: admin.adminId,
          action: "admin.user.revoke_playback_sessions",
          objectType: "user",
          objectId: user.id,
          reason: parse.data.reason,
          ipAddress: (req.ip as string) || null,
          userAgent: (req.headers["user-agent"] as string) || null,
          afterValue: {
            playbackRevokeOutboxId: result.outboxId,
            activeSessionCount: result.activeCount,
          },
        },
      });
      return reply.send({
        ok: true,
        playbackRevokeOutboxId: result.outboxId,
        activeSessionCount: result.activeCount,
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/tickets/:id/assign-self",
    { preHandler: [requireAdmin("ticket:assign_self")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const parse = ticketActionSchema.safeParse(req.body ?? {});
      if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });
      const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, assignedToId: true } });
      if (!t) return reply.status(404).send({ error: "not_found", message: "工单不存在" });
      if (t.status === "closed") return reply.status(409).send({ error: "conflict", message: "工单已关闭，不可再领单" });
      const before = { status: t.status, assignedToId: t.assignedToId };
      const newStatus = t.status === "open" ? "in_progress" : t.status;
      const saved = await prisma.$transaction(async (tx: Tx) => {
        const upd = await tx.supportTicket.update({
          where: { id: t.id },
          data: { assignedToId: admin.adminId, status: newStatus },
          include: { assignedTo: true },
        });
        await tx.ticketEvent.create({
          data: {
            ticketId: t.id,
            type: "assigned",
            authorType: "admin",
            authorAdminId: admin.adminId,
            note: parse.data.reason || "客服自助领单",
            oldStatus: before.status as any,
            newStatus: (newStatus as any) || undefined,
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: "admin.ticket.assign_self",
            objectType: "ticket",
            objectId: t.id,
            beforeValue: before as any,
            afterValue: { status: upd.status, assignedToId: upd.assignedToId } as any,
            reason: parse.data.reason || null,
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
          },
        });
        return upd;
      });
      return reply.send({ ok: true, assignedToId: saved.assignedToId, status: saved.status });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/tickets/:id/notes",
    { preHandler: [requireAdmin("ticket:note")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const parse = noteSchema.safeParse(req.body ?? {});
      if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });
      const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
      if (!t) return reply.status(404).send({ error: "not_found", message: "工单不存在" });
      if (t.status === "closed") return reply.status(409).send({ error: "conflict", message: "已关单，不允许追加备注" });
      const ev = await prisma.$transaction(async (tx: Tx) => {
        const created = await tx.ticketEvent.create({
          data: {
            ticketId: t.id,
            type: parse.data.isPublic ? "note_public" : "note_internal",
            authorType: "admin",
            authorAdminId: admin.adminId,
            note: parse.data.note,
            actionRef: parse.data.actionRef || null,
          },
        });
        if (t.status === "open") {
          await tx.supportTicket.update({ where: { id: t.id }, data: { status: "in_progress" } });
        }
        return created;
      });
      return reply.status(201).send({ ok: true, eventId: ev.id, isPublic: parse.data.isPublic });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/tickets/:id/resolve",
    { preHandler: [requireAdmin("ticket:resolve")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const parse = ticketActionSchema.safeParse(req.body ?? {});
      if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });
      const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
      if (!t) return reply.status(404).send({ error: "not_found", message: "工单不存在" });
      if (t.status === "closed" || t.status === "resolved")
        return reply.status(409).send({ error: "conflict", message: `当前状态 ${t.status} 不可重复解决` });
      const before = { status: t.status };
      const now = new Date();
      const saved = await prisma.$transaction(async (tx: Tx) => {
        const upd = await tx.supportTicket.update({
          where: { id: t.id },
          data: { status: "resolved", resolvedAt: now },
        });
        await tx.ticketEvent.create({
          data: {
            ticketId: t.id,
            type: "resolved",
            authorType: "admin",
            authorAdminId: admin.adminId,
            note: parse.data.reason || "解决",
            oldStatus: before.status as any,
            newStatus: "resolved",
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: "admin.ticket.resolve",
            objectType: "ticket",
            objectId: t.id,
            beforeValue: before as any,
            afterValue: { status: "resolved", resolvedAt: now.toISOString() } as any,
            reason: parse.data.reason || null,
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
          },
        });
        return upd;
      });
      return reply.send({ ok: true, status: saved.status, resolvedAt: saved.resolvedAt?.toISOString?.() ?? null });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/tickets/:id/close",
    { preHandler: [requireAdmin("ticket:close")] },
    async (req, reply) => {
      const admin = (req as any).admin as { adminId: string; role: string; email: string };
      const parse = ticketActionSchema.safeParse(req.body ?? {});
      if (!parse.success) return reply.status(400).send({ error: "bad_request", details: parse.error.issues });
      const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
      if (!t) return reply.status(404).send({ error: "not_found", message: "工单不存在" });
      if (t.status === "closed") return reply.status(409).send({ error: "conflict", message: "工单已关闭" });
      const before = { status: t.status };
      const now = new Date();
      const saved = await prisma.$transaction(async (tx: Tx) => {
        const upd = await tx.supportTicket.update({
          where: { id: t.id },
          data: { status: "closed", closedAt: now },
        });
        await tx.ticketEvent.create({
          data: {
            ticketId: t.id,
            type: "closed",
            authorType: "admin",
            authorAdminId: admin.adminId,
            note: parse.data.reason || "关单",
            oldStatus: before.status as any,
            newStatus: "closed",
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.adminId,
            action: "admin.ticket.close",
            objectType: "ticket",
            objectId: t.id,
            beforeValue: before as any,
            afterValue: { status: "closed", closedAt: now.toISOString() } as any,
            reason: parse.data.reason || null,
            ipAddress: (req.ip as string) || null,
            userAgent: (req.headers["user-agent"] as string) || null,
          },
        });
        return upd;
      });
      return reply.send({ ok: true, status: saved.status, closedAt: saved.closedAt?.toISOString?.() ?? null });
    },
  );
}
