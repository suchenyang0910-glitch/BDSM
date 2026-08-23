import type { FastifyInstance } from "fastify";
import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const H5_LOGIN_AUTH_MAX_AGE_SEC = 10 * 60;
const H5_LOGIN_MIN_AUTH_TS_SEC = Math.floor(Date.now() / 1000) - 60 * 60;

const H5_DEVICE_TOKEN_BYTES = 32;
const H5_DEVICE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const H5_DEVICE_SESSION_COOKIE_NAME = "h5_device_token";
const H5_DEVICE_SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

function constantTimeHexEqual(a: string, b: string): boolean {
  try {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return timingSafeEqual(ab, bb);
  } catch (_) {
    return false;
  }
}

function verifyTelegramLoginHash(params: Record<string, string>, botToken: string): { ok: true } | { ok: false; reason: string } {
  if (!botToken) return { ok: false, reason: "h5_login_missing_bot_token" };
  const hash = params.hash;
  if (!hash || typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) {
    return { ok: false, reason: "h5_login_invalid_hash" };
  }
  const id = params.id;
  if (!id || !/^\d+$/.test(id)) return { ok: false, reason: "h5_login_invalid_id" };
  const authDateRaw = params.auth_date;
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) return { ok: false, reason: "h5_login_invalid_auth_date" };
  const authDate = Number(authDateRaw);
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 120) return { ok: false, reason: "h5_login_auth_clock_skew" };
  if (authDate < now - H5_LOGIN_AUTH_MAX_AGE_SEC) return { ok: false, reason: "h5_login_auth_expired" };
  if (authDate < H5_LOGIN_MIN_AUTH_TS_SEC) return { ok: false, reason: "h5_login_auth_too_old" };

  const keys = Object.keys(params).filter((k) => k !== "hash").sort();
  const dataCheckString = keys.map((k) => `${k}=${params[k]}`).join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex").toLowerCase();
  if (!constantTimeHexEqual(expected, String(hash).toLowerCase())) {
    return { ok: false, reason: "h5_login_invalid_hash" };
  }
  return { ok: true };
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function randomHexToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function randomH5DisplayName(): string {
  return `同频用户 ${randomBytes(3).toString("hex").toUpperCase()}`;
}

function isLegacyH5DisplayName(value: string | null | undefined): boolean {
  return value === "同频账户" || value === "访客用户" || value === "本机账户";
}

function setDeviceCookie(reply: any, token: string, maxAgeMs: number, secure: boolean) {
  const parts = [
    `${H5_DEVICE_SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    `SameSite=Lax`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

function clearDeviceCookie(reply: any, secure: boolean) {
  const parts = [
    `${H5_DEVICE_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=Lax`,
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

function readDeviceToken(req: any): string | null {
  const header: string | undefined = (req.headers as any)?.cookie;
  if (!header) return null;
  const segs = header.split(";");
  for (const seg of segs) {
    const s = seg.trim();
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    if (k === H5_DEVICE_SESSION_COOKIE_NAME && v.length > 0) return v;
  }
  return null;
}

async function resolveMergedUserId(prisma: any, startId: string): Promise<{ finalUserId: string; mergedCount: number }> {
  const visited = new Set<string>();
  let cur = startId;
  let merged = 0;
  for (let i = 0; i < 8; i++) {
    if (visited.has(cur)) break;
    visited.add(cur);
    const row = await prisma.user.findUnique({ where: { id: cur }, select: { id: true, mergedIntoUserId: true, telegramUserId: true } });
    if (!row) break;
    if (!row.mergedIntoUserId) return { finalUserId: row.id, mergedCount: merged };
    merged++;
    cur = row.mergedIntoUserId;
  }
  return { finalUserId: startId, mergedCount: 0 };
}

async function getDeviceSession(prisma: any, token: string) {
  const hash = sha256Hex(token);
  const row = await prisma.h5DeviceSession.findUnique({ where: { tokenHash: hash } });
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() < now) return null;
  if (now - row.lastUsedAt.getTime() > H5_DEVICE_SESSION_IDLE_MS) return null;
  return { row, tokenHash: hash };
}

export default async function authH5Routes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;
  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  const SECURE_COOKIE = process.env.NODE_ENV === "production";

  function normalizeRedirect(req: any, raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0) return null;
    if (raw.length > 1024) return null;
    if (raw.startsWith("//")) return null;
    if (raw.startsWith("/") && !raw.startsWith("//")) {
      if (/^\/[a-zA-Z0-9_\-/.%?=&@#+,:;()!~*'\[\]]*$/.test(raw)) return raw;
      return null;
    }
    try {
      const reqProto = (req.headers?.["x-forwarded-proto"] as string | undefined) || "https";
      const reqHost = (req.headers?.host as string | undefined) || (req.hostname as string) || null;
      if (!reqHost) return null;
      const u = new URL(raw, `${Array.isArray(reqProto) ? reqProto[0] : reqProto}://${reqHost}`);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      const baseHostname = new URL(`${Array.isArray(reqProto) ? reqProto[0] : reqProto}://${reqHost}`).hostname;
      if (u.hostname.toLowerCase() !== baseHostname.toLowerCase()) return null;
      return u.toString();
    } catch (_) {
      return null;
    }
  }

  function appendRedirectTo(base: string, redirect: string | null): string {
    if (!redirect) return base;
    const q = base.includes("?") ? "&" : "?";
    return `${base}${q}redirect=${encodeURIComponent(redirect)}`;
  }

  function successRedirect(redirect: string | null): string {
    if (!redirect) return "/h5-pay.html?login=success";
    const hasLoginQs = /[\?&]login=success(?:&|#|$)/.test(redirect);
    const hashIdx = redirect.indexOf("#");
    const pure = hashIdx >= 0 ? redirect.slice(0, hashIdx) : redirect;
    const frag = hashIdx >= 0 ? redirect.slice(hashIdx) : "";
    const append = hasLoginQs ? "" : (pure.includes("?") ? "&login=success" : "?login=success");
    return `${pure}${append}${frag}`;
  }

  function emitSafety(ev: any, err?: Error) {
    try {
      const mod = (fastify as any).structuredError;
      if (mod?.emitSafetyEvent) mod.emitSafetyEvent(ev, err);
      else (fastify as any).log?.warn?.("[auth-h5:safety] event", ev);
    } catch {
      // ignore
    }
  }

  function ipOf(req: any): string | null {
    const fwd = req.headers?.["x-forwarded-for"];
    if (fwd) {
      const s = Array.isArray(fwd) ? String(fwd[0]) : String(fwd);
      return s.split(",")[0]?.trim().slice(0, 45) || null;
    }
    return req.ip ? String(req.ip).slice(0, 45) : null;
  }

  function uaOf(req: any): string | null {
    const v = req.headers?.["user-agent"];
    if (!v) return null;
    return String(v).slice(0, 512);
  }

  // ============================================================
  // P0-7-A #1: POST /auth/h5/guest-session — 首次 H5 访问创建匿名访客会话
  // ============================================================
  fastify.post("/auth/h5/guest-session", async (req, reply) => {
    try {
      const existingToken = readDeviceToken(req);
      if (existingToken) {
        const sess = await getDeviceSession(prisma, existingToken);
        if (sess?.row) {
          const { finalUserId } = await resolveMergedUserId(prisma, sess.row.userId);
          const user = await prisma.user.findUnique({
            where: { id: finalUserId },
            select: { id: true, telegramUserId: true, displayName: true },
          });
          if (user) {
            const bound = !!user.telegramUserId;
            const displayName = !bound && isLegacyH5DisplayName(user.displayName)
              ? (await prisma.user.update({ where: { id: user.id }, data: { displayName: randomH5DisplayName() } })).displayName
              : user.displayName;
            return reply.status(200).send({
              identity: bound ? "telegram" : "guest",
              userId: user.id,
              telegramBound: bound,
              displayName,
              expiresAt: sess.row.expiresAt.toISOString(),
            });
          }
        }
      }

      const newToken = randomHexToken(H5_DEVICE_TOKEN_BYTES);
      const tokenHash = sha256Hex(newToken);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + H5_DEVICE_SESSION_MAX_AGE_MS);

      let anon;
      try {
        anon = await prisma.user.create({
          data: {
            telegramUserId: null,
            username: null,
            displayName: randomH5DisplayName(),
            photoUrl: null,
            status: "active",
          },
        });
      } catch (e: any) {
        emitSafety({ event: "auth_h5_guest_create_user_failed", errorClass: "db_error", note: `len=${e?.message?.length || 0}` }, e);
        return reply.status(500).send({ error: "auth_h5_guest_unavailable", userError: "自动登录创建失败，请稍后重试。" });
      }

      try {
        await prisma.h5DeviceSession.create({
          data: {
            tokenHash,
            userId: anon.id,
            expiresAt,
            lastUsedAt: now,
            createdAt: now,
            createdIp: ipOf(req),
            userAgent: uaOf(req),
          },
        });
      } catch (e: any) {
        emitSafety({ event: "auth_h5_guest_session_conflict", errorClass: "db_error", note: `len=${e?.message?.length || 0}` }, e);
        return reply.status(500).send({ error: "auth_h5_guest_session_conflict", userError: "自动登录创建冲突，请刷新重试。" });
      }

      setDeviceCookie(reply, newToken, H5_DEVICE_SESSION_MAX_AGE_MS, SECURE_COOKIE);

      const sessFastify = (req.session as any) || {};
      sessFastify.userId = anon.id;
      sessFastify.telegramUserId = null;
      try { await (req.session as any)?.save?.(); } catch (_) {}

      return reply.status(200).send({
        identity: "guest",
        userId: anon.id,
        telegramBound: false,
        displayName: anon.displayName,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (e: any) {
      emitSafety({ event: "auth_h5_guest_session_fatal", errorClass: "server_error", note: `len=${e?.message?.length || 0}` }, e);
      return reply.status(500).send({ error: "auth_h5_guest_internal", userError: "系统异常，请稍后重试。" });
    }
  });

  // ============================================================
  // P0-7-A #2: GET /auth/h5/session — 自动恢复当前访客或 Telegram 用户
  // ============================================================
  fastify.get("/auth/h5/session", async (req, reply) => {
    try {
      const token = readDeviceToken(req);
      if (!token) {
        return reply.status(401).send({ identity: null, telegramBound: false, error: "auth_h5_session_none" });
      }
      const sess = await getDeviceSession(prisma, token);
      if (!sess?.row) {
        clearDeviceCookie(reply, SECURE_COOKIE);
        return reply.status(401).send({ identity: null, telegramBound: false, error: "auth_h5_session_expired" });
      }
      const { finalUserId } = await resolveMergedUserId(prisma, sess.row.userId);
      if (finalUserId !== sess.row.userId) {
        try {
          await prisma.h5DeviceSession.update({
            where: { tokenHash: sess.tokenHash },
            data: { userId: finalUserId, lastUsedAt: new Date() },
          });
        } catch (_) { /* ignore */ }
      } else {
        try {
          await prisma.h5DeviceSession.update({
            where: { tokenHash: sess.tokenHash },
            data: { lastUsedAt: new Date() },
          });
        } catch (_) { /* ignore */ }
      }
      const user = await prisma.user.findUnique({
        where: { id: finalUserId },
        select: { id: true, telegramUserId: true, displayName: true, status: true },
      });
      if (!user || user.status === "deleted") {
        clearDeviceCookie(reply, SECURE_COOKIE);
        return reply.status(401).send({ identity: null, telegramBound: false, error: "auth_h5_user_deleted" });
      }
      const bound = !!user.telegramUserId;
      const displayName = !bound && isLegacyH5DisplayName(user.displayName)
        ? (await prisma.user.update({ where: { id: user.id }, data: { displayName: randomH5DisplayName() } })).displayName
        : user.displayName;
      const sfSess = (req.session as any) || {};
      sfSess.userId = finalUserId;
      sfSess.telegramUserId = user.telegramUserId ? String(user.telegramUserId) : null;
      try { await (req.session as any)?.save?.(); } catch (_) {}
      return reply.status(200).send({
        identity: bound ? "telegram" : "guest",
        userId: finalUserId,
        telegramBound: bound,
        displayName,
        expiresAt: sess.row.expiresAt.toISOString(),
      });
    } catch (e: any) {
      emitSafety({ event: "auth_h5_session_read_failed", errorClass: "db_error", note: `len=${e?.message?.length || 0}` }, e);
      return reply.status(500).send({ error: "auth_h5_session_internal", userError: "会话读取失败，请稍后重试。" });
    }
  });

  // ============================================================
  // P0-7-A #3: GET /auth/h5/telegram/callback — 绑定 Telegram + 同事务合并匿名访客
  // ============================================================
  fastify.get("/auth/h5/telegram/callback", async (req, reply) => {
    const rawQuery = (req.query || {}) as Record<string, string | undefined>;
    const params: Record<string, string> = {};
    for (const k of Object.keys(rawQuery)) {
      const v = rawQuery[k];
      if (typeof v === "string" && v.length > 0) params[k] = v;
    }
    const reqRedirect = normalizeRedirect(req, rawQuery.redirect ?? null);

    if (!botToken) {
      return reply.status(302).redirect(appendRedirectTo("/login.html?error=h5_login_missing_bot_token", reqRedirect));
    }

    const verify = verifyTelegramLoginHash(params, botToken);
    if (!verify.ok) {
      (fastify as any).log?.warn?.("[auth-h5] telegram login hash invalid", { reason: verify.reason, id: params.id || "unknown" });
      return reply
        .status(302)
        .redirect(appendRedirectTo(`/login.html?error=${encodeURIComponent(verify.reason)}`, reqRedirect));
    }

    const tgUserIdStr = params.id!;
    const tgUserId = BigInt(tgUserIdStr);
    const username = params.username || null;
    const firstName = params.first_name || "";
    const lastName = params.last_name || "";
    const displayName = `${firstName} ${lastName}`.trim() || `Telegram 用户 ${tgUserIdStr}`;
    const photoUrl = params.photo_url || null;

    let targetUser;
    try {
      targetUser = await prisma.user.findUnique({ where: { telegramUserId: tgUserId } });
      if (!targetUser) {
        targetUser = await prisma.user.create({
          data: {
            telegramUserId: tgUserId,
            username,
            displayName,
            photoUrl,
            status: "active",
          },
        });
      } else {
        const changed =
          (username ?? null) !== (targetUser.username ?? null) ||
          displayName !== targetUser.displayName ||
          (photoUrl ?? null) !== (targetUser.photoUrl ?? null);
        if (changed) {
          targetUser = await prisma.user.update({
            where: { id: targetUser.id },
            data: { username, displayName, photoUrl },
          });
        }
      }
    } catch (e: any) {
      (fastify as any).log?.error?.("[auth-h5] upsert user failed", {
        prismaCode: e?.code || null,
        id: tgUserIdStr,
      });
      return reply
        .status(302)
        .redirect(appendRedirectTo("/login.html?error=h5_login_internal_error", reqRedirect));
    }

    // =============== 合并匿名访客（同事务）===============
    const token = readDeviceToken(req);
    let deviceTokenHash: string | null = token ? sha256Hex(token) : null;
    let guestUserIdToMerge: string | null = null;
    if (token) {
      const sess = await getDeviceSession(prisma, token);
      if (sess?.row?.userId) {
        try {
          const gu = await prisma.user.findUnique({
            where: { id: sess.row.userId },
            select: { id: true, telegramUserId: true, mergedIntoUserId: true },
          });
          if (gu && !gu.telegramUserId && gu.id !== targetUser.id && !gu.mergedIntoUserId) {
            guestUserIdToMerge = gu.id;
          }
        } catch (_) { /* ignore */ }
      }
    }

    if (guestUserIdToMerge) {
      const guestId = guestUserIdToMerge;
      const targetId = targetUser.id;
      try {
        await prisma.$transaction(async (tx: any) => {
          await tx.order.updateMany({ where: { userId: guestId }, data: { userId: targetId } });
          await tx.entitlement.updateMany({ where: { userId: guestId }, data: { userId: targetId } });
          await tx.telegramInvite.updateMany({ where: { userId: guestId }, data: { userId: targetId } });
          await tx.supportTicket.updateMany({ where: { userId: guestId }, data: { userId: targetId } });
          await tx.ticketEvent.updateMany({ where: { authorUserId: guestId }, data: { authorUserId: targetId } });
          await tx.h5DeviceSession.updateMany({ where: { userId: guestId }, data: { userId: targetId } });
          await tx.user.update({
            where: { id: guestId },
            data: { mergedIntoUserId: targetId, status: "deleted", displayName: { set: "(已合并至 Telegram) " + (targetUser.displayName || "") } },
          });
        });
      } catch (e: any) {
        emitSafety({ event: "auth_h5_merge_transaction_failed", errorClass: "db_error", note: `guest=${guestId.slice(0, 8)} target=${targetId.slice(0, 8)} len=${e?.message?.length || 0}` }, e);
        return reply.status(302).redirect(appendRedirectTo("/login.html?error=h5_login_merge_failed", reqRedirect));
      }
    }

    if (deviceTokenHash) {
      try {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + H5_DEVICE_SESSION_MAX_AGE_MS);
        await prisma.h5DeviceSession.upsert({
          where: { tokenHash: deviceTokenHash },
          create: {
            tokenHash: deviceTokenHash,
            userId: targetUser.id,
            expiresAt,
            lastUsedAt: now,
            createdAt: now,
            createdIp: ipOf(req),
            userAgent: uaOf(req),
          },
          update: {
            userId: targetUser.id,
            lastUsedAt: now,
            expiresAt,
          },
        });
      } catch (_) { /* ignore */ }
    }

    const sfSess = (req.session as any) || {};
    sfSess.userId = targetUser.id;
    sfSess.telegramUserId = targetUser.telegramUserId ? targetUser.telegramUserId.toString() : null;
    try { await (req.session as any)?.save?.(); } catch (_) {}

    return reply.status(302).redirect(successRedirect(reqRedirect));
  });

  // ============================================================
  // P0-7-A #4: POST /auth/h5/logout — 仅清设备会话（不删用户）
  // ============================================================
  fastify.post("/auth/h5/logout", async (req, reply) => {
    try {
      const token = readDeviceToken(req);
      if (token) {
        const hash = sha256Hex(token);
        try { await prisma.h5DeviceSession.delete({ where: { tokenHash: hash } }); } catch (_) { /* ignore */ }
      }
      clearDeviceCookie(reply, SECURE_COOKIE);
      const sf = (req.session as any) || {};
      sf.userId = null;
      sf.telegramUserId = null;
      try { await (req.session as any)?.destroy?.(); } catch (_) {
        try { await (req.session as any)?.save?.(); } catch (_) {}
      }
      return reply.status(200).send({ ok: true });
    } catch (e: any) {
      emitSafety({ event: "auth_h5_logout_failed", errorClass: "server_error", note: `len=${e?.message?.length || 0}` }, e);
      clearDeviceCookie(reply, SECURE_COOKIE);
      return reply.status(200).send({ ok: true });
    }
  });
}
