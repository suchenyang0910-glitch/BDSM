import fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import url from "node:url";
import { PrismaClient, type AdminUser } from "@prisma/client";
import bcrypt from "bcryptjs";
import telegramRoutes from "./routes/telegram.js";
import telegramWebhookRoutes from "./routes/telegramWebhook.js";
import homeRoutes from "./routes/home.js";
import contentRoutes from "./routes/contents.js";
import resourceRoutes from "./routes/resources.js";
import orderRoutes from "./routes/orders.js";
import usdtInternalRoutes from "./routes/usdtInternal.js";
import adminRoutes from "./routes/admin.js";
import adminCmsRoutes, { adminPackageRoutes } from "./routes/adminCms.js";
import adminUsersAndSupportRoutes from "./routes/adminUsersAndSupport.js";
import adminChannelsRoutes from "./routes/adminChannels.js";
import adminDashboardRoutes from "./routes/adminDashboard.js";
import authH5Routes from "./routes/authH5.js";
import analyticsAndPreferenceRoutes from "./routes/analyticsPreferences.js";
import adminFinanceRoutes from "./routes/adminFinance.js";
import trafficEntryRoutes from "./routes/trafficEntries.js";
import campaignRoutes from "./routes/campaigns.js";
import watchProgressRoutes from "./routes/watchProgress.js";
import playbackRoutes from "./routes/playback.js";
import playbackMediaRoutes from "./routes/playbackMedia.js";
import publicSeoRoutes from "./routes/publicSeo.js";
import articleRoutes from "./routes/articles.js";
import adminArticleRoutes from "./routes/adminArticles.js";
import { botSelfTest, TELEGRAM_CONFIG } from "./services/telegramBot.js";
import { startEntitlementsCron } from "./services/entitlementsCron.js";
import { startUploadSessionCleanupCron } from "./services/uploadSessionCleanup.js";
import { releaseExpiredUsdtAddresses } from "./services/usdtPool.js";
import {
  assertRequiredSecretsOrThrow,
  collectRequiredSecretProblems,
} from "./utils/crypto.js";
import { emitSafetyEvent, emitStructuredLog } from "./utils/structuredError.js";
import { assertObjectStorageConfiguredOnStartup } from "./services/objectStorage.js";
import { loadPlaybackConfig } from "./services/playbackConfig.js";

/**
 * 【P0-B 红线】Prisma 自带的默认 log 模式会把原始 SQL/Pxxxx clientVersion 写到 stderr/stdout。
 * 必须显式为每个级别配置 emit: "event"，$on 钩子才会收到事件；再由安全事件通道统一输出，完全禁止 Prisma 自己直接打印。
 * 注意：① 不配置 log 数组时，$on('error'/'warn') 不会触发；② 传字符串数组（如 ["error","warn"]）= 直接 console.* 打印原始内容，禁止。
 */
export const prisma = new PrismaClient({
  errorFormat: "minimal",
  log: [
    { level: "error", emit: "event" },
    { level: "warn",  emit: "event" },
    { level: "info",  emit: "event" },
  ],
});
// Prisma → 安全事件通道：仅提取 Pxxxx；message/target/clientVersion/SQL 一律进入加密保留期外的字段
(prisma as any).$on?.("error", (ev: any) => {
  emitSafetyEvent(
    { event: "prisma_runtime_error", errorClass: "db_error", note: "prisma_or_query_engine_event" },
    ev,
  );
});
(prisma as any).$on?.("warn", (ev: any) => {
  emitSafetyEvent(
    { event: "prisma_runtime_warn", errorClass: "db_error", retryHint: 0, note: "prisma_or_query_engine_warn" },
    ev,
  );
});
(prisma as any).$on?.("info", (ev: any) => {
  emitStructuredLog({
    event: "prisma_runtime_info",
    errorClass: "business",
    retryHint: 0,
    note: "prisma_or_query_engine_info",
  });
});

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..", "..");

const PORT = Number(process.env.SERVER_PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PRODUCTION ? "" : "development-only-session-secret-change-me-32chars");
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "").split(",").map((value) => value.trim()).filter(Boolean);

const DEFAULT_ADMIN_PASSWORDS = Object.freeze(["ChangeMeSuperAdmin!123", "ChangeMeOperator!456"]);
export async function selfCheckDefaultAdminPasswords(prisma: PrismaClient): Promise<void> {
  if (!IS_PRODUCTION) {
    const devCount = await prisma.adminUser.count();
    if (devCount > 0) return;
    console.warn("[intune-server:admin-passwords] (dev) no admin users yet — skip default pw self-check.");
    return;
  }
  const admins = await prisma.adminUser.findMany({
    where: { status: "active" },
    select: { id: true, email: true, role: true, passwordHash: true },
  });
  if (admins.length === 0) {
    throw new Error("[intune-server:admin-passwords] FATAL (production): no active admin users found in DB — abort.");
  }
  const hits: Array<Pick<AdminUser, "email" | "role">> = [];
  for (const a of admins) {
    for (const pw of DEFAULT_ADMIN_PASSWORDS) {
      const ok = await bcrypt.compare(pw, a.passwordHash);
      if (ok) { hits.push({ email: a.email, role: a.role }); break; }
    }
  }
  if (hits.length > 0) {
    const summary = hits.map(h => `${h.email}(${h.role})`).join(", ");
    throw new Error(
      "[intune-server:admin-passwords] FATAL (production): still using DEFAULT seed admin passwords — ABORTING STARTUP.\n" +
      "Affected accounts: " + summary + "\n" +
      "Fix via admin reset-password SQL / prisma studio, then restart server. Use strong unique passwords; " +
      "references: SEED_SUPERADMIN_PASSWORD / SEED_OPERATOR_PASSWORD must be set BEFORE prisma:seed runs in production.",
    );
  }
  console.log(`[intune-server:admin-passwords] ✅ ${admins.length} active admin users — no default seed password reuse.`);
}

async function main() {
  // ============================================================
  // 【Phase 0-2 已锁定】启动期必填密钥断言（最先执行，未通过直接 crash）
  // - CRYPTO_HMAC_SECRET / CRYPTO_CHAT_ID_AES_KEY 独立且长度合规
  // - 禁止与 Bot Token 复用；禁止 production TELEGRAM_DEV_USE_GETUPDATES=true
  // ============================================================
  {
    const probs = collectRequiredSecretProblems();
    if (!probs.ok) {
      const lines = probs.missing.map((m) => `  - ${m.name}: ${m.reason}`).join("\n");
      // 在 listen 前直接 throw；NODE_ENV=test 仅 warn（单元/CI 允许 env 不全）
      if (process.env.NODE_ENV === "test") {
        console.warn("[crypto:assertRequiredSecrets] (NODE_ENV=test) 以下密钥未达标（warn-only，不阻断测试）:\n" + lines);
      } else {
        assertRequiredSecretsOrThrow();
      }
    } else {
      console.log("[crypto:assertRequiredSecrets] ✅ all required secrets validated (HMAC/AES/JWT/DB + Bot rules).");
    }
  }

  {
    const shouldCheckObjectStorage =
      (process.env.VIDEO_DELIVERY_MODE && process.env.VIDEO_DELIVERY_MODE !== "disabled") ||
      process.env.OBJECT_STORAGE_ENDPOINT ||
      process.env.S3_ENDPOINT;
    if (shouldCheckObjectStorage) {
      try {
        assertObjectStorageConfiguredOnStartup();
        console.log("[object-storage] ✅ object storage configuration validated.");
      } catch (error) {
        if (process.env.NODE_ENV === "test") {
          console.warn("[object-storage] (NODE_ENV=test) object storage configuration missing or invalid.");
        } else {
          throw error;
        }
      }
    }
  }

  if (!SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be configured in production");
  }
  const app = fastify({
    logger: process.env.NODE_ENV !== "production",
    trustProxy: true,
  });
  const playbackConfig = loadPlaybackConfig(process.env);

  await app.register(cors, {
    // 空值代表同源部署；跨域时必须明确配置 HTTPS 来源，不能使用 * + Cookie。
    origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : false,
    credentials: CORS_ORIGINS.length > 0,
    allowedHeaders: ["Content-Type", "Cookie"],
  });

  await app.register(cookie);
  await app.register(session, {
    secret: SESSION_SECRET,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  });

  app.decorate("prisma", prisma);
  app.decorate("playbackConfig", playbackConfig as any);
  (app as any).prisma = prisma; // 给 webhook 路由使用 (fastify as any).prisma 模式
  app.decorateRequest("userId", null);
  app.decorateRequest("telegramUserId", null);

  app.addHook("preHandler", async (req, _res) => {
    const session = req.session as any;
    if (session?.userId) {
      (req as any).userId = session.userId;
      (req as any).telegramUserId = session.telegramUserId;
    }
  });

  app.get("/healthz", async () => ({ ok: true, ts: new Date().toISOString() }));
  // ============================================================
  // 【Phase 0-7 已锁定】getWebhookInfo 分级健康检查：
  // - 启动期：只写 warn，不 crash
  // - 发布期 Gate：CD 额外脚本显式调用 /healthz/telegram-webhook 检查
  // - 运行期：/readiness 端点 3 次连续失败 -> readiness=false；运维告警
  // ============================================================
  let readinessWebhookOk = true;
  let readinessWebhookConsecutiveFails = 0;
  let lastWebhookCheck = { ts: 0 as number, ok: false, reason: "not_checked_yet" as string, url: null as string | null };

  app.get("/healthz/telegram-webhook", async (_req, reply) => {
    try {
      const bot = await botSelfTest();
      if (!bot.configured) {
        lastWebhookCheck = { ts: Date.now(), ok: false, reason: "bot_not_configured", url: null };
        return reply.status(200).send({ ok: false, mode: bot.configured ? "unknown" : "no_bot", reason: "bot_not_configured", url: null, ts: new Date().toISOString() });
      }
      // 这里不直接 getWebhookInfo（botSelfTest 已做基础检查）；实际生产发布 Gate 脚本会用自有 token 调 Telegram
      lastWebhookCheck = { ts: Date.now(), ok: bot.ok, reason: bot.ok ? "bot_configured_self_test_ok" : "bot_self_test_failed", url: null };
      return reply.status(200).send({ ok: bot.ok, mode: bot.ok ? "self_test_ok_webhook_check_via_gate_script" : "bot_self_test_failed", reason: lastWebhookCheck.reason, url: null, ts: new Date().toISOString() });
    } catch (e: any) {
      lastWebhookCheck = { ts: Date.now(), ok: false, reason: "exception", url: null };
      return reply.status(500).send({ ok: false, reason: "exception_" + (e?.code || "unknown"), ts: new Date().toISOString() });
    }
  });

  app.get("/readiness", async (_req, reply) => {
    // 3 次连续失败则 readiness=false
    const base = { ts: new Date().toISOString() };
    if (!readinessWebhookOk || readinessWebhookConsecutiveFails >= 3) {
      return reply.status(503).send({ ok: false, ...base, telegram: { ok: lastWebhookCheck.ok, reason: lastWebhookCheck.reason, consecutiveFails: readinessWebhookConsecutiveFails, lastCheckMs: Date.now() - lastWebhookCheck.ts } });
    }
    return reply.status(200).send({ ok: true, ...base, telegram: { ok: true, lastCheckMs: Date.now() - lastWebhookCheck.ts } });
  });

  function getRawRequestQuery(req: any): string {
    const rawUrl = typeof req?.raw?.url === "string" ? req.raw.url : "";
    const queryIndex = rawUrl.indexOf("?");
    return queryIndex >= 0 ? rawUrl.slice(queryIndex) : "";
  }

  function buildAliasRedirect(targetPath: string, req: any): string {
    return `${targetPath}${getRawRequestQuery(req)}`;
  }

  function getRedirectFromRawRequest(req: any): string {
    const rawQuery = getRawRequestQuery(req);
    if (!rawQuery) return "";
    const parts = rawQuery.slice(1).split("&");
    const redirectIndex = parts.findIndex((part) => part.startsWith("redirect="));
    if (redirectIndex < 0) return "";
    const rawValue = parts.slice(redirectIndex).join("&").slice("redirect=".length);
    const redirectTo = rawValue.trim();
    if (!redirectTo) return "";
    if (redirectTo.startsWith("/")) return redirectTo;
    if (/^%2f/i.test(redirectTo)) {
      try {
        return decodeURIComponent(redirectTo).trim();
      } catch {
        return redirectTo;
      }
    }
    return redirectTo;
  }

  if (process.env.NODE_ENV === "development") {
    const DEV_DEMO_TOKEN = process.env.DEV_DEMO_TOKEN || "intune-dev-only";
    app.log.warn(`[DEV-ONLY] registering /api/__demo/* routes. DEV_DEMO_TOKEN length=${DEV_DEMO_TOKEN.length}`);
    app.get("/api/__demo/login/:userId", async (req, reply) => {
      const { userId } = (req.params || {}) as { userId: string };
      const query = (req.query || {}) as { token?: string; redirect?: string };
      const tokenHeader = (req.headers as any)["x-demo-token"];
      const token = typeof tokenHeader === "string" && tokenHeader
        ? tokenHeader
        : (typeof query.token === "string" ? query.token : "");
      if (!token || token !== DEV_DEMO_TOKEN) {
        return reply.status(403).header("x-dev-only", "demo-login").send({ error: "x-demo-token missing or invalid (development only)" });
      }
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, telegramUserId: true } });
      if (!user) return reply.status(404).header("x-dev-only", "demo-login").send({ error: "user not found" });
      const sess = req.session as any;
      sess.userId = user.id;
      sess.telegramUserId = user.telegramUserId ? user.telegramUserId.toString() : null;
      const redirectTo = getRedirectFromRawRequest(req) || (typeof query.redirect === "string" ? query.redirect.trim() : "");
      if (redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("//")) {
        return reply.header("x-dev-only", "demo-login").code(302).redirect(redirectTo);
      }
      return reply.header("x-dev-only", "demo-login").send({ ok: true, userId: user.id, telegramUserId: user.telegramUserId ? user.telegramUserId.toString() : null });
    });
    app.post("/api/__demo/logout", async (req, reply) => {
      const tokenHeader = (req.headers as any)["x-demo-token"];
      if (DEV_DEMO_TOKEN && (!tokenHeader || tokenHeader !== DEV_DEMO_TOKEN)) {
        return reply.status(403).header("x-dev-only", "demo-login").send({ error: "x-demo-token missing or invalid" });
      }
      const sess = req.session as any;
      sess.userId = null;
      sess.telegramUserId = null;
      return reply.header("x-dev-only", "demo-login").send({ ok: true });
    });
  }

  await app.register(fastifyStatic, {
    root: path.join(ROOT_DIR, "telegram-mini-app"),
    prefix: "/mini-app/",
    decorateReply: false,
    index: ["index.html"],
  });
  app.get("/mini-app", async (_req, reply) => reply.redirect("/mini-app/"));

  await app.register(fastifyStatic, {
    root: path.join(ROOT_DIR, "h5"),
    prefix: "/h5/",
    decorateReply: false,
    index: ["index.html"],
  });
  app.get("/h5", async (_req, reply) => reply.redirect("/h5/"));

  // The managed HLS player must be served from our own origin. Depending on a
  // third-party script CDN makes Chrome playback fail in restricted networks,
  // even though the protected manifest itself is available.
  await app.register(fastifyStatic, {
    root: path.join(ROOT_DIR, "server", "node_modules", "hls.js", "dist"),
    prefix: "/api/vendor/hls/",
    decorateReply: false,
    index: false,
  });

  app.get("/login.html", async (req, reply) => reply.redirect(buildAliasRedirect("/mini-app/login.html", req)));
  app.get("/h5-pay.html", async (req, reply) => reply.redirect(buildAliasRedirect("/mini-app/h5-pay.html", req)));

  await app.register(telegramRoutes, { prefix: "/api/telegram" });
  // 【Phase 0-3】webhook 入口固定路径 POST /api/telegram/webhook（与 telegram 路由独立，不走 session / cookie）
  await app.register(telegramWebhookRoutes, { prefix: "" });
  await app.register(homeRoutes, { prefix: "/api" });
  await app.register(articleRoutes, { prefix: "/api" });
  await app.register(adminArticleRoutes, { prefix: "/api" });
  await app.register(contentRoutes, { prefix: "/api" });
  await app.register(resourceRoutes, { prefix: "/api" });
  await app.register(orderRoutes, { prefix: "/api" });
  await app.register(usdtInternalRoutes, { prefix: "" });
  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(adminCmsRoutes, { prefix: "/api" });
  await app.register(adminPackageRoutes, { prefix: "/api" });
  await app.register(adminUsersAndSupportRoutes, { prefix: "/api" });
  await app.register(adminChannelsRoutes, { prefix: "/api" });
  await app.register(adminDashboardRoutes, { prefix: "/api" });
  await app.register(authH5Routes, { prefix: "/api" });
  await app.register(analyticsAndPreferenceRoutes, { prefix: "/api" });
  await app.register(adminFinanceRoutes, { prefix: "/api" });
  await app.register(trafficEntryRoutes, { prefix: "/api" });
  await app.register(campaignRoutes, { prefix: "/api" });
  await app.register(watchProgressRoutes, { prefix: "/api" });
  await app.register(playbackRoutes, { prefix: "/api" });
  await app.register(playbackMediaRoutes);
  await app.register(publicSeoRoutes, { prefix: "" });

  try {
    await prisma.$connect();
    await selfCheckDefaultAdminPasswords(prisma);
    console.log(
      `[playback-config] mode=${playbackConfig.mode} configured=${playbackConfig.configured ? "yes" : "no"} missing=${playbackConfig.missingKeys.length}`,
    );
    const botStatus = await botSelfTest();
    if (botStatus.stub) {
      console.error(
        "[intune-server:bot] ⚠️  INVITES DISABLED — TELEGRAM_INVITE_BOT_KEY / TELEGRAM_BOTS is missing or invalid. " +
          "Requests to /api/resources/*/access-link will return a clear 500 error and NOT issue fake invite links. " +
          "Set server/.env TELEGRAM_BOTS and TELEGRAM_INVITE_BOT_KEY; the selected Bot must be a收费频道管理员。",
      );
      if (IS_PRODUCTION) {
        console.error("[intune-server:bot] FATAL: Production deploy without a real bot token — aborting.");
        throw new Error("TELEGRAM_INVITE_BOT_KEY and TELEGRAM_BOTS must be configured in production");
      } else {
        console.warn(
          "[intune-server:bot] Continuing in DEV — session / catalog / banners will still work, " +
            "only real invite creation will fail with a clear error.",
        );
      }
    } else if (botStatus.ok) {
      console.log(
        "[intune-server:bot] configured=yes invite_delivery=enabled member_limit=1 ttl_hours=1",
      );
    } else {
      console.error(
        "[intune-server:bot] telegram_api_unreachable; verify the server-side Bot configuration and network path.",
      );
      if (IS_PRODUCTION) {
        throw new Error("Telegram bot getMe failed in production; refusing to start.");
      }
    }
    console.log(
      `[intune-server:public-channel] configured=${TELEGRAM_CONFIG.publicChannelUrl ? "yes" : "no"}`,
    );
    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`[intune-server] listening on :${PORT}`);
    // Cron 调度：hourly 过期扫 + 3d 提醒 + 到期踢人。默认启动后 5s 跑第一次。
    // 测试环境禁用自动启动，避免 setInterval 导致 node:test 进程无法退出。
    if (process.env.NODE_ENV !== "test") {
      startEntitlementsCron(prisma);
      startUploadSessionCleanupCron(prisma);
      // USDT 地址回收：每 90 秒扫一次过期订单释放 assigned 地址。
      const usdtReleaseTimer = setInterval(async () => {
        try {
          const { released, errors } = await releaseExpiredUsdtAddresses(prisma);
          if (released > 0 || errors > 0) {
            emitStructuredLog({
              event: "usdt_reaper_cycle",
              errorClass: errors > 0 ? "db_error" : "business",
              retryHint: 0,
              note: errors > 0 ? "reaper_cycle_with_errors" : "reaper_cycle_ok",
              counts: { released, errors },
            });
          }
        } catch (e) {
          emitSafetyEvent(
            {
              event: "usdt_reaper_unhandled",
              errorClass: "unknown",
              retryHint: 1,
              note: "usdt_address_reaper_cycle_unhandled_exception",
            },
            e,
          );
        }
      }, 90 * 1000);
      try { (usdtReleaseTimer as any).unref?.(); } catch {}
      console.log(`[usdt-address-reaper] scheduled interval=90s`);
      console.log("[upload-session-cleanup] scheduled interval=600s");
    }
  } catch (err) {
    emitSafetyEvent(
      {
        event: "server_startup_failed",
        errorClass: "unknown",
        retryHint: 0,
        note: "main_bootstrap_caught_startup_exception",
      },
      err,
    );
    try { await prisma.$disconnect(); } catch {}
    process.exit(1);
  }
}

main().catch((err) => {
  emitSafetyEvent(
    {
      event: "server_unhandled_fatal",
      errorClass: "unknown",
      retryHint: 0,
      note: "main_async_function_unhandled_rejection",
    },
    err,
  );
  process.exit(1);
});
