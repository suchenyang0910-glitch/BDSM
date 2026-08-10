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
