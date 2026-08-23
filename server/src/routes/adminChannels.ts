import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import {
  getChat,
  getChatByUsername,
  getChatMemberCount,
  getBotChatMember,
  refManagedChat,
} from "../services/telegramBot.js";
import { decryptChatIdAesGcm, encryptChatIdAesGcm, chatIdIndexKey } from "../utils/crypto.js";
import { encryptPackageColsFromPlain } from "../services/channelCrypto.js";

type AdminCtx = { adminId: string; role: string; email: string };
const REVEAL_TTL_MS = 10_000;
const FRESH_CACHE_MS = 10 * 60 * 1000;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().min(1).max(100).optional(),
  purpose: z.enum(["none", "free_preview", "membership_main", "package_channel"]).optional(),
  status: z.enum(["pending_public_check", "awaiting_bot_admin", "discovered", "bound", "conflict", "failed"]).optional(),
});

const discoverySubmitSchema = z.object({
  channelLink: z.string().min(3).max(1000),
  purpose: z.enum(["none", "free_preview", "membership_main", "package_channel"]).optional(),
  packageId: z.string().trim().min(1).max(64).optional().nullable(),
  reason: z.string().min(2).max(1000),
});

const refreshBodySchema = z.object({
  reason: z.string().min(2).max(1000),
  force: z.boolean().optional(),
});

const revealIdSchema = z.object({
  reason: z.string().min(2).max(1000),
});

const bindPurposeSchema = z.object({
  purpose: z.enum(["none", "free_preview", "membership_main", "package_channel"]),
  packageId: z.string().trim().min(1).max(64).nullable().optional(),
  reason: z.string().min(2).max(1000),
});

function maskChatId(chatIdStr: string): string {
  if (!chatIdStr) return "****";
  const tail = chatIdStr.slice(-3);
  if (chatIdStr.startsWith("-100")) return `-100********${tail}`;
  if (chatIdStr.startsWith("-")) return `-********${tail}`;
  return `********${tail}`;
}

function safeString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function resolveStoredChatId(row: { deprecatedChatIdBig?: bigint | null; chatIdCiphertextB64?: string | null }): bigint | null {
  if (typeof row.deprecatedChatIdBig === "bigint") return row.deprecatedChatIdBig;
  if (row.chatIdCiphertextB64) {
    try {
      return decryptChatIdAesGcm(row.chatIdCiphertextB64);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeSubmittedChannelLink(input: string): {
  ok: boolean;
  linkType?: "public_username" | "private_invite";
  username?: string;
  normalizedLink?: string;
  error?: string;
} {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "channelLink 不能为空" };

  const usernameMatch =
    raw.match(/^@([A-Za-z0-9_]{4,64})$/) ||
    raw.match(/^https?:\/\/t\.me\/([A-Za-z0-9_]{4,64})(?:\?.*)?$/i) ||
    raw.match(/^t\.me\/([A-Za-z0-9_]{4,64})(?:\?.*)?$/i);
  if (usernameMatch) {
    const username = usernameMatch[1];
    return {
      ok: true,
      linkType: "public_username",
      username,
      normalizedLink: `https://t.me/${username}`,
    };
  }

  const privateMatch =
    raw.match(/^https?:\/\/t\.me\/\+([A-Za-z0-9_-]{8,})$/i) ||
    raw.match(/^https?:\/\/t\.me\/joinchat\/([A-Za-z0-9_-]{8,})$/i) ||
    raw.match(/^t\.me\/\+([A-Za-z0-9_-]{8,})$/i) ||
    raw.match(/^t\.me\/joinchat\/([A-Za-z0-9_-]{8,})$/i);
  if (privateMatch) {
    return {
      ok: true,
      linkType: "private_invite",
      normalizedLink: `https://t.me/+${privateMatch[1]}`,
    };
  }

  return {
    ok: false,
    error: "仅支持公开频道 @username / https://t.me/xxx，或私密邀请链接 https://t.me/+xxxxx / joinchat/xxxxx",
  };
}

async function writeAudit(
  prisma: any,
  req: FastifyRequest,
  admin: AdminCtx,
  opts: {
    action: string;
    objectType: string;
    objectId: string;
    reason?: string | null;
    beforeValue?: unknown;
    afterValue?: unknown;
  },
) {
  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.adminId,
      action: opts.action,
      objectType: opts.objectType,
      objectId: opts.objectId,
      beforeValue: (opts.beforeValue ?? null) as any,
      afterValue: (opts.afterValue ?? null) as any,
      reason: opts.reason ?? null,
      ipAddress: (req.ip as string) || null,
      userAgent: (req.headers["user-agent"] as string) || null,
    },
  });
}

async function assignManagedChannelPurpose(
  prisma: any,
  channel: any,
  purpose: "none" | "free_preview" | "membership_main" | "package_channel",
  packageId?: string | null,
) {
  const plainChatId = resolveStoredChatId(channel);
  if (!plainChatId) {
    throw new Error("频道 chat.id 不存在，无法绑定用途");
  }
  if (purpose === "free_preview" && channel.isPrivate) {
    throw new Error("免费预览用途只能绑定公开频道，私密频道不可设为 free_preview");
  }
  if ((purpose === "membership_main" || purpose === "package_channel") && !channel.botIsAdmin) {
    throw new Error("私密频道用途要求 Bot 已加入管理员，否则无法发布/邀请/踢人");
  }

  if (purpose === "membership_main") {
    await prisma.adminManagedChannel.updateMany({
      where: { purpose: "membership_main", chatIdHmac: { not: channel.chatIdHmac } },
      data: { purpose: "none", packageId: null },
    });
    return prisma.adminManagedChannel.update({
      where: { chatIdHmac: channel.chatIdHmac },
      data: { purpose, packageId: null, discoveryErrorCode: null },
    });
  }

  if (purpose === "package_channel") {
    if (!packageId) throw new Error("package_channel 必须选择一个内容包");
    const pkg = await prisma.contentPackage.findUnique({ where: { id: packageId }, select: { id: true } });
    if (!pkg) throw new Error("所选内容包不存在");
    await prisma.adminManagedChannel.updateMany({
      where: { purpose: "package_channel", packageId, chatIdHmac: { not: channel.chatIdHmac } },
      data: { purpose: "none", packageId: null },
    });
    const encrypted = encryptPackageColsFromPlain(plainChatId);
    await prisma.contentPackage.update({
      where: { id: packageId },
      data: {
        channelId: plainChatId,
        channelIdCiphertext: encrypted.channelIdCiphertextB64,
        channelIdHmac: encrypted.channelIdHmac,
      },
    });
    return prisma.adminManagedChannel.update({
      where: { chatIdHmac: channel.chatIdHmac },
      data: { purpose, packageId, discoveryErrorCode: null },
      include: { package: { select: { id: true, title: true } } },
    });
  }

  return prisma.adminManagedChannel.update({
    where: { chatIdHmac: channel.chatIdHmac },
    data: { purpose, packageId: null, discoveryErrorCode: null },
    include: { package: { select: { id: true, title: true } } },
  });
}

function mapManagedChannelRow(r: any) {
  return {
    chatId: r.chatIdHmac,
    chatIdHmac: r.chatIdHmac,
    chatIdMasked: r.chatIdHmac ? `hmac:${String(r.chatIdHmac).slice(0, 8)}…` : "****",
    type: r.chatType,
    title: r.title,
    username: r.username,
    memberCount: r.memberCount,
    avatarFileId: r.avatarFileId,
    isPrivate: !!r.isPrivate,
    source: r.source,
    purpose: r.purpose,
    packageId: r.packageId ?? null,
    packageTitle: r.package?.title ?? null,
    publicUrl: r.publicUrl ?? null,
    botIsAdmin: !!r.botIsAdmin,
    botCanPostMessages: !!r.botCanPostMessages,
    botCanInviteUsers: !!r.botCanInviteUsers,
    botCanRestrictMembers: !!r.botCanRestrictMembers,
    lastDiscoveryUpdateType: r.lastDiscoveryUpdateType ?? null,
    discoveryErrorCode: r.discoveryErrorCode ?? null,
    lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : null,
    refreshedAt: r.refreshedAt ? r.refreshedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapDiscoveryRow(r: any) {
  const isPrivateInvite = r.linkType === "private_invite";
  return {
    id: r.id,
    submittedLink: isPrivateInvite ? "私密邀请已提交" : r.submittedLink,
    normalizedLink: isPrivateInvite ? null : (r.normalizedLink ?? null),
    linkType: r.linkType,
    status: r.status,
    requestedPurpose: r.requestedPurpose,
    packageId: r.packageId ?? null,
    packageTitle: r.package?.title ?? null,
    resolvedChannelHmac: r.resolvedChannel?.chatIdHmac ?? null,
    resolvedChannelMasked: r.resolvedChannel?.chatIdHmac ? `hmac:${String(r.resolvedChannel.chatIdHmac).slice(0, 8)}…` : null,
    resolvedChannelTitle: r.resolvedChannel?.title ?? null,
    waitingSince: r.waitingSince ? r.waitingSince.toISOString() : null,
    discoveredAt: r.discoveredAt ? r.discoveredAt.toISOString() : null,
    boundAt: r.boundAt ? r.boundAt.toISOString() : null,
    lastErrorCode: r.lastErrorCode ?? null,
    lastErrorNote: r.lastErrorNote ?? null,
    submittedByAdmin: r.submittedByAdmin ? {
      id: r.submittedByAdmin.id,
      displayName: r.submittedByAdmin.displayName,
      email: r.submittedByAdmin.email,
    } : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export default async function adminChannelsRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.post(
    "/admin/channels",
    { preHandler: [requireAdmin("channel:add")] },
    async (_req, reply) => {
      return reply.status(409).send({
        error: "manual_chat_id_disabled",
        message: "已禁用手填 chatId。请改用 POST /api/admin/channels/discovery-requests 提交公开链接或私密邀请链接，等待 Webhook 自动发现频道。",
      });
    },
  );

  fastify.get(
    "/admin/channels",
    { preHandler: [requireAdmin("channel:view")] },
    async (req, reply) => {
      const q = listQuerySchema.parse(req.query ?? {});
      const where: any = {};
      if (q.purpose) where.purpose = q.purpose;
      if (q.search) {
        where.OR = [
          { title: { contains: q.search, mode: "insensitive" } },
          { username: { contains: q.search, mode: "insensitive" } },
          { publicUrl: { contains: q.search, mode: "insensitive" } },
        ];
      }
      if (q.status) {
        where.discoveryRequests = { some: { status: q.status } };
      }
      const [rows, total] = await Promise.all([
        prisma.adminManagedChannel.findMany({
          where,
          include: { package: { select: { id: true, title: true } } },
          orderBy: [{ purpose: "desc" }, { refreshedAt: "desc" }, { createdAt: "desc" }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.adminManagedChannel.count({ where }),
      ]);
      return reply.send({
        items: rows.map(mapManagedChannelRow),
        pagination: { page: q.page, pageSize: q.pageSize, total },
      });
    },
  );

  fastify.get(
    "/admin/channels/discovery-requests",
    { preHandler: [requireAdmin("channel:view")] },
    async (_req, reply) => {
      const rows = await prisma.adminChannelDiscoveryRequest.findMany({
        include: {
          package: { select: { id: true, title: true } },
          resolvedChannel: { select: { chatIdHmac: true, title: true } },
          submittedByAdmin: { select: { id: true, email: true, displayName: true } },
        },
        orderBy: [{ createdAt: "desc" }],
        take: 100,
      });
      return reply.send({ items: rows.map(mapDiscoveryRow) });
    },
  );

  fastify.post(
    "/admin/channels/discovery-requests",
    { preHandler: [requireAdmin("channel:add")] },
    async (req, reply) => {
      const admin = (req as any).admin as AdminCtx;
      const body = discoverySubmitSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });

      const parsed = normalizeSubmittedChannelLink(body.data.channelLink);
      if (!parsed.ok || !parsed.linkType || !parsed.normalizedLink) {
        return reply.status(400).send({ error: "bad_request", message: parsed.error || "channelLink 非法" });
      }
      if (body.data.purpose === "package_channel" && !body.data.packageId) {
        return reply.status(400).send({ error: "bad_request", message: "package_channel 必须选择 packageId" });
      }

      if (parsed.linkType === "public_username" && parsed.username) {
        try {
          const chat = await getChatByUsername(parsed.username);
          const chatIdBig = BigInt(chat.chatId);
          let botMember: Awaited<ReturnType<typeof getBotChatMember>> | null = null;
          let memberCount: number | null = null;
          try { botMember = await getBotChatMember(`@${parsed.username}`); } catch { botMember = null; }
          try { memberCount = await getChatMemberCount(refManagedChat(chatIdBig)); } catch { memberCount = null; }

          const upserted = await prisma.adminManagedChannel.upsert({
            where: { chatIdHmac: chatIdIndexKey(chatIdBig) },
            create: {
              deprecatedChatIdBig: chatIdBig,
              chatIdCiphertextB64: encryptChatIdAesGcm(chatIdBig),
              chatIdHmac: chatIdIndexKey(chatIdBig),
              chatType: chat.type,
              title: chat.title ?? null,
              username: chat.username ?? parsed.username,
              memberCount,
              avatarFileId: chat.photo?.smallFileId ?? null,
              isPrivate: !chat.username,
              publicUrl: `https://t.me/${chat.username || parsed.username}`,
              source: "manual_add",
              botIsAdmin: !!botMember?.isAdministrator,
              botCanPostMessages: !!botMember?.canPostMessages,
              botCanInviteUsers: !!botMember?.canInviteUsers,
              botCanRestrictMembers: !!botMember?.canRestrictMembers,
              lastDiscoveryUpdateType: "public_getChat",
              discoveryErrorCode: null,
              refreshedAt: new Date(),
            },
            update: {
              deprecatedChatIdBig: chatIdBig,
              chatIdCiphertextB64: encryptChatIdAesGcm(chatIdBig),
              chatType: chat.type,
              title: chat.title ?? null,
              username: chat.username ?? parsed.username,
              memberCount: memberCount ?? undefined,
              avatarFileId: chat.photo?.smallFileId ?? undefined,
              isPrivate: !chat.username,
              publicUrl: `https://t.me/${chat.username || parsed.username}`,
              source: "manual_add",
              botIsAdmin: !!botMember?.isAdministrator,
              botCanPostMessages: !!botMember?.canPostMessages,
              botCanInviteUsers: !!botMember?.canInviteUsers,
              botCanRestrictMembers: !!botMember?.canRestrictMembers,
              lastDiscoveryUpdateType: "public_getChat",
              discoveryErrorCode: null,
              refreshedAt: new Date(),
            },
            include: { package: { select: { id: true, title: true } } },
          });

          const bound = body.data.purpose && body.data.purpose !== "none"
            ? await assignManagedChannelPurpose(prisma, upserted, body.data.purpose, body.data.packageId ?? undefined)
            : upserted;

          const requestRow = await prisma.adminChannelDiscoveryRequest.create({
            data: {
              submittedLink: body.data.channelLink.trim(),
              normalizedLink: parsed.normalizedLink,
              linkType: parsed.linkType,
              status: body.data.purpose && body.data.purpose !== "none" ? "bound" : "discovered",
              requestedPurpose: body.data.purpose ?? "none",
              packageId: body.data.packageId ?? null,
              resolvedChannelId: upserted.id,
              submittedByAdminId: admin.adminId,
              discoveredAt: new Date(),
              boundAt: body.data.purpose && body.data.purpose !== "none" ? new Date() : null,
            },
            include: {
              package: { select: { id: true, title: true } },
              resolvedChannel: { select: { chatIdHmac: true, title: true } },
              submittedByAdmin: { select: { id: true, email: true, displayName: true } },
            },
          });

          await writeAudit(prisma, req, admin, {
            action: "admin.channel.discovery.submit",
            objectType: "channel_discovery_request",
            objectId: requestRow.id,
            reason: body.data.reason,
            afterValue: {
              mode: "public_verified",
              requestedPurpose: body.data.purpose ?? "none",
              packageId: body.data.packageId ?? null,
              resolvedChannelHmac: upserted.chatIdHmac,
            },
          });

          return reply.status(201).send({
            ok: true,
            mode: "public_verified",
            request: mapDiscoveryRow(requestRow),
            channel: mapManagedChannelRow(bound),
          });
        } catch (err: any) {
          const failed = await prisma.adminChannelDiscoveryRequest.create({
            data: {
              submittedLink: body.data.channelLink.trim(),
              normalizedLink: parsed.normalizedLink,
              linkType: parsed.linkType,
              status: "failed",
              requestedPurpose: body.data.purpose ?? "none",
              packageId: body.data.packageId ?? null,
              submittedByAdminId: admin.adminId,
              lastErrorCode: "public_getchat_failed",
              lastErrorNote: String(err?.message || err || "getChat failed").slice(0, 500),
            },
            include: {
              package: { select: { id: true, title: true } },
              resolvedChannel: { select: { chatIdHmac: true, title: true } },
              submittedByAdmin: { select: { id: true, email: true, displayName: true } },
            },
          });
          return reply.status(400).send({
            error: "public_channel_validate_failed",
            message: String(err?.message || err || "无法校验公开频道"),
            request: mapDiscoveryRow(failed),
          });
        }
      }

      const requestRow = await prisma.adminChannelDiscoveryRequest.create({
        data: {
          submittedLink: body.data.channelLink.trim(),
          normalizedLink: parsed.normalizedLink,
          linkType: parsed.linkType,
          status: "awaiting_bot_admin",
          requestedPurpose: body.data.purpose ?? "none",
          packageId: body.data.packageId ?? null,
          submittedByAdminId: admin.adminId,
          waitingSince: new Date(),
        },
        include: {
          package: { select: { id: true, title: true } },
          resolvedChannel: { select: { chatIdHmac: true, title: true } },
          submittedByAdmin: { select: { id: true, email: true, displayName: true } },
        },
      });

      await writeAudit(prisma, req, admin, {
        action: "admin.channel.discovery.submit",
        objectType: "channel_discovery_request",
        objectId: requestRow.id,
        reason: body.data.reason,
        afterValue: {
          mode: "awaiting_bot_admin",
          requestedPurpose: body.data.purpose ?? "none",
          packageId: body.data.packageId ?? null,
        },
      });

      return reply.status(201).send({
        ok: true,
        mode: "awaiting_bot_admin",
        request: mapDiscoveryRow(requestRow),
      });
    },
  );

  fastify.patch<{ Params: { hmac: string } }>(
    "/admin/channels/:hmac/purpose",
    { preHandler: [requireAdmin("channel:add")] },
    async (req, reply) => {
      const admin = (req as any).admin as AdminCtx;
      const hmac = String(req.params.hmac || "").trim();
      if (!/^[0-9a-f]{64}$/.test(hmac)) {
        return reply.status(400).send({ error: "bad_request", message: "hmac 必须是 64 hex" });
      }
      const body = bindPurposeSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });

      const existing = await prisma.adminManagedChannel.findUnique({
        where: { chatIdHmac: hmac },
        include: { package: { select: { id: true, title: true } } },
      });
      if (!existing) return reply.status(404).send({ error: "not_found", message: "频道不存在" });

      const updated = await assignManagedChannelPurpose(prisma, existing, body.data.purpose, body.data.packageId ?? undefined);
      await writeAudit(prisma, req, admin, {
        action: "admin.channel.bind_purpose",
        objectType: "managed_channel",
        objectId: `hmac:${hmac}`,
        reason: body.data.reason,
        beforeValue: { purpose: existing.purpose, packageId: existing.packageId ?? null },
        afterValue: { purpose: updated.purpose, packageId: updated.packageId ?? null },
      });
      return reply.send({ ok: true, channel: mapManagedChannelRow(updated) });
    },
  );

  fastify.post(
    "/admin/channels/refresh",
    { preHandler: [requireAdmin("channel:refresh")] },
    async (req, reply) => {
      const admin = (req as any).admin as AdminCtx;
      const body = refreshBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });

      const staleWhere = body.data.force
        ? {}
        : { OR: [{ refreshedAt: null }, { refreshedAt: { lt: new Date(Date.now() - FRESH_CACHE_MS) } }] };
      const rows = await prisma.adminManagedChannel.findMany({
        where: staleWhere,
        orderBy: [{ refreshedAt: "asc" }, { createdAt: "asc" }],
        take: 100,
        include: { package: { select: { id: true, title: true } } },
      });

      const refreshed: any[] = [];
      const errors: any[] = [];

      for (const row of rows) {
        const chatIdBig = resolveStoredChatId(row);
        if (!chatIdBig) {
          errors.push({ chatId: row.chatIdHmac, chatIdMasked: row.chatIdHmac ? `hmac:${String(row.chatIdHmac).slice(0, 8)}…` : "****", tgCode: null, errorClass: "missing_chat_id" });
          continue;
        }
        try {
          const chat = await getChat(refManagedChat(chatIdBig));
          let memberCount: number | null = null;
          let botMember: Awaited<ReturnType<typeof getBotChatMember>> | null = null;
          try { memberCount = await getChatMemberCount(refManagedChat(chatIdBig)); } catch { memberCount = null; }
          try { botMember = await getBotChatMember(refManagedChat(chatIdBig)); } catch { botMember = null; }
          const updated = await prisma.adminManagedChannel.update({
            where: { chatIdHmac: row.chatIdHmac },
            data: {
              chatType: chat.type,
              title: chat.title ?? undefined,
              username: chat.username ?? undefined,
              memberCount: memberCount ?? undefined,
              avatarFileId: chat.photo?.smallFileId ?? undefined,
              isPrivate: !chat.username,
              publicUrl: chat.username ? `https://t.me/${chat.username}` : row.publicUrl,
              botIsAdmin: !!botMember?.isAdministrator,
              botCanPostMessages: !!botMember?.canPostMessages,
              botCanInviteUsers: !!botMember?.canInviteUsers,
              botCanRestrictMembers: !!botMember?.canRestrictMembers,
              lastDiscoveryUpdateType: "admin_refresh",
              discoveryErrorCode: null,
              refreshedAt: new Date(),
            },
            include: { package: { select: { id: true, title: true } } },
          });
          refreshed.push(mapManagedChannelRow(updated));
        } catch (err: any) {
          errors.push({
            chatId: row.chatIdHmac,
            chatIdMasked: row.chatIdHmac ? `hmac:${String(row.chatIdHmac).slice(0, 8)}…` : "****",
            tgCode: null,
            errorClass: String(err?.message || err || "refresh_failed").slice(0, 128),
          });
        }
      }

      await writeAudit(prisma, req, admin, {
        action: "admin.channel.refresh",
        objectType: "managed_channel",
        objectId: `batch:${Date.now()}`,
        reason: body.data.reason,
        afterValue: { processed: rows.length, refreshed: refreshed.length, failed: errors.length, force: body.data.force === true },
      });

      return reply.send({
        ok: true,
        summary: {
          scannedFromUpdates: 0,
          processed: rows.length,
          refreshed: refreshed.length,
          failed: errors.length,
          fromCache: body.data.force ? 0 : Math.max(0, (await prisma.adminManagedChannel.count()) - rows.length),
        },
        refreshed,
        errors,
      });
    },
  );

  fastify.post<{ Params: { hmac: string } }>(
    "/admin/channels/:hmac/reveal-id",
    { preHandler: [requireAdmin("channel:reveal_id")] },
    async (req, reply) => {
      const admin = (req as any).admin as AdminCtx;
      const body = revealIdSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });
      const hmac = String(req.params.hmac || "").trim();
      if (!/^[0-9a-f]{64}$/.test(hmac)) return reply.status(400).send({ error: "bad_request", message: "参数必须是 64 hex chatIdHmac（严禁明文 chatId）" });
      const row = await prisma.adminManagedChannel.findUnique({ where: { chatIdHmac: hmac } });
      if (!row) return reply.status(404).send({ error: "not_found", message: "该频道未加入管理列表" });
      const plainBig = resolveStoredChatId(row);
      if (!plainBig) return reply.status(500).send({ error: "missing_chat_id", message: "频道缺少可解密 chatId" });

      const rawId = plainBig.toString();
      const expiresAt = new Date(Date.now() + REVEAL_TTL_MS);
      await writeAudit(prisma, req, admin, {
        action: "admin.channel.reveal_id",
        objectType: "managed_channel",
        objectId: `hmac:${hmac}`,
        reason: body.data.reason,
        afterValue: { revealTtlMs: REVEAL_TTL_MS, chatIdMasked: maskChatId(rawId) },
      });
      return reply.send({
        ok: true,
        chatIdHmac: hmac,
        chatIdMasked: maskChatId(rawId),
        reveal: {
          chatIdPlain: rawId,
          expiresAt: expiresAt.toISOString(),
          ttlMs: REVEAL_TTL_MS,
        },
      });
    },
  );
}
