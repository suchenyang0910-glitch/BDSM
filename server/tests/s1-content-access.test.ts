// ====================================================================
// S1：受控频道映射 & 全局 single 禁止 的安全断言测试
// - 不重复装饰 prisma（复用一个 per-test Fastify 实例，inject 完就 close）
// - 测试用户通过 __test/login/:userId 会话注入（与 smoke-sprint2.test.ts 完全一致）
// - Telegram fetch 统一由 _testHarness.ts installMockedTelegramEnvironment 在 setupTestHarness 时挂 globalThis.fetch
// ====================================================================
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import adminRoutes from "../src/routes/admin.js";
import contentRoutes from "../src/routes/contents.js";
import homeRoutes from "../src/routes/home.js";
import resourceRoutes from "../src/routes/resources.js";
import orderRoutes from "../src/routes/orders.js";
import adminCmsRoutes, { adminPackageRoutes } from "../src/routes/adminCms.js";
import adminUsersAndSupportRoutes from "../src/routes/adminUsersAndSupport.js";
import adminChannelsRoutes from "../src/routes/adminChannels.js";
import { chatIdIndexKey, encryptChatIdAesGcm } from "../src/utils/crypto.js";
import {
  setupTestHarness,
  teardownTestHarness,
  seedTestData,
  TEST_CREDENTIALS,
  TEST_KNOWN_IDS,
} from "./_testHarness.js";

const SENSITIVE_CHANNEL_IDS = ["-1000000000001", "-1000000000002"];
const SENSITIVE_INVITE_PREFIX = "t.me/+";

function cookieFromResponse(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const cookies: string[] = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  return cookies.map((c: string) => c.split(";")[0]).join("; ");
}

function buildTestApp(prisma: any): any {
  const app = Fastify();
  return (async () => {
    await app.register(cookie);
    await app.register(session, {
      secret: "test-session-secret-is-at-least-thirty-two-characters",
      cookie: { secure: false },
    });
    app.decorate("prisma", prisma);
    app.decorateRequest("userId", null);
    app.decorateRequest("telegramUserId", null);
    app.addHook("preHandler", async (req: any) => {
      const sess = (req.session as any) || {};
      if (sess?.userId) req.userId = sess.userId;
      if (sess?.telegramUserId) req.telegramUserId = sess.telegramUserId;
    });
    app.post("/__test/login/:userId", async (req: any, reply: any) => {
      const sess = (req.session as any) || {};
      sess.userId = req.params.userId;
      if (req.headers["x-tg-uid"]) sess.telegramUserId = String(req.headers["x-tg-uid"]);
      return reply.send({ ok: true, userId: sess.userId, telegramUserId: sess.telegramUserId });
    });
    await app.register(adminRoutes, { prefix: "/api" });
    await app.register(homeRoutes, { prefix: "/api" });
    await app.register(contentRoutes, { prefix: "/api" });
    await app.register(resourceRoutes, { prefix: "/api" });
    await app.register(orderRoutes, { prefix: "/api" });
    await app.register(adminCmsRoutes, { prefix: "/api" });
    await app.register(adminPackageRoutes, { prefix: "/api" });
    await app.register(adminUsersAndSupportRoutes, { prefix: "/api" });
    await app.register(adminChannelsRoutes, { prefix: "/api" });
    return app;
  })();
}

async function loginAs(app: any, userId: string, tgUid?: bigint): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/__test/login/${userId}`,
    headers: tgUid ? { "x-tg-uid": tgUid.toString() } : undefined,
  });
  if (res.statusCode !== 200) throw new Error(`user login ${userId} failed: ${res.body}`);
  return cookieFromResponse(res);
}

async function loginAdmin(app: any, role: keyof typeof TEST_CREDENTIALS): Promise<string> {
  const c = TEST_CREDENTIALS[role];
  const r = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { "Content-Type": "application/json" },
    payload: { email: c.email, password: c.password },
  });
  assert.equal(r.statusCode, 200, `[${role}] admin login failed ${r.body}`);
  return cookieFromResponse(r);
}

function assertNoSensitiveLeaks(blob: string, ctxLabel: string) {
  for (const cid of SENSITIVE_CHANNEL_IDS) {
    assert.ok(!blob.includes(cid), `${ctxLabel}: MUST NOT leak channelId=${cid}`);
  }
  // 前端/JSON 审计绝不能出现 t.me/+ 直链；Location 头 302 重定向允许
  assert.ok(!blob.includes(SENSITIVE_INVITE_PREFIX), `${ctxLabel}: MUST NOT embed t.me/+ invite in JSON/body`);
}

async function assertAuditLogsNoLeak(prisma: any, contentId: string) {
  const logs = await prisma.adminAuditLog.findMany({
    where: { objectType: "content", objectId: contentId },
    orderBy: { createdAt: "asc" },
    select: { beforeValue: true, afterValue: true, action: true, createdAt: true },
  });
  for (const log of logs) {
    const serial = JSON.stringify({ before: log.beforeValue, after: log.afterValue });
    assertNoSensitiveLeaks(serial, `adminAuditLog[${log.action}] for content=${contentId}`);
  }
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  try {
    await teardownTestHarness(prisma);
  } catch (_) {
    /* ignore */
  }
});

// ============================================================
// [S1-0] 管理后台内容列表/详情：Prisma BigInt 必须序列化为字符串
// ============================================================
test("[S1-0] GET /admin/contents 与详情包含商品 BigInt 金额时仍返回 200", async () => {
  const app = await buildTestApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/contents",
      headers: { cookie: editorCookie },
    });
    assert.equal(list.statusCode, 200, `content list expected 200, got ${list.statusCode}: ${list.body}`);
    const listBody = list.json();
    const draft = listBody.data.find((row: any) => row.id === TEST_KNOWN_IDS.contentDraft);
    assert.ok(draft, "seeded draft content must be present");
    assert.equal(typeof draft.product?.priceMinor, "string", "BigInt priceMinor must be emitted as a decimal string");

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}`,
      headers: { cookie: editorCookie },
    });
    assert.equal(detail.statusCode, 200, `content detail expected 200, got ${detail.statusCode}: ${detail.body}`);
    assert.equal(typeof detail.json().product?.priceMinor, "string", "detail must serialize BigInt priceMinor too");
  } finally {
    await app.close();
  }
});

// ============================================================
// [A] single 内容允许创建：走站内 HLS 解锁，不再被 CMS 全局拦截
// ============================================================
test("[S1-A] single 类型内容 CREATE → 201，响应体无敏感泄露", async () => {
  const app = await buildTestApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/contents",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        title: "[S1-A] 禁止创建的 single",
        accessType: "single",
        productId: TEST_KNOWN_IDS.singleProductKey,
        description: "架构性禁止",
        tags: ["test-s1-a"],
        reason: "S1-A 创建单条内容",
      },
    });
    assert.equal(resp.statusCode, 201, `single create expected 201, got ${resp.statusCode}: ${resp.body}`);
    const body = resp.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, "string");
    assertNoSensitiveLeaks(resp.body, "single create resp body");
  } finally {
    await app.close();
  }
});

// ============================================================
// [B] 已有的 single 草稿：可发布，并且只会创建免费流量入口任务
// ============================================================
test("[S1-B] 既有 single 草稿 (topic-03-draft) 发布 → 200/202，且不创建私密完整频道任务", async () => {
  const app = await buildTestApp(prisma);
  try {
    process.env.CRYPTO_CHAT_ID_AES_KEY = "12345678901234567890123456789012";
    const managedFreeChannelId = BigInt("-1002000000001");
    await prisma.adminManagedChannel.create({
      data: {
        chatIdHmac: chatIdIndexKey(managedFreeChannelId),
        chatIdCiphertextB64: encryptChatIdAesGcm(managedFreeChannelId),
        deprecatedChatIdBig: managedFreeChannelId,
        chatType: "channel",
        title: "S1-B Free Preview",
        isPrivate: false,
        purpose: "free_preview",
        source: "manual_add",
        publicUrl: "https://t.me/s1_b_free_preview",
        botIsAdmin: true,
        botCanPostMessages: true,
      },
    });
    await prisma.videoAsset.create({
      data: {
        id: "s1b-cover-asset",
        contentId: TEST_KNOWN_IDS.contentDraft,
        kind: "cover",
        objectKey: `covers/${TEST_KNOWN_IDS.contentDraft}/poster.jpg`,
        originalFilename: "poster.jpg",
        mimeType: "image/jpeg",
        byteSize: BigInt(2048),
        sha256: "b".repeat(64),
        status: "verified",
        verifiedAt: new Date(),
      },
    });
    const editorCookie = await loginAdmin(app, "editor");
    const resp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { reason: "[S1-B] 尝试发布 single" },
    });
    assert.ok([200, 202].includes(resp.statusCode), `single publish expected 200/202, got ${resp.statusCode}: ${resp.body}`);
    const body = resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "published");
    const jobs = await prisma.telegramPublishJob.findMany({
      where: { contentId: TEST_KNOWN_IDS.contentDraft },
      select: { channelKind: true },
    });
    assert.ok(jobs.length >= 1, "single publish should create free preview distribution jobs");
    assert.deepEqual([...new Set(jobs.map((job: any) => job.channelKind))], ["public_free_preview"]);
    assertNoSensitiveLeaks(resp.body, "single publish resp body");
    await assertAuditLogsNoLeak(prisma, TEST_KNOWN_IDS.contentDraft);
  } finally {
    await app.close();
  }
});

// ============================================================
// [C] package 无 packageId → 400
// ============================================================
test("[S1-C] package 类型 CREATE 不带 packageId → 400 package_id_required", async () => {
  const app = await buildTestApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/contents",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        title: "[S1-C] package 缺少 packageId",
        accessType: "package",
        description: "故意不写 packageId",
        tags: ["test-s1-c"],
        reason: "S1-C",
      },
    });
    assert.equal(resp.statusCode, 400, `package without packageId expected 400, got ${resp.statusCode}: ${resp.body}`);
    const body = resp.json();
    assert.equal(body.error, "package_id_required");
    assertNoSensitiveLeaks(resp.body, "package no-id 400 resp");
  } finally {
    await app.close();
  }
});

// ============================================================
// [D] GET /admin/packages 只读：pkg-test-main channelConfigured=false，无明文 channelId
//     （seed _testHarness.ts 的 TEST_KNOWN_IDS.contentPackageKey 不设置 channelIdCiphertext，明确 null）
// ============================================================
test("[S1-D] GET /admin/packages：pkg-test-main 报告 channelConfigured=false，且不返回明文 channelId/hint", async () => {
  const app = await buildTestApp(prisma);
  try {
    const opCookie = await loginAdmin(app, "operator");
    const resp = await app.inject({
      method: "GET",
      url: "/api/admin/packages",
      headers: { cookie: opCookie },
    });
    assert.equal(resp.statusCode, 200, `packages list expected 200, got ${resp.statusCode}: ${resp.body}`);
    const body = resp.json() as { data: Array<{ id: string; channelConfigured: boolean; [k: string]: unknown }> };
    const pkg = body.data.find((r) => r.id === TEST_KNOWN_IDS.contentPackageKey);
    assert.ok(pkg, `seed pkg-test-main (${TEST_KNOWN_IDS.contentPackageKey}) must appear in list`);
    assert.equal(pkg.channelConfigured, false, "pkg-test-main in seed has NO channel configuration");
    assert.ok(!("channelId" in pkg), "packages list MUST NOT expose channelId field");
    assert.ok(!("channelIdCiphertext" in pkg), "packages list MUST NOT expose ciphertext");
    assert.ok(!("channelIdHmac" in pkg), "packages list MUST NOT expose hmac index");
    assertNoSensitiveLeaks(resp.body, "GET /admin/packages body");
  } finally {
    await app.close();
  }
});

// ============================================================
// [E] 未配置频道的内容包 access-link：409 delivery_channel_not_configured，绝不 fallback 会员
// ============================================================
test("[S1-E] pkg-test-main access-link，用户已有 package 权益但包未配频道 → 409 delivery_channel_not_configured", async () => {
  const app = await buildTestApp(prisma);
  try {
    const tgid = BigInt(9300000000 + Date.now() % 100_000_000);
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `S1-E User ${tgid}` },
    });
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        resourceType: "package",
        resourceId: TEST_KNOWN_IDS.contentPackageKey,
        status: "active",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    const userCookie = await loginAs(app, user.id, tgid);

    const resp = await app.inject({
      method: "POST",
      url: `/api/resources/${TEST_KNOWN_IDS.contentPackage}/access-link`,
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(
      resp.statusCode,
      409,
      `pkg-test-main channel-unconfigured access-link MUST 409, got ${resp.statusCode}: ${resp.body}`,
    );
    const body = resp.json();
    assert.equal(body.error, "delivery_channel_not_configured",
      "package no-channel error code MUST be delivery_channel_not_configured (never silently fall back to membership)");
    assertNoSensitiveLeaks(resp.body, "package no-channel 409 body");
  } finally {
    await app.close();
  }
});

// ============================================================
// [F] membership 内容 access-link：优先走后台登记 membership_main，缺失时才回退 env
//     验证点：
//       ① 302 Location 头（非 JSON）
//       ② telegramInvite.create 内部 _resolvedChannelId === 会员频道 BigInt（仅写入 DB 的那一次）
//       ③ JSON 响应体绝不包含 inviteLink / -100 明文
// ============================================================
test("[S1-F] membership 内容 access-link：优先解析后台登记会员频道，302 重定向且不泄露邀请", async () => {
  const originalAesKey = process.env.CRYPTO_CHAT_ID_AES_KEY;
  process.env.CRYPTO_CHAT_ID_AES_KEY = "12345678901234567890123456789012";
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, {
    secret: "test-session-secret-is-at-least-thirty-two-characters",
    cookie: { secure: false },
  });
  app.decorateRequest("userId", null);
  app.addHook("preHandler", async (req: any) => {
    const sess = req.session as any;
    if (sess?.userId) req.userId = sess.userId;
  });
  app.post("/__test/login/:userId", async (req: any, reply: any) => {
    (req.session as any).userId = req.params.userId;
    return reply.send({ ok: true });
  });
  let lastResolvedChannelId: bigint | null = null;
  const prismaProxy = new Proxy(prisma as any, {
    get(target, prop) {
      const real = target[prop];
      if (prop === "telegramInvite" && real) {
        return {
          ...real,
          create: async (args: any) => {
            lastResolvedChannelId = args?.data?.channelId ?? null;
            return real.create(args);
          },
        };
      }
      return real;
    },
  });
  app.decorate("prisma", prismaProxy);
  await app.register(resourceRoutes, { prefix: "/api" });

  try {
    const tgid = BigInt(9400000000 + Date.now() % 100_000_000);
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `S1-F User ${tgid}` },
    });
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: "membership-main",
        status: "active",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });
    const managedMembershipChannelId = BigInt(`-100${String(tgid).slice(-10)}`);
    await prisma.adminManagedChannel.create({
      data: {
        chatIdHmac: chatIdIndexKey(managedMembershipChannelId),
        chatIdCiphertextB64: encryptChatIdAesGcm(managedMembershipChannelId),
        deprecatedChatIdBig: managedMembershipChannelId,
        chatType: "channel",
        title: "S1-F Managed Membership",
        isPrivate: true,
        purpose: "membership_main",
        source: "manual_add",
        botIsAdmin: true,
        botCanPostMessages: true,
        botCanInviteUsers: true,
        botCanRestrictMembers: true,
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: `/__test/login/${user.id}`,
    });
    const sessCookie = cookieFromResponse(loginRes);

    const resp = await app.inject({
      method: "POST",
      url: `/api/resources/${TEST_KNOWN_IDS.contentMembership}/access-link`,
      headers: { cookie: sessCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(
      resp.statusCode,
      302,
      `membership access-link expected 302 redirect, got ${resp.statusCode}: ${resp.body}`,
    );
    const expected = managedMembershipChannelId;
    assert.equal(lastResolvedChannelId, expected,
      "membership content must prefer the backend-managed membership channel binding");
    // body 永不泄露 invite
    assertNoSensitiveLeaks(resp.body, "membership 302 body (no JSON leak)");
    const location = resp.headers["location"];
    assert.ok(
      typeof location === "string" && /^https:\/\/t\.me\/\+/.test(location),
      `membership access-link Location must be https://t.me/+ invite; got ${location}`,
    );
  } finally {
    if (originalAesKey === undefined) delete process.env.CRYPTO_CHAT_ID_AES_KEY;
    else process.env.CRYPTO_CHAT_ID_AES_KEY = originalAesKey;
    await app.close();
  }
});

// ============================================================
// [S1-F2] 已交付且已关联频道消息的会员内容：应直达该条视频消息，
// 不再把用户只带到频道首页；Location 可以是 Telegram 的受控跳转，
// JSON 正文不可出现频道原始 ID。
// ============================================================
test("[S1-F2] 已解锁会员内容 access-link 定位到指定频道视频", async () => {
  const originalAesKey = process.env.CRYPTO_CHAT_ID_AES_KEY;
  process.env.CRYPTO_CHAT_ID_AES_KEY = "12345678901234567890123456789012";
  const app = await buildTestApp(prisma);
  const suffix = String(Date.now()).slice(-9);
  const channelId = BigInt(`-1008${suffix}`);
  let userId: string | null = null;
  let managedChannelId: string | null = null;
  let contentId: string | null = null;
  try {
    const user = await prisma.user.create({ data: { displayName: `S1-F2 User ${suffix}` } });
    userId = user.id;
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: "membership-main",
        status: "active",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });
    const managed = await prisma.adminManagedChannel.create({
      data: {
        chatIdHmac: chatIdIndexKey(channelId),
        chatIdCiphertextB64: encryptChatIdAesGcm(channelId),
        deprecatedChatIdBig: channelId,
        chatType: "channel",
        title: `S1-F2 Channel ${suffix}`,
        isPrivate: true,
        purpose: "membership_main",
        source: "manual_add",
        botIsAdmin: true,
        botCanInviteUsers: true,
      },
    });
    managedChannelId = managed.id;
    const content = await prisma.content.create({
      data: {
        title: `S1-F2 Target ${suffix}`,
        accessType: "membership",
        status: "published",
        telegramMessageId: BigInt(418),
        telegramChatFingerprint: chatIdIndexKey(channelId),
      },
    });
    contentId = content.id;
    const userCookie = await loginAs(app, user.id);
    const resp = await app.inject({
      method: "POST",
      url: `/api/resources/${content.id}/access-link`,
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(resp.statusCode, 302, resp.body);
    assert.equal(
      resp.headers.location,
      `https://t.me/c/${String(channelId).slice(4)}/418`,
      "unlocked content must route to its exact Telegram message",
    );
    assertNoSensitiveLeaks(resp.body, "target-post delivery response");
    assert.equal((resp.json() as any).delivery?.target, "content_message");
  } finally {
    if (contentId) await prisma.content.delete({ where: { id: contentId } }).catch(() => {});
    if (managedChannelId) await prisma.adminManagedChannel.delete({ where: { id: managedChannelId } }).catch(() => {});
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    if (originalAesKey === undefined) delete process.env.CRYPTO_CHAT_ID_AES_KEY;
    else process.env.CRYPTO_CHAT_ID_AES_KEY = originalAesKey;
    await app.close();
  }
});

// ============================================================
// [S1-F3] 后台内容列表的私密视频入口：仅管理员会话可触发 302，
// 频道标识不得出现在 JSON 响应体；该入口用于后台快速校验已发布视频。
// ============================================================
test("[S1-F3] 后台私密视频入口受控跳转到关联频道消息", async () => {
  const originalAesKey = process.env.CRYPTO_CHAT_ID_AES_KEY;
  process.env.CRYPTO_CHAT_ID_AES_KEY = "12345678901234567890123456789012";
  const app = await buildTestApp(prisma);
  const suffix = String(Date.now()).slice(-9);
  const channelId = BigInt(`-1007${suffix}`);
  let managedChannelId: string | null = null;
  let contentId: string | null = null;
  try {
    const managed = await prisma.adminManagedChannel.create({
      data: {
        chatIdHmac: chatIdIndexKey(channelId),
        chatIdCiphertextB64: encryptChatIdAesGcm(channelId),
        deprecatedChatIdBig: channelId,
        chatType: "channel",
        title: `S1-F3 Channel ${suffix}`,
        isPrivate: true,
        purpose: "membership_main",
        source: "manual_add",
        botIsAdmin: true,
        botCanInviteUsers: true,
      },
    });
    managedChannelId = managed.id;
    const content = await prisma.content.create({
      data: {
        title: `S1-F3 Target ${suffix}`,
        accessType: "membership",
        status: "published",
        telegramMessageId: BigInt(419),
        telegramChatFingerprint: chatIdIndexKey(channelId),
      },
    });
    contentId = content.id;
    const adminCookie = await loginAdmin(app, "editor");
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/contents/${content.id}/private-video`,
      headers: { cookie: adminCookie },
    });
    assert.equal(response.statusCode, 302, response.body);
    assert.equal(response.headers.location, `https://t.me/c/${String(channelId).slice(4)}/419`);
    assertNoSensitiveLeaks(response.body, "admin private-video redirect body");
  } finally {
    if (contentId) await prisma.content.delete({ where: { id: contentId } }).catch(() => {});
    if (managedChannelId) await prisma.adminManagedChannel.delete({ where: { id: managedChannelId } }).catch(() => {});
    if (originalAesKey === undefined) delete process.env.CRYPTO_CHAT_ID_AES_KEY;
    else process.env.CRYPTO_CHAT_ID_AES_KEY = originalAesKey;
    await app.close();
  }
});

// ============================================================
// [G] membership 内容：CREATE → PATCH → SUBMIT_REVIEW → PUBLISH
//     全链路每个动作的审计日志 before/after 均 stripSensitiveFields 无 -100 / t.me/+
// ============================================================
test("[S1-G] membership 内容 4 动作全链路：审计脱敏 + 4 动作按序存在，无敏感泄露", async () => {
  const freeChannelEnv = "TELEGRAM_FREE_CHANNEL_PREVIEW_MAIN_CHAT_ID";
  const originalFreeChannel = process.env[freeChannelEnv];
  process.env[freeChannelEnv] = "-1000000000999";
  const app = await buildTestApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const actions: Array<{ label: string; method: string; url: string; payload: any; expectedStatus: number }> = [
      {
        label: "CREATE",
        method: "POST",
        url: "/api/admin/contents",
        payload: {
          title: "[S1-G] membership 审计脱敏链路",
          accessType: "membership",
          description: "测试 4 动作审计脱敏",
          tags: ["test-s1-g"],
          reason: "S1-G 创建",
        },
        expectedStatus: 201,
      },
    ];
    const createResp = await app.inject({
      method: actions[0].method,
      url: actions[0].url,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: actions[0].payload,
    });
    assert.equal(createResp.statusCode, 201, `membership create expected 201, got ${createResp.statusCode}: ${createResp.body}`);
    const newId = createResp.json().id;
    assert.ok(typeof newId === "string" && newId.length > 0, "new content id expected");
    assertNoSensitiveLeaks(createResp.body, "membership create 201");

    const fullVideoAsset = await prisma.videoAsset.create({
      data: {
        contentId: newId,
        kind: "full_source",
        objectKey: `tests/${newId}/s1-g-membership-full.mp4`,
        originalFilename: "s1-g-membership-full.mp4",
        mimeType: "video/mp4",
        byteSize: BigInt(1024),
        sha256: `legacy-s1-g-${newId}`,
        status: "verified",
        verifiedAt: new Date(),
      },
    });
    // 免费流量入口会使用已校验的封面推广；该规则必须由测试显式满足，
    // 不能为了旧样本而放宽生产校验。
    await prisma.videoAsset.create({
      data: {
        contentId: newId,
        kind: "cover",
        objectKey: `tests/${newId}/s1-g-membership-cover.jpg`,
        originalFilename: "s1-g-membership-cover.jpg",
        mimeType: "image/jpeg",
        byteSize: BigInt(1024),
        sha256: `cover-s1-g-${newId}`,
        status: "verified",
        verifiedAt: new Date(),
      },
    });

    const patchResp = await app.inject({
      method: "PATCH",
      url: `/api/admin/contents/${newId}`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        title: "[S1-G] membership 审计脱敏链路（已编辑）",
        isRecommended: true,
        fullVideoAssetId: fullVideoAsset.id,
        fullVideoAssetIds: [fullVideoAsset.id],
        reason: "S1-G 编辑标题",
      },
    });
    assert.equal(patchResp.statusCode, 200, `membership patch expected 200, got ${patchResp.statusCode}: ${patchResp.body}`);
    assertNoSensitiveLeaks(patchResp.body, "membership patch 200");

    const submitResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${newId}/submit_review`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { reason: "S1-G 提交审核" },
    });
    assert.ok(
      [200, 202].includes(submitResp.statusCode) || submitResp.statusCode === 200,
      `membership submit_review expected 2xx, got ${submitResp.statusCode}: ${submitResp.body}`,
    );
    assertNoSensitiveLeaks(submitResp.body, "membership submit_review");

    const publishResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${newId}/publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { reason: "S1-G editor 发布（editor 角色含 content:publish）" },
    });
    // validatePublishReady 会校验 membership 合法（不需要 package/channelId），预期 200
    assert.ok(
      publishResp.statusCode === 200 || publishResp.statusCode === 202,
      `membership publish expected 2xx, got ${publishResp.statusCode}: ${publishResp.body}`,
    );
    const publishBody = publishResp.json() as any;
    assert.equal(publishBody.telegramPublish?.queued, true, "publishing a membership video must create a private-channel delivery job");
    assert.equal(publishBody.telegramPublish?.jobs?.length, 2, "membership content creates both a mandatory free-entry promotion and the private-channel job");
    assert.ok(publishBody.telegramPublish?.jobs?.some((job: any) => job.channelKind === "public_free_preview"));
    assert.ok(publishBody.telegramPublish?.jobs?.some((job: any) => job.channelKind === "membership_full"));
    const queuedJobs = await prisma.telegramPublishJob.findMany({
      where: { contentId: newId },
      select: { channelKind: true, status: true },
    });
    assert.deepEqual(queuedJobs, [
      { channelKind: "public_free_preview", status: "queued" },
      { channelKind: "membership_full", status: "queued" },
    ]);
    assertNoSensitiveLeaks(publishResp.body, "membership publish 2xx");

    // 审计 4 动作按序存在，且脱敏
    const logs = await prisma.adminAuditLog.findMany({
      where: { objectType: "content", objectId: newId },
      orderBy: { createdAt: "asc" },
      select: { action: true, beforeValue: true, afterValue: true },
    });
    const actionSeq = logs.map((l: any) => l.action);
    const wants = ["content.create", "content.update", "content.submit_review", "content.publish"];
    for (const w of wants) {
      assert.ok(
        actionSeq.includes(w),
        `audit log for ${newId} should contain action=${w}; got sequence=${JSON.stringify(actionSeq)}`,
      );
    }
    for (const log of logs) {
      const serial = JSON.stringify({ b: (log as any).beforeValue, a: (log as any).afterValue });
      assertNoSensitiveLeaks(serial, `audit action=${(log as any).action} before/after payload`);
    }
  } finally {
    if (originalFreeChannel === undefined) delete process.env[freeChannelEnv];
    else process.env[freeChannelEnv] = originalFreeChannel;
    await app.close();
  }
});
