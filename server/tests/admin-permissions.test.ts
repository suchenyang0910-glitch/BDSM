import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import adminRoutes from "../src/routes/admin.js";
import contentRoutes from "../src/routes/contents.js";
import homeRoutes from "../src/routes/home.js";
import resourceRoutes from "../src/routes/resources.js";
import orderRoutes from "../src/routes/orders.js";
import adminCmsRoutes from "../src/routes/adminCms.js";
import adminUsersAndSupportRoutes from "../src/routes/adminUsersAndSupport.js";
import adminChannelsRoutes from "../src/routes/adminChannels.js";
import {
  setupTestHarness,
  teardownTestHarness,
  seedTestData,
  TEST_CREDENTIALS,
  TEST_KNOWN_IDS,
} from "./_testHarness.js";

function cookieFromResponse(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const cookies: string[] = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
    ? [setCookie]
    : [];
  return cookies.map((c: string) => c.split(";")[0]).join("; ");
}

async function createApp(prisma: any) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, { secret: "test-session-secret-is-at-least-thirty-two-characters", cookie: { secure: false } });
  app.decorate("prisma", prisma);
  app.decorateRequest("userId", null);
  app.decorateRequest("telegramUserId", null);
  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(homeRoutes, { prefix: "/api" });
  await app.register(contentRoutes, { prefix: "/api" });
  await app.register(resourceRoutes, { prefix: "/api" });
  await app.register(orderRoutes, { prefix: "/api" });
  await app.register(adminCmsRoutes, { prefix: "/api" });
  await app.register(adminUsersAndSupportRoutes, { prefix: "/api" });
  await app.register(adminChannelsRoutes, { prefix: "/api" });
  return app;
}

async function loginAdmin(app: any, role: keyof typeof TEST_CREDENTIALS): Promise<string> {
  const c = TEST_CREDENTIALS[role];
  const r = await app.inject({
    method: "POST", url: "/api/admin/login",
    headers: { "Content-Type": "application/json" },
    payload: { email: c.email, password: c.password },
  });
  assert.equal(r.statusCode, 200, `${role} login failed ${r.body}`);
  return cookieFromResponse(r);
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

async function seedReadyMediaAsset(
  prismaClient: any,
  input: { id: string; kind: "cover_image" | "preview_video" | "full_video"; ownerAdminId?: string | null; filename?: string }
) {
  return prismaClient.mediaAsset.create({
    data: {
      id: input.id,
      kind: input.kind,
      status: "ready",
      ownerAdminId: input.ownerAdminId ?? null,
      originalFilename: input.filename || `${input.kind}.mp4`,
      mimeType: input.kind === "cover_image" ? "image/jpeg" : "video/mp4",
      contentLength: BigInt(1024),
      storageBucket: "test-bucket",
      storageRegion: "test-region",
      storageKey: `${input.id}.bin`,
      storagePublicUrl: `https://example.com/${input.id}.bin`,
      durationSeconds: input.kind === "cover_image" ? null : 60,
    },
  });
}

test("越权2：customer_service 直接发放权益 entitlement:grant 必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const tgid = BigInt(8000000000 + (Date.now() % 100_000_000));
    const user = await prisma.user.create({ data: { telegramUserId: tgid, displayName: `CS test ${tgid}` } });

    const csCookie = await loginAdmin(app, "customerService");
    const grantResp = await app.inject({
      method: "POST", url: "/api/admin/_internal_/entitlements/_grant",
      headers: { cookie: csCookie, "Content-Type": "application/json" },
      payload: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: TEST_KNOWN_IDS.membershipProductKey,
        reason: "越权测试：客服无权发权益",
        durationDays: 7,
      },
    });
    assert.ok(grantResp.statusCode === 403 || grantResp.statusCode === 404,
      `CS grant entitlement must be 403 (or route 404 if removed), got ${grantResp.statusCode}: ${grantResp.body}`);
  } finally {
    await app.close();
  }
});

test("平台 SEO 设置遵循读写权限：operator 可读，auditor 可读，editor 不可写，super_admin 可更新", async () => {
  const app = await createApp(prisma);
  try {
    const opCookie = await loginAdmin(app, "operator");
    const audCookie = await loginAdmin(app, "auditor");
    const editorCookie = await loginAdmin(app, "editor");
    const superCookie = await loginAdmin(app, "superAdmin");

    const opRead = await app.inject({ method: "GET", url: "/api/admin/platform-metadata", headers: { cookie: opCookie } });
    assert.equal(opRead.statusCode, 200, opRead.body);
    assert.equal((opRead.json() as any).seoTitle, "同频平台默认 SEO 标题");

    const audRead = await app.inject({ method: "GET", url: "/api/admin/platform-metadata", headers: { cookie: audCookie } });
    assert.equal(audRead.statusCode, 200, audRead.body);

    const editorWrite = await app.inject({
      method: "PUT",
      url: "/api/admin/platform-metadata",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { seoTitle: "editor should fail" },
    });
    assert.equal(editorWrite.statusCode, 403, editorWrite.body);

    const superWrite = await app.inject({
      method: "PUT",
      url: "/api/admin/platform-metadata",
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        seoTitle: "新的平台 SEO 标题",
        seoDescription: "新的平台 SEO 描述",
        seoKeywords: ["平台词", "平台词", "  搜索词  "],
        geoKeywords: ["主题A", "主题A"],
        reason: "测试更新平台 SEO",
      },
    });
    assert.equal(superWrite.statusCode, 200, superWrite.body);
    const updated = (superWrite.json() as any).platformMetadata;
    assert.deepEqual(updated.seoKeywords, ["平台词", "搜索词"]);
    assert.deepEqual(updated.geoKeywords, ["主题A"]);
  } finally {
    await app.close();
  }
});

test("start-telegram-publish 规范化标签、落库存储且不泄露 SEO/GEO 关键词", async () => {
  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const editor = await prisma.adminUser.findUnique({ where: { email: TEST_CREDENTIALS.editor.email } });
    assert.ok(editor, "editor seed should exist");
    const contentId = crypto.randomUUID();

    const mediaAsset = await seedReadyMediaAsset(prisma, {
      id: crypto.randomUUID(),
      kind: "full_video",
      ownerAdminId: editor!.id,
      filename: "membership-full.mp4",
    });

    await prisma.content.create({
      data: {
        id: contentId,
        title: "SEO Telegram 标签测试",
        description: "用于测试标签清洗与隔离",
        accessType: "membership",
        status: "draft",
        tags: ["睡眠"],
        seoKeywords: ["不应泄露", "默认词"],
        fullVideoAssetId: mediaAsset.id,
      },
    });

    const startResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${contentId}/start-telegram-publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        channelKinds: ["membership_full"],
        telegramTags: [" #睡眠 ", "夜间", "#夜间", "calm-mode", "默认词"],
        reason: "测试 Telegram 标签规范化",
      },
    });
    assert.equal(startResp.statusCode, 201, startResp.body);
    const startBody = startResp.json() as any;
    assert.deepEqual(
      startBody.normalizedTelegramTags,
      ["#睡眠", "#夜间", "#calmmode", "#默认词"],
      "should normalize, dedupe and clip telegram tags only from content tags + telegramTags",
    );

    const jobsResp = await app.inject({
      method: "GET",
      url: `/api/admin/contents/${contentId}/publish-jobs`,
      headers: { cookie: editorCookie },
    });
    assert.equal(jobsResp.statusCode, 200, jobsResp.body);
    const firstJob = (jobsResp.json() as any).items[0];
    assert.deepEqual(firstJob.telegramTags, ["#睡眠", "#夜间", "#calmmode", "#默认词"]);
    assert.ok(!String(firstJob.captionText || "").includes("不应泄露"), "SEO/GEO keywords must not leak into caption");
  } finally {
    await app.close();
  }
});

test("越权3：auditor 不允许发布内容/分类写操作，仅读=200/写=403", async () => {
  const app = await createApp(prisma);
  try {
    const audCookie = await loginAdmin(app, "auditor");

    const listCategories = await app.inject({ method: "GET", url: "/api/admin/categories", headers: { cookie: audCookie } });
    assert.ok(
      listCategories.statusCode === 200 || listCategories.statusCode === 404,
      `auditor reading categories should be 200 (or 404 if not implemented), got ${listCategories.statusCode}`,
    );

    const publishResp = await app.inject({
      method: "POST", url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/publish`,
      headers: { cookie: audCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：审计不允许发布" },
    });
    assert.ok(
      publishResp.statusCode === 403 || publishResp.statusCode === 404,
      `auditor publish content should be 403 (or 404 if not implemented), got ${publishResp.statusCode}: ${publishResp.body}`,
    );
  } finally {
    await app.close();
  }
});

test("越权P2-1：finance 无 order:cancel 权限，取消订单必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const finCookie = await loginAdmin(app, "finance");
    const cancelResp = await app.inject({
      method: "POST", url: "/api/admin/orders/INT-NOTEXIST-001/cancel",
      headers: { cookie: finCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：财务不能取消" },
    });
    assert.ok(
      cancelResp.statusCode === 403 || cancelResp.statusCode === 404,
      `finance cancel order should be 403 (or 404 if not impl), got ${cancelResp.statusCode}`,
    );
  } finally {
    await app.close();
  }
});

test("越权P2-2：operator 无 order:refund 权限，退款订单必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const opCookie = await loginAdmin(app, "operator");
    const refundResp = await app.inject({
      method: "POST", url: "/api/admin/orders/INT-NOTEXIST-001/refund",
      headers: { cookie: opCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：运营不能退款" },
    });
    assert.ok(
      refundResp.statusCode === 403 || refundResp.statusCode === 404,
      `operator refund order should be 403 (or 404 if not impl), got ${refundResp.statusCode}`,
    );
  } finally {
    await app.close();
  }
});

test("越权P2-3：auditor 无 entitlement:resend_invite 权限，补发邀请必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const audCookie = await loginAdmin(app, "auditor");
    const resendResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/not_exist_id/resend-invite",
      headers: { cookie: audCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：审计不能补发邀请" },
    });
    assert.ok(
      resendResp.statusCode === 403 || resendResp.statusCode === 404,
      `auditor resend invite should be 403 (or 404 if not impl), got ${resendResp.statusCode}`,
    );
  } finally {
    await app.close();
  }
});

test("越权P2-4：finance 无 ticket:resolve 权限，关单解决工单必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const finCookie = await loginAdmin(app, "finance");
    const resolveResp = await app.inject({
      method: "POST", url: "/api/admin/tickets/not_exist_ticket/resolve",
      headers: { cookie: finCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：财务不能解决工单" },
    });
    assert.ok(
      resolveResp.statusCode === 403 || resolveResp.statusCode === 404,
      `finance resolve ticket should be 403 (or 404 if not impl), got ${resolveResp.statusCode}`,
    );
  } finally {
    await app.close();
  }
});

test("越权P2-5：仅 super_admin 可直授权益；customer_service/auditor/operator 必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const tgid = BigInt(8500000000 + (Date.now() % 100_000_000));
    const user = await prisma.user.create({ data: { telegramUserId: tgid, displayName: `Entitlement grant test ${tgid}` } });

    const audCookie = await loginAdmin(app, "auditor");
    const grantAudResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: audCookie, "Content-Type": "application/json" },
      payload: { userId: user.id, resourceType: "membership_channel", resourceId: TEST_KNOWN_IDS.membershipProductKey, reason: "越权测试：审计不能发", durationDays: 3 },
    });
    assert.equal(
      grantAudResp.statusCode, 403,
      `auditor grant should be strictly 403 (路由已注册，不再允许 404 混入)，实际=${grantAudResp.statusCode} body=${grantAudResp.body}`,
    );

    const opCookie = await loginAdmin(app, "operator");
    const grantOpResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: opCookie, "Content-Type": "application/json" },
      payload: { userId: user.id, resourceType: "membership_channel", resourceId: TEST_KNOWN_IDS.membershipProductKey, reason: "越权测试：运营不能发", durationDays: 3 },
    });
    assert.equal(
      grantOpResp.statusCode, 403,
      `operator grant should be strictly 403 (路由已注册，不再允许 404 混入)，实际=${grantOpResp.statusCode} body=${grantOpResp.body}`,
    );

    const csCookie = await loginAdmin(app, "customerService");
    const grantCsResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: csCookie, "Content-Type": "application/json" },
      payload: { userId: user.id, resourceType: "membership_channel", resourceId: TEST_KNOWN_IDS.membershipProductKey, reason: "permission test: customer service cannot grant", durationDays: 3 },
    });
    assert.equal(
      grantCsResp.statusCode, 403,
      `customer service grant should be strictly 403 (权限收敛：CS 只能补发邀请/查权益，不再允许直授)，实际=${grantCsResp.statusCode} body=${grantCsResp.body}`,
    );

    // ===== 正向：super_admin 必须 201（确保权限收敛未误伤紧急售后唯一执行人） =====
    const saCookie = await loginAdmin(app, "superAdmin");
    const grantSaResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: saCookie, "Content-Type": "application/json" },
      payload: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: TEST_KNOWN_IDS.membershipProductKey,
        reason: "P2-5 正向：紧急售后 · 超管直授 3 天会员权益（验证未被误伤）",
        durationDays: 3,
      },
    });
    assert.equal(grantSaResp.statusCode, 201, `super_admin grant MUST succeed 201；实际=${grantSaResp.statusCode} body=${grantSaResp.body}`);
    const saBody = JSON.parse(grantSaResp.body);
    assert.equal(saBody.ok, true, "super_admin grant 返回 ok=true");
    assert.ok(saBody.entitlement?.id, "super_admin grant 返回体应包含 entitlement.id，实际=" + JSON.stringify(saBody));
    assert.equal(saBody.entitlement.userId, user.id, "super_admin grant: 生成的权益 userId 与请求一致");
    assert.equal(saBody.entitlement.resourceType, "membership_channel", "super_admin grant: resourceType 正确");
    assert.equal(saBody.entitlement.resourceId, TEST_KNOWN_IDS.membershipProductKey, "super_admin grant: resourceId 正确");
    assert.equal(saBody.entitlement.status, "active", "super_admin grant: 权益生成即 active，无需等订单");
    const exp = new Date(saBody.entitlement.expiresAt).getTime();
    const minExp = Date.now() + (3 * 86400 - 60) * 1000; // 3 天 - 1 分钟容差
    const maxExp = Date.now() + (3 * 86400 + 60) * 1000; // 3 天 + 1 分钟容差
    assert.ok(exp >= minExp && exp <= maxExp,
      `super_admin grant durationDays=3 预期 expiresAt ≈ now+3d，实际 ${new Date(exp).toISOString()}，范围 ${new Date(minExp).toISOString()} ~ ${new Date(maxExp).toISOString()}`);
    const auditCount = await prisma.adminAuditLog.count({
      where: { action: "admin.entitlement.grant", objectId: saBody.entitlement.id, objectType: "entitlement" },
    });
    assert.equal(auditCount, 1, "super_admin 直授后 adminAuditLog 必须有且仅有 1 条 admin.entitlement.grant 审计记录，实际=" + auditCount);
  } finally {
    await app.close();
  }
});

// =====================================================================
// P3 系列（channel 权限越权 · D2-1 最严：仅 super_admin 能 view/refresh/add/reveal_id）
// =====================================================================
test("越权P3-1：customer_service / auditor / operator / finance 调用 channel:view（GET /admin/channels）必须 403；super_admin=200", async () => {
  const app = await createApp(prisma);
  try {
    const expectations = [
      { role: "customerService", name: "客服" },
      { role: "auditor", name: "审计" },
      { role: "operator", name: "运营" },
      { role: "finance", name: "财务" },
    ] as const;
    for (const t of expectations) {
      const ck = await loginAdmin(app, t.role as any);
      const r = await app.inject({ method: "GET", url: "/api/admin/channels?pageSize=10", headers: { cookie: ck } });
      assert.equal(r.statusCode, 403, `P3-1 ${t.name} view channels MUST=403，实际=${r.statusCode} body=${r.body}`);
    }
    // 正向：super_admin = 200（即使是空列表）
    const saCk = await loginAdmin(app, "superAdmin");
    const r = await app.inject({ method: "GET", url: "/api/admin/channels?pageSize=10", headers: { cookie: saCk } });
    assert.equal(r.statusCode, 200, `P3-1 super_admin view channels MUST=200，实际=${r.statusCode} body=${r.body}`);
  } finally { await app.close(); }
});

test("越权P3-2：非 super_admin 调 refresh（POST /admin/channels/refresh）必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const ck = await loginAdmin(app, "operator");
    const r = await app.inject({
      method: "POST", url: "/api/admin/channels/refresh",
      headers: { cookie: ck, "Content-Type": "application/json" },
      payload: { reason: "P3-2 op refresh 越权", force: false },
    });
    assert.equal(r.statusCode, 403, `P3-2 operator refresh MUST 403，实际=${r.statusCode} body=${r.body}`);
  } finally { await app.close(); }
});

test("越权P3-3：非 super_admin 调 add（POST /admin/channels）必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const ck = await loginAdmin(app, "auditor");
    const r = await app.inject({
      method: "POST", url: "/api/admin/channels",
      headers: { cookie: ck, "Content-Type": "application/json" },
      payload: { chatId: "-1004360193327", reason: "P3-3 auditor add channel 越权" },
    });
    assert.equal(r.statusCode, 403, `P3-3 auditor add MUST 403，实际=${r.statusCode} body=${r.body}`);
  } finally { await app.close(); }
});

test("越权P3-4：非 super_admin 调 reveal-id（POST /admin/channels/:chatId/reveal-id）必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const ck = await loginAdmin(app, "customerService");
    const r = await app.inject({
      method: "POST", url: "/api/admin/channels/-1004360193327/reveal-id",
      headers: { cookie: ck, "Content-Type": "application/json" },
      payload: { reason: "P3-4 CS 试图看真实频道 ID 越权" },
    });
    assert.equal(r.statusCode, 403, `P3-4 CS reveal-id MUST 403，实际=${r.statusCode} body=${r.body}`);
  } finally { await app.close(); }
});

test("频道登记请求列表绝不回传私密邀请链接明文", async () => {
  const app = await createApp(prisma);
  try {
    const superCookie = await loginAdmin(app, "superAdmin");
    const submitResp = await app.inject({
      method: "POST",
      url: "/api/admin/channels/discovery-requests",
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        channelLink: "https://t.me/+PrivateInviteSecret123",
        purpose: "membership_main",
        reason: "测试私密邀请链接脱敏",
      },
    });
    assert.equal(submitResp.statusCode, 201, submitResp.body);

    const listResp = await app.inject({
      method: "GET",
      url: "/api/admin/channels/discovery-requests",
      headers: { cookie: superCookie },
    });
    assert.equal(listResp.statusCode, 200, listResp.body);
    const items = (listResp.json() as any).items || [];
    const row = items.find((item: any) => item.linkType === "private_invite");
    assert.ok(row, "must contain private invite discovery row");
    assert.equal(row.submittedLink, "私密邀请已提交");
    assert.equal(row.normalizedLink, null);
    assert.ok(!JSON.stringify(row).includes("PrivateInviteSecret123"), "private invite token must never be exposed");
  } finally {
    await app.close();
  }
});
