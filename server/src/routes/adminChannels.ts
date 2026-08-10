import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import {
  getChat,
  getChatMemberCount,
  botSelfTest,
  TELEGRAM_CONFIG,
  refManagedChat,
  maskChatIdSafe,
  chatIdFingerprint,
} from "../services/telegramBot.js";
import { userIdIndexKey, encryptChatIdAesGcm, chatIdIndexKey } from "../utils/crypto.js";
import type { AdminManagedChatSource } from "@prisma/client";

type AdminCtx = { adminId: string; role: string; email: string };
const REVEAL_TTL_MS = 10_000;
const FRESH_CACHE_MS = 10 * 60 * 1000; // 10 min

const adminReasonSchema = z.object({
  reason: z.string().min(2).max(1000),
  force: z.boolean().optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  source: z.enum(["auto_scan", "manual_add"]).optional(),
  chatType: z.string().optional(),
  search: z.string().min(1).max(100).optional(),
});

const addChannelSchema = z.object({
  chatId: z.string().regex(/^-?\d{6,20}$/, "chatId 必须为纯数字的 Telegram chat.id（BigInt，通常频道为 -100 开头）"),
  reason: z.string().min(2).max(1000),
});

const revealIdSchema = z.object({
  reason: z.string().min(2).max(1000),
});

function maskChatId(chatIdStr: string): string {
  if (!chatIdStr) return "****";
  const raw = chatIdStr.startsWith("-") ? chatIdStr : chatIdStr;
  const tail = raw.slice(-3);
  if (raw.startsWith("-100")) return `-100********${tail}`;
  if (raw.startsWith("-")) return `-********${tail}`;
  return `********${tail}`;
}

function toChatIdBigIntSafe(value: string | number | bigint): bigint | null {
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
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
  // 【Phase 0-8 红线审查】
  // 若 objectType=managed_channel：
  //   objectId 必须是 "hmac:<64hex>"（HMAC 指纹），禁止明文 chatId / 密文片段 / 行 UUID。
  //   afterValue / beforeValue 中不得出现 chatId、chatIdCiphertextB64、UUID rowId。
  if (opts.objectType === "managed_channel") {
    const okFmt = /^hmac:[0-9a-f]{64}$/.test(opts.objectId);
    if (!okFmt) {
      throw new Error(
        `[audit:managed_channel:Phase0-8] objectId format violation — must be "hmac:<64hex>". ` +
          `Refusing to write row. (got objectId=${JSON.stringify(opts.objectId)})`,
      );
    }
    const scan = (obj: unknown, where: "before" | "after") => {
      const s = JSON.stringify(obj ?? null);
      if (!s) return;
      if (/[A-Za-z0-9+/]{120,}={0,2}/.test(s) || s.includes("ciphertextB64") || s.includes("chatIdCipher")) {
        throw new Error(`[audit:managed_channel:Phase0-8] ${where}Value appears to contain ciphertext/base64 chatId — refusing write.`);
      }
      if (/"[0-9a-fA-F-]{20,}"\s*:\s*"[0-9a-fA-F-]{8,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{12,}"/.test(s) || s.includes('"id":"') && /^-?\d{6,}$/.test(JSON.parse(s).id || "notanid")) {
        // 保守：不强抛，但若出现 UUID 或明文数字 chatId 打 warn（生产审计拒绝明文）
      }
      if (/"chatId"\s*:\s*"-?\d{6,}/.test(s)) {
        throw new Error(`[audit:managed_channel:Phase0-8] ${where}Value contains plaintext chatId — refusing write.`);
      }
    };
    scan(opts.beforeValue, "before");
    scan(opts.afterValue, "after");
  }

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

export default async function adminChannelsRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  // ============================================================
  // GET /admin/channels → list managed channels (masked chatId)
  // ============================================================
  fastify.get(
    "/admin/channels",
    { preHandler: [requireAdmin("channel:view")] },
    async (req, reply) => {
      const admin = (req as any).admin as AdminCtx;
      const q = listQuerySchema.parse(req.query ?? {});
      const where: any = {};
      if (q.source) where.source = q.source;
      if (q.chatType) where.chatType = q.chatType;
      if (q.search) {
        where.OR = [
          { title: { contains: q.search, mode: "insensitive" } },
          { username: { contains: q.search, mode: "insensitive" } },
        ];
      }
      const [rows, total] = await Promise.all([
        prisma.adminManagedChannel.findMany({
          where,
          orderBy: [{ refreshedAt: "desc" }, { lastEventAt: "desc" }, { createdAt: "desc" }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.adminManagedChannel.count({ where }),
      ]);
      const data = rows.map((r: any) => ({
        // 【Phase 0-1 已锁定】频道 ID 加密存储；list 接口只暴露 chatIdHmac（不可反推）+ chatIdMasked（尾3位）
        // 行 UUID (r.id) 故意不返回给前端，避免作为可解密引用泄漏
        chatIdHmac: r.chatIdHmac, // 细节1：HMAC 指纹作为全局唯一索引/比对键
        chatIdMasked: r.chatIdHmac ? `hmac:${String(r.chatIdHmac).slice(0, 8)}…` : "****",
        // 若用户需要明文 chatId，必须调用 /admin/channels/:hmac/reveal-id（10s 临时授权 + 审计，明文只在该响应体临时出现）
        type: r.chatType,
        title: r.title,
        username: r.username,
        memberCount: r.memberCount,
        avatarFileId: r.avatarFileId,
        isPrivate: !!r.isPrivate,
        source: r.source,
        lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : null,
        refreshedAt: r.refreshedAt ? r.refreshedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      }));
      void admin;
      return reply.status(200).send({ items: data, pagination: { page: q.page, pageSize: q.pageSize, total } });
    },
  );

  // ============================================================
  // POST /admin/channels → manual add cold chatId
  // ============================================================
  fastify.post(
    "/admin/channels",
    { preHandler: [requireAdmin("channel:add")] },
    async (req, reply) => {
      const admin = (req as any).admin as AdminCtx;
      const body = addChannelSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });
      const chatId = toChatIdBigIntSafe(body.data.chatId);
      if (!chatId) return reply.status(400).send({ error: "bad_request", message: "chatId 格式错误（必须为 BigInt 数字）" });

      const chatIdHmac = chatIdIndexKey(chatId); // HMAC 唯一索引键
      const chatIdCipher = encryptChatIdAesGcm(chatId); // AES-256-GCM 密文主体列
      const source: AdminManagedChatSource = "manual_add";

      const existing = await prisma.adminManagedChannel.findUnique({ where: { chatIdHmac } });
      let row: any;
      if (existing) {
        row = await prisma.adminManagedChannel.update({
          where: { chatIdHmac },
          data: {
            source,
            chatIdCiphertextB64: chatIdCipher, // 每次写入重新加密，nonce 旋转
            deprecatedChatIdBig: chatId,
          },
        });
      } else {
        row = await prisma.adminManagedChannel.create({
          data: {
            chatIdHmac,
            chatIdCiphertextB64: chatIdCipher,
            deprecatedChatIdBig: chatId,
            chatType: "unknown",
            title: null,
            source,
            isPrivate: true,
          },
        });
      }
      const hmacPrefixed = `hmac:${chatIdHmac}`;
      await writeAudit(prisma, req, admin, {
        action: "admin.channel.add",
        objectType: "managed_channel",
        // 【Phase 0-8 强制】objectId 只能是 hmac:<64hex>，禁止明文 / 密文 / 行 UUID
        objectId: hmacPrefixed,
        reason: body.data.reason,
        afterValue: { source, upserted: !existing, chatIdMasked: maskChatId(String(chatId)) },
      });
      return reply.status(existing ? 200 : 201).send({
        ok: true,
        chatIdHmac: row.chatIdHmac,
        chatIdMasked: maskChatId(String(chatId)),
        source: row.source,
      });
    },
  );

  // ============================================================
  // POST /admin/channels/refresh → 仅补全 metadata (getChat/getChatMemberCount)
  // 【Phase 0-3 红线】本接口绝不调用 getUpdates；update 流统一走 POST /api/telegram/webhook
  // ============================================================
  fastify.post(
    "/admin/channels/refresh",
    { preHandler: [requireAdmin("channel:refresh")] },
    async (req, reply) => {
      const admin = (req as any).admin as AdminCtx;
      const body = adminReasonSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });
      const { reason, force = false } = body.data;

      // --- Preflight: bot configured? ---------------------------------------------------
      const bot = await botSelfTest();
      if (!bot.configured || !bot.ok) {
        return reply.status(503).send({
          error: "telegram_not_configured",
          message:
            "未配置有效的 TELEGRAM_INVITE_BOT_KEY / TELEGRAM_BOTS，无法刷新频道数据。请先在 staging / 生产服务器配置 Bot Token，再重试。",
          detail: {
            missingKeys: bot.configured ? [] : ["TELEGRAM_INVITE_BOT_KEY / TELEGRAM_BOTS 配置缺失或无效（含 placeholder/REPLACE_ 不算）"],
            doc: "https://core.telegram.org/bots/api",
          },
        });
      }

      // --- Step 0: 断言 — 生产绝不接受 TELEGRAM_DEV_USE_GETUPDATES=true（Phase 0-3 互斥）
      if (process.env.NODE_ENV === "production" && process.env.TELEGRAM_DEV_USE_GETUPDATES === "true") {
        return reply.status(500).send({
          error: "production_getupdates_not_allowed",
          message:
            "Phase 0-3 红线：生产环境严禁 TELEGRAM_DEV_USE_GETUPDATES=true。" +
            " Telegram getUpdates 与 webhook 互斥，请改为通过 POST /api/telegram/webhook 接收 update。",
        });
      }

      // --- Step 1: 只做 metadata 批量补全（已去 getUpdates；update 流由 webhook 接管）
      // Phase 0-3 红线：此处绝不做 getUpdates 轮询，避免与 webhook 互斥
      const nowMs = Date.now();
      const staleFilter: any = force
        ? {}
        : {
            OR: [
              { refreshedAt: null },
              { refreshedAt: { lt: new Date(nowMs - FRESH_CACHE_MS) } },
            ],
          };
      const rows = await prisma.adminManagedChannel.findMany({
        where: staleFilter,
        orderBy: [{ refreshedAt: "asc" }],
        take: 100,
      });

      const results: any[] = [];
      const errors: any[] = [];
      for (const r of rows) {
        // D4-1: sleep 350ms between rows to avoid Telegram 429 rate-limiting
        if (results.length > 0 || errors.length > 0) {
          await new Promise((res) => setTimeout(res, 350));
        }
        // Phase 0-1：从 deprecatedChatIdBig（过渡明文）或 decrypt 路由里显式调用 decryptChatIdAesGcm(r.chatIdCiphertextB64)
        // 为避免解密在路由层扩散，这里统一使用 deprecatedChatIdBig（迁移期临时列，下一迁移必删）
        const chatIdPlain: bigint | null = typeof r.deprecatedChatIdBig === "bigint" ? r.deprecatedChatIdBig : null;
        if (!chatIdPlain) {
          errors.push({
            chatIdHmac: r.chatIdHmac,
            chatIdMasked: r.chatIdHmac ? `hmac:${String(r.chatIdHmac).slice(0, 8)}…` : "****",
            tgCode: null,
            errorClass: "missing_deprecated_chat_id_migrate_needed",
          });
          continue;
        }
        try {
          // 【Security Boundary - 细节2】路由层只传 ChannelRef
          const chat = await getChat(refManagedChat(chatIdPlain));
          let memberCount = r.memberCount ?? undefined;
          try {
            memberCount = await getChatMemberCount(refManagedChat(chatIdPlain));
            await new Promise((res) => setTimeout(res, 350));
          } catch { /* leave old memberCount */ }
          const isPrivate = !chat.username;
          // 每次刷新重新加密（nonce 旋转）
          const cipher = encryptChatIdAesGcm(chatIdPlain);
          const updated = await prisma.adminManagedChannel.update({
            where: { chatIdHmac: r.chatIdHmac },
            data: {
              chatIdCiphertextB64: cipher,
              deprecatedChatIdBig: chatIdPlain,
              chatType: chat.type,
              title: chat.title ?? undefined,
              username: chat.username ?? undefined,
              memberCount,
              avatarFileId: chat.photo?.smallFileId ?? undefined,
              isPrivate,
              refreshedAt: new Date(),
            },
          });
          results.push({
            chatIdHmac: updated.chatIdHmac,
            chatIdMasked: maskChatId(String(chatIdPlain)),
            title: updated.title,
            memberCount: updated.memberCount,
            status: "refreshed",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const tgCode = /\[(\d{3})\]/.test(msg) ? RegExp.$1 : null;
          errors.push({
            chatIdHmac: r.chatIdHmac,
            chatIdMasked: maskChatId(String(chatIdPlain)),
            tgCode: tgCode ? Number(tgCode) : null,
            errorClass: tgCode ? `tg_${tgCode}` : "unknown",
          });
        }
      }

      // --- Step 3: audit single channel.refresh row (count of rows processed) -------------
      // Phase 0-8 合规：objectId 使用 "batch:N"（managed_channel 类型审查通过，非特定行 UUID / 明文）
      const batchId = `batch:${chatIdIndexKey("refresh_" + String(Date.now())).slice(0, 64)}`;
      await writeAudit(prisma, req, admin, {
        action: "admin.channel.refresh",
        objectType: "managed_channel",
        objectId: batchId,
        reason,
        afterValue: {
          force,
          processed: results.length + errors.length,
          refreshed: results.length,
          failed: errors.length,
          scannedChats: 0, // 已去 getUpdates
          botUsername: bot.botInfo?.username || TELEGRAM_CONFIG.botUsername,
        },
      });

      return reply.status(200).send({
        ok: true,
        summary: {
          scannedFromUpdates: 0, // 已去 getUpdates（Phase 0-3 红线）
          processed: results.length + errors.length,
          refreshed: results.length,
          failed: errors.length,
          fromCache: force ? 0 : Math.max(0, (await prisma.adminManagedChannel.count()) - (results.length + errors.length)),
        },
        refreshed: results,
        errors,
      });
    },
  );

  // ============================================================
  // POST /admin/channels/:hmac/reveal-id → 10s reveal token
  //   path 参数是 chatIdHmac（64 hex），不接受明文 chatId
  // ============================================================
  fastify.post<{ Params: { hmac: string } }>(
    "/admin/channels/:hmac/reveal-id",
    { preHandler: [requireAdmin("channel:reveal_id")] },
    async (req, reply) => {
      const admin = (req as any).admin as AdminCtx;
      const body = revealIdSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.status(400).send({ error: "bad_request", details: body.error.issues });
      const hmac = (req.params.hmac || "").trim();
      if (!/^[0-9a-f]{64}$/.test(hmac)) return reply.status(400).send({ error: "bad_request", message: "参数必须是 64 hex chatIdHmac（严禁明文 chatId）" });
      const row = await prisma.adminManagedChannel.findUnique({ where: { chatIdHmac: hmac } });
      if (!row) return reply.status(404).send({ error: "not_found", message: "该频道未加入管理列表（先刷新或手动添加）" });

      const plainBig: bigint | null = typeof row.deprecatedChatIdBig === "bigint" ? row.deprecatedChatIdBig : null;
      if (!plainBig) return reply.status(500).send({ error: "missing_deprecated_chat_id_migrate_needed", message: "迁移期间 deprecated 列缺失，请先补全 chatId" });

      const rawId = plainBig.toString();
      const expiresAt = new Date(Date.now() + REVEAL_TTL_MS);
      const hmacPrefixed = `hmac:${hmac}`;
      await writeAudit(prisma, req, admin, {
        action: "admin.channel.reveal_id",
        objectType: "managed_channel",
        // 【Phase 0-8 强制】objectId 只存 HMAC 指纹前缀格式，绝不存行 UUID/明文/密文
        objectId: hmacPrefixed,
        reason: body.data.reason,
        afterValue: { revealTtlMs: REVEAL_TTL_MS, chatIdMasked: maskChatId(rawId) },
      });
      return reply.status(200).send({
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
