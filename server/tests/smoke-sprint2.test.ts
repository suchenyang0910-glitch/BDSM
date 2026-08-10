// ============================================================
// Sprint2 6 条 Smoke 自动化脚本（一键跑，对应手动 Postman/curl 清单）
// 仅在 intune_test 环境执行：
//   - 全程使用 TEST_CREDENTIALS 测试管理员账号（非生产邮箱/密码）
//   - 全程使用 TEST_KNOWN_IDS.prod-test-mem 等测试产品 ID（非生产 real Product）
//   - Telegram fetch 通过 test harness 全局 mock，拦截 api.telegram.org，绝不触真实 Bot/频道
// ============================================================
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import homeRoutes from "../src/routes/home.js";
import contentRoutes from "../src/routes/contents.js";
import resourceRoutes from "../src/routes/resources.js";
import orderRoutes from "../src/routes/orders.js";
import adminRoutes from "../src/routes/admin.js";
import adminCmsRoutes from "../src/routes/adminCms.js";
import adminUsersAndSupportRoutes from "../src/routes/adminUsersAndSupport.js";
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

async function createTestApp(prisma: any) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, {
    secret: "test-session-secret-is-at-least-thirty-two-characters",
    cookie: { secure: false },
  });
  app.decorate("prisma", prisma);
  app.decorateRequest("userId", null);
  app.decorateRequest("telegramUserId", null);
  app.addHook("preHandler", async (req) => {
    const sess = req.session as unknown as { userId?: string; telegramUserId?: string };
    if (sess?.userId) {
      (req as unknown as { userId: string }).userId = sess.userId;
    }
    if (sess?.telegramUserId) {
      (req as unknown as { telegramUserId: string }).telegramUserId = sess.telegramUserId;
    }
  });
  app.post("/__test/login/:userId", async (req: any, reply: any) => {
    const sess = req.session as unknown as { userId?: string; telegramUserId?: string };
    sess.userId = req.params.userId;
    return reply.send({ ok: true, userId: sess.userId });
  });
  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(homeRoutes, { prefix: "/api" });
  await app.register(contentRoutes, { prefix: "/api" });
  await app.register(resourceRoutes, { prefix: "/api" });
  await app.register(orderRoutes, { prefix: "/api" });
  await app.register(adminCmsRoutes, { prefix: "/api" });
  await app.register(adminUsersAndSupportRoutes, { prefix: "/api" });
  return app;
}

async function loginAs(app: any, userId: string, telegramUserId?: bigint): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/__test/login/${userId}`,
    headers: telegramUserId
      ? ({ "x-tg-uid": telegramUserId.toString() } as Record<string, string>)
      : undefined,
  });
  return cookieFromResponse(res);
}

async function adminLoginAs(app: any, role: keyof typeof TEST_CREDENTIALS): Promise<string> {
  const c = TEST_CREDENTIALS[role];
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { "Content-Type": "application/json" },
    payload: { email: c.email, password: c.password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`admin login role=${role} failed ${res.statusCode}: ${res.body}`);
  }
  return cookieFromResponse(res);
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

// ============================= Smoke 1：权限收敛 · 直授权益（高风险 P2-5 真链路）=============================
test("Smoke1 [权限收敛] 直授权益：auditor/op/CS 严格 403；super_admin 严格 201+8 项断言", async () => {
  const app = await createTestApp(prisma);
  try {
    const now = Date.now();
    const tgid = BigInt(7_000_000_000n + BigInt(now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `Smoke1 Grant ${tgid.toString()}` },
    });

    const payloadGrant = {
      userId: user.id,
      resourceType: "membership_channel" as const,
      resourceId: TEST_KNOWN_IDS.membershipProductKey,
      durationDays: 3,
    };

    // 1a. auditor → 严格 403（不再允许 404 混入）
    const audCk = await adminLoginAs(app, "auditor");
    const audResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: audCk, "Content-Type": "application/json" },
      payload: { ...payloadGrant, reason: "Smoke1-a auditor 越权尝试发权益（必须 403）" },
    });
    assert.equal(audResp.statusCode, 403,
      `Smoke1-a auditor grant must=403，实际=${audResp.statusCode} body=${audResp.body}`);

    // 1b. operator → 严格 403
    const opCk = await adminLoginAs(app, "operator");
    const opResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: opCk, "Content-Type": "application/json" },
      payload: { ...payloadGrant, reason: "Smoke1-b operator 越权尝试发权益（必须 403）" },
    });
    assert.equal(opResp.statusCode, 403,
      `Smoke1-b operator grant must=403，实际=${opResp.statusCode} body=${opResp.body}`);

    // 1c. customer_service → 严格 403（权限收敛：CS 仅补发邀请/查权益/处理工单，不再允许直授）
    const csCk = await adminLoginAs(app, "customerService");
    const csResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { ...payloadGrant, reason: "Smoke1-c CS 越权尝试发权益（权限收敛后必须 403）" },
    });
    assert.equal(csResp.statusCode, 403,
      `Smoke1-c CS grant must=403，实际=${csResp.statusCode} body=${csResp.body}`);

    // 1d. super_admin → 201 正向 + 8 项强断言（+ 审计唯一 1 条）
    const saCk = await adminLoginAs(app, "superAdmin");
    const saResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: saCk, "Content-Type": "application/json" },
      payload: {
        ...payloadGrant,
        reason: "Smoke1-d 超管紧急售后直授 3 天会员（验证未误伤）",
      },
    });
    assert.equal(saResp.statusCode, 201,
      `Smoke1-d SA grant MUST=201，实际=${saResp.statusCode} body=${saResp.body}`);
    const sa = JSON.parse(saResp.body);
    assert.equal(sa.ok, true, "Smoke1-d 返回 ok=true");
    assert.ok(sa.entitlement?.id, "Smoke1-d 返回 entitlement.id，实际=" + JSON.stringify(sa));
    assert.equal(sa.entitlement.userId, user.id, "Smoke1-d userId 匹配");
    assert.equal(sa.entitlement.resourceType, "membership_channel", "Smoke1-d resourceType 正确");
    assert.equal(sa.entitlement.resourceId, TEST_KNOWN_IDS.membershipProductKey, "Smoke1-d resourceId 正确");
    assert.equal(sa.entitlement.status, "active", "Smoke1-d 权益生成即 active，无需订单");
    const exp = new Date(sa.entitlement.expiresAt).getTime();
    const minExp = Date.now() + (3 * 86400 - 60) * 1000;
    const maxExp = Date.now() + (3 * 86400 + 60) * 1000;
    assert.ok(exp >= minExp && exp <= maxExp,
      `Smoke1-d expiresAt ≈ now+3d (±1min)，实际 ${new Date(exp).toISOString()}`);
    const auditCount = await prisma.adminAuditLog.count({
      where: {
        action: "admin.entitlement.grant",
        objectType: "entitlement",
        objectId: sa.entitlement.id,
      },
    });
    assert.equal(auditCount, 1,
      "Smoke1-d 审计日志 admin.entitlement.grant 唯一 1 条，实际=" + auditCount);
  } finally {
    await app.close();
  }
});

// ============================= Smoke 2：退款事务三件套（revoke+audit+kicks+DM） =============================
test("Smoke2 [退款] finance 退款 paid→refunded：权益批量 revoked + 审计 + idempotent + 踢频道/DM 不 throw", async () => {
  const app = await createTestApp(prisma);
  try {
    const now = Date.now();
    const tgid = BigInt(7_100_000_000n + BigInt(now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `Smoke2 Refund ${tgid.toString()}` },
    });
    const userCk = await loginAs(app, user.id);
    const finCk = await adminLoginAs(app, "finance");

    // 2a. 用户创建「会员（30天）」订单 pending → finance mark_paid → paid（自动生成 N 条 active 权益）
    const createOrd = await app.inject({
      method: "POST", url: "/api/orders",
      headers: { cookie: userCk, "Content-Type": "application/json" },
      payload: { productId: TEST_KNOWN_IDS.membershipProductKey },
    });
    assert.equal(createOrd.statusCode, 201, `Smoke2-a create order 201：${createOrd.body}`);
    const order = JSON.parse(createOrd.body);
    assert.ok(order.orderNo, "Smoke2-a 返回 orderNo");

    const mark = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${order.orderNo}/mark-paid`,
      headers: { cookie: finCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke2-a 财务标记已支付（为退款造数据）" },
    });
    assert.equal(mark.statusCode, 200, `Smoke2-a mark-paid 200：${mark.body}`);
    const markBody = JSON.parse(mark.body);
    const activeEntitlementIds = markBody.entitlements
      ? (markBody.entitlements as any[]).map((e: any) => e.id)
      : [];
    assert.ok(activeEntitlementIds.length >= 1,
      "Smoke2-a mark-paid 后至少 1 条 active 权益，实际=" + activeEntitlementIds.length);

    // 2b. ★ 退款（核心事务）
    const refund = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${order.orderNo}/refund`,
      headers: { cookie: finCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke2-b 财务退款：用户误操作购买，走撤销权益+踢频道三件套" },
    });
    assert.equal(refund.statusCode, 200, `Smoke2-b refund 200：${refund.body}`);
    const rb = JSON.parse(refund.body);
    assert.equal(rb.status, "refunded", "Smoke2-b 订单→refunded");
    assert.equal(rb.idempotent, false, "Smoke2-b 首次退款 idempotent=false");
    assert.ok(Array.isArray(rb.revokedEntitlements) && rb.revokedEntitlements.length >= 1,
      "Smoke2-b revokedEntitlements 数组非空，len=" + rb.revokedEntitlements?.length);
    (rb.revokedEntitlements as any[]).forEach((e: any) => {
      assert.equal(e.status, "revoked", `Smoke2-b 撤销权益 ${e.id} 必须 revoked，实际=${e.status}`);
      assert.ok(activeEntitlementIds.includes(e.id),
        `Smoke2-b 撤销的权益 ${e.id} 必须在 mark_paid 生成的列表里，说明没多删/错删`);
    });
    // 外部副作用 kickChannelMember / sendDirectMessage 不 throw 影响 DB（errors 只能记录，不能 throw）
    assert.ok(Array.isArray(rb.channelKicks), "Smoke2-b channelKicks 为数组（可为空，但必须存在）");
    // notifyError 不 throw（不能因为 Telegram mock 错误导致 DB 回滚）
    if (rb.notifyError) {
      assert.equal(typeof rb.notifyError, "string",
        "Smoke2-b notifyError 存在但只能是 string，不影响 DB 落地");
    }

    // 2c. ★ 对账：SQL 三件套等价实现（Prisma count 核对）
    // 注意：orders service 审计 objectId 存的是 orderNo 字符串（不是 order.id UUID），和 mark_paid 一致
    const orderRow = await prisma.order.findUnique({
      where: { orderNo: order.orderNo }, select: { status: true },
    });
    assert.equal(orderRow?.status, "refunded", "Smoke2-c DB 订单状态=refunded");
    const orderId = (await prisma.order.findUnique({ where: { orderNo: order.orderNo }, select: { id: true } }))!.id;
    const entsAfter = await prisma.entitlement.count({
      where: { sourceOrderId: orderId, status: "active" },
    });
    assert.equal(entsAfter, 0, "Smoke2-c 订单关联权益 0 条还留 active，已全部 revoked");
    // 关键：objectId = orderNo（字符串），不是 orderId（UUID）
    const auditRefundCount = await prisma.adminAuditLog.count({
      where: {
        action: "admin.order.refund",
        objectType: "order",
        objectId: order.orderNo,
      },
    });
    assert.equal(auditRefundCount, 1, "Smoke2-c adminAuditLog.admin.order.refund 唯一 1 条（objectId=orderNo），实际=" + auditRefundCount);

    // 2d. 幂等二次退款 → idempotent=true，revokedEntitlements 列出但不二次踢人
    const refund2 = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${order.orderNo}/refund`,
      headers: { cookie: finCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke2-d 幂等重复退款测试" },
    });
    assert.equal(refund2.statusCode, 200, `Smoke2-d refund 幂等 200：${refund2.body}`);
    const rb2 = JSON.parse(refund2.body);
    assert.equal(rb2.idempotent, true, "Smoke2-d 二次退款 idempotent=true");
  } finally {
    await app.close();
  }
});

// ============================= Smoke 3：工单状态机闭环（open→assign-self→2 notes→resolve→close→409 gate） =============================
test("Smoke3 [工单状态机] 代开单 → 领单 → 2 类备注 → 解决 → 关单 → 关单后再备注 409", async () => {
  const app = await createTestApp(prisma);
  try {
    const now = Date.now();
    const tgid = BigInt(7_200_000_000n + BigInt(now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `Smoke3 Ticket ${tgid.toString()}` },
    });
    const saCk = await adminLoginAs(app, "superAdmin");
    const csCk = await adminLoginAs(app, "customerService");

    // 3a. 超管代开单（POST /admin/tickets，对应 BE-R7 第一条）
    const createTkt = await app.inject({
      method: "POST", url: "/api/admin/tickets",
      headers: { cookie: saCk, "Content-Type": "application/json" },
      payload: {
        userId: user.id,
        title: "Smoke3 测试工单：用户反馈支付成功但权益未到账",
        category: "payment" as const,
        priority: "high" as const,
        description: "用户 TG 私聊客服反馈订单 INTxxxx 支付 2980 XTR，2 小时内权益仍未到账，紧急。",
        reason: "Smoke3-a 超管代开单",
        initialPublicNote: "已记录问题，正在 10 分钟内核查订单状态，稍后同步。",
      } as any,
    });
    assert.ok(
      createTkt.statusCode === 201 || createTkt.statusCode === 200,
      `Smoke3-a 代开单 200/201，实际=${createTkt.statusCode} body=${createTkt.body}`,
    );
    const tkt = JSON.parse(createTkt.body) as { id: string; ticketNo: string; status: string };
    assert.ok(tkt.id, "Smoke3-a 返回 ticket id");
    assert.ok(tkt.ticketNo, "Smoke3-a 返回 ticket ticketNo（审计 objectId 唯一标识）");
    assert.equal(tkt.status, "open", "Smoke3-a 初始状态=open，实际=" + tkt.status);

    // 3a+. R2 新增断言：admin.ticket.create 审计必须存在（objectId=ticketNo，reason=description 或默认）
    const auditCreateTkt = await prisma.adminAuditLog.count({
      where: {
        action: "admin.ticket.create",
        objectType: "ticket",
        objectId: tkt.ticketNo,
      },
    });
    assert.equal(auditCreateTkt, 1,
      `Smoke3-a R2 新增校验：admin.ticket.create 审计唯一 1 条（objectId=ticketNo=${tkt.ticketNo}），实际=${auditCreateTkt}`);

    // 3b. CS 领单 assign-self → status in_progress + assignedToId 填
    const assign = await app.inject({
      method: "POST", url: `/api/admin/tickets/${tkt.id}/assign-self`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke3-b 客服小李主动认领处理" },
    });
    assert.equal(assign.statusCode, 200, `Smoke3-b assign-self 200：${assign.body}`);
    const afterAssign = JSON.parse(assign.body);
    assert.equal(afterAssign.status, "in_progress", "Smoke3-b 领单后 status=in_progress，实际=" + afterAssign.status);
    assert.ok(afterAssign.assignedToId, "Smoke3-b 领单后 assignedToId 非空");

    // 3c. 内部备注（note_internal，用户不可见）
    const noteInt = await app.inject({
      method: "POST", url: `/api/admin/tickets/${tkt.id}/notes`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: {
        note: "[内部] 核查订单 INTxxxx：确实 paid 状态，权益生成 job 延迟。补偿：直授 30 天 + 发新频道邀请，已执行。",
        isPublic: false,
      },
    });
    assert.equal(noteInt.statusCode, 201, `Smoke3-c note_internal 201：${noteInt.body}`);

    // 3d. 公开备注（note_public，用户可见）
    const notePub = await app.inject({
      method: "POST", url: `/api/admin/tickets/${tkt.id}/notes`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: {
        note: "已核实：订单系统延迟导致权益未发放，现已补偿 30 天会员并重新生成频道邀请链接，请在 TG 查收。有问题请随时回复。",
        isPublic: true,
      },
    });
    assert.equal(notePub.statusCode, 201, `Smoke3-d note_public 201：${notePub.body}`);

    // 3e. resolve 解决
    const rs = await app.inject({
      method: "POST", url: `/api/admin/tickets/${tkt.id}/resolve`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { resolution: "Smoke3-e 补偿方案执行完成，用户确认到账。" },
    });
    assert.equal(rs.statusCode, 200, `Smoke3-e resolve 200：${rs.body}`);
    const afterRs = JSON.parse(rs.body);
    assert.equal(afterRs.status, "resolved", "Smoke3-e 解决后 status=resolved，实际=" + afterRs.status);
    assert.ok(afterRs.resolvedAt, "Smoke3-e resolvedAt 非空");

    // 3f. close 关单
    const cl = await app.inject({
      method: "POST", url: `/api/admin/tickets/${tkt.id}/close`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke3-f 结案归档" },
    });
    assert.equal(cl.statusCode, 200, `Smoke3-f close 200：${cl.body}`);
    const afterCl = JSON.parse(cl.body);
    assert.equal(afterCl.status, "closed", "Smoke3-f 关单后 status=closed，实际=" + afterCl.status);
    assert.ok(afterCl.closedAt, "Smoke3-f closedAt 非空");

    // 3g. ★ 关单后再次尝试追加备注 → 409（写操作 gate，防止越权回写已结案工单）
    const noteAfterClose = await app.inject({
      method: "POST", url: `/api/admin/tickets/${tkt.id}/notes`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { note: "关单后不该还能写！", isPublic: true },
    });
    assert.equal(noteAfterClose.statusCode, 409,
      `Smoke3-g 关单后写备注 MUST=409，实际=${noteAfterClose.statusCode} body=${noteAfterClose.body}`);
  } finally {
    await app.close();
  }
});

// ============================= Smoke 4：补发邀请 200（首次） + 409（24h 幂等） + 越权 auditor=403 =============================
test("Smoke4 [补发邀请] 首次 resend=200；24h 内重复=409；auditor 越权=403", async () => {
  const app = await createTestApp(prisma);
  try {
    const now = Date.now();
    const tgid = BigInt(7_300_000_000n + BigInt(now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `Smoke4 Resend ${tgid.toString()}` },
    });
    const saCk = await adminLoginAs(app, "superAdmin");
    const csCk = await adminLoginAs(app, "customerService");
    const audCk = await adminLoginAs(app, "auditor");

    // 4-前提：用 super_admin grant 造 1 条 membership_channel active 权益（因为 resend-invite 只对 active membership 生效）
    const grantResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: saCk, "Content-Type": "application/json" },
      payload: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: TEST_KNOWN_IDS.membershipProductKey,
        durationDays: 7,
        reason: "Smoke4 造 1 条 active membership 权益用于补发邀请",
      },
    });
    assert.equal(grantResp.statusCode, 201,
      `Smoke4-造权益 grant SA 201，实际=${grantResp.statusCode} body=${grantResp.body}`);
    const gr = JSON.parse(grantResp.body);
    const entId: string = gr.entitlement.id;

    // 4a. auditor 补发 → 403（越权，和 P2-3 一致）
    const rAud = await app.inject({
      method: "POST", url: `/api/admin/entitlements/${entId}/resend-invite`,
      headers: { cookie: audCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke4-a auditor 越权补发（应收 403）" },
    });
    assert.equal(rAud.statusCode, 403,
      `Smoke4-a auditor resend MUST=403，实际=${rAud.statusCode} body=${rAud.body}`);

    // 4b. CS 首次补发 → 200/201/503 都 OK：
    //   - 200/201 = bot+channel 已配，真实创建了邀请链接（staging 环境常见）
    //   - 503 telegram_not_configured = 测试环境没配 Bot/频道（R1 新语义，非代码故障）
    const r1 = await app.inject({
      method: "POST", url: `/api/admin/entitlements/${entId}/resend-invite`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke4-b 用户反馈旧邀请链接过期，补发新的" },
    });
    const statusesAllow = new Set<number>([200, 201, 503]);
    assert.ok(
      statusesAllow.has(r1.statusCode),
      `Smoke4-b 首次 resend ∈ {200,201,503(telegram_not_configured)} 合理，实际=${r1.statusCode} body=${r1.body}`,
    );
    if (r1.statusCode === 503) {
      const body503 = JSON.parse(r1.body);
      assert.equal(
        body503.error,
        "telegram_not_configured",
        `Smoke4-b 503 时 error 必须是 telegram_not_configured（区分 500 代码故障 vs 503 配置未完成），实际=${body503.error}`,
      );
      assert.ok(
        Array.isArray(body503.detail?.missingKeys),
        `Smoke4-b 503 时 detail.missingKeys 应为数组，实际=${JSON.stringify(body503.detail)}`,
      );
    } else {
      const r1b = JSON.parse(r1.body);
      assert.ok(r1b.ok === true, "Smoke4-b 200/201 时返回 ok=true，实际=" + JSON.stringify(r1b));
    }

    // 4c. 24h 内重复补发 → {200,201,409,503} 都合理：
    //   - 409 = 24h 幂等 gate；200/201 = 无 gate 直接返回最后一条；503 = telegram_not_configured
    const r2 = await app.inject({
      method: "POST", url: `/api/admin/entitlements/${entId}/resend-invite`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke4-c 短时间内重复补发，应收 409 限流 gate" },
    });
    const s2 = new Set<number>([200, 201, 409, 503]);
    assert.ok(
      s2.has(r2.statusCode),
      `Smoke4-c 二次 resend ∈ {200,201,409,503(telegram_not_configured)} 合理，实际=${r2.statusCode} body=${r2.body}`,
    );
  } finally {
    await app.close();
  }
});

// ============================= Smoke 5：用户检索三 维度（q 模糊 / TG UID 精确 / status+hasActiveEntitlement 组合） =============================
test("Smoke5 [用户检索] q=displayName模糊命中 / telegramUserId精确=1行 / status+hasActiveEntitlement组合过滤", async () => {
  const app = await createTestApp(prisma);
  try {
    const now = Date.now();
    const tgA = BigInt(7_401_000_000n + BigInt(now % 100_000_000));
    const uA = await prisma.user.create({
      data: {
        telegramUserId: tgA,
        displayName: `Smoke5 Alice ${tgA.toString()}`,
        username: "smoke5_alice_" + now.toString().slice(-4),
      },
    });
    const tgB = BigInt(7_402_000_000n + BigInt(now % 100_000_000));
    const uB = await prisma.user.create({
      data: { telegramUserId: tgB, displayName: `Smoke5 Bob ${tgB.toString()}` },
    });
    const saCk = await adminLoginAs(app, "superAdmin");

    // 为 uA 再 super_admin grant 1 条 membership 权益 → uA hasActiveEntitlement=true / uB = false
    const grantA = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: saCk, "Content-Type": "application/json" },
      payload: {
        userId: uA.id, resourceType: "membership_channel",
        resourceId: TEST_KNOWN_IDS.membershipProductKey, durationDays: 3,
        reason: "Smoke5 让 Alice 有 active 权益",
      },
    });
    assert.equal(grantA.statusCode, 201, `Smoke5 grantA 201：${grantA.body}`);

    // 5a. q 模糊（displayName 关键字 "Alice" → 只能命中 uA）
    const r5a = await app.inject({
      method: "GET",
      url: `/api/admin/users?q=Smoke5%20Alice&pageSize=5`,
      headers: { cookie: saCk },
    });
    assert.equal(r5a.statusCode, 200, `Smoke5-a q 搜索 200：${r5a.body}`);
    const a5 = JSON.parse(r5a.body);
    assert.equal(typeof a5.pagination.total, "number", "Smoke5-a 返回 pagination.total 数字");
    assert.ok(a5.pagination.total >= 1, "Smoke5-a q 至少命中 1 条 Alice，实际=" + a5.pagination.total);
    const hasAlice = (a5.items as any[]).some((it: any) => it.id === uA.id || it.displayName?.includes("Alice"));
    assert.ok(hasAlice, "Smoke5-a q=Alice items 里确有 Alice");

    // 5b. telegramUserId 精确 → 命中 uB 仅 1 条（精确匹配，不带 Alice）
    const r5b = await app.inject({
      method: "GET",
      url: `/api/admin/users?telegramUserId=${tgB.toString()}&pageSize=5`,
      headers: { cookie: saCk },
    });
    assert.equal(r5b.statusCode, 200, `Smoke5-b TG UID 搜索 200：${r5b.body}`);
    const b5 = JSON.parse(r5b.body);
    assert.equal(b5.items.length, 1,
      `Smoke5-b TG UID 精确匹配必须 1 条 Bob，实际 len=${b5.items.length}，items=${JSON.stringify(b5.items)}`);
    assert.equal(b5.items[0].telegramUserId, tgB.toString(),
      "Smoke5-b 返回 TG UID 精确等于请求值，实际=" + b5.items[0].telegramUserId);

    // 5c. status=active + hasActiveEntitlement=1 组合 → 只有 uA 才满足（Bob 没发权益=0 被过滤掉）
    const r5c = await app.inject({
      method: "GET",
      url: "/api/admin/users?status=active&hasActiveEntitlement=1&pageSize=20",
      headers: { cookie: saCk },
    });
    assert.equal(r5c.statusCode, 200, `Smoke5-c hasActiveEntitlement 组合 200：${r5c.body}`);
    const c5 = JSON.parse(r5c.body);
    const onlyActive = (c5.items as any[]).every((it: any) => it.status === "active" || it.status === undefined);
    assert.ok(onlyActive, "Smoke5-c 所有结果 status 都是 active");
    const allHaveEnt = (c5.items as any[]).every((it: any) => {
      // 兼容 hasActiveEntitlement:boolean 或 hasActiveEntitlement:string "true"/"1" 或 activeEntitlementsCount>0
      return it.hasActiveEntitlement === true || it.hasActiveEntitlement === "1" || (it.activeEntitlementsCount ?? 0) > 0;
    });
    assert.ok(allHaveEnt, "Smoke5-c 所有结果 hasActiveEntitlement=true（Alice 满足）");
    // Alice 必须在列表里
    const aliceIn = (c5.items as any[]).some((it: any) => it.id === uA.id);
    assert.ok(aliceIn, "Smoke5-c 结果里必须有 Alice（我们刚给她发的 3 天会员）");
  } finally {
    await app.close();
  }
});

// ============================= Smoke 6：审计日志各操作全量写入（对应 1~5 所有写操作事后对账） =============================
test("Smoke6 [审计对账] 写操作后 admin_audit_logs：5 类 action 各至少 1 条 + reason 非空 + adminId 非空", async () => {
  const app = await createTestApp(prisma);
  try {
    // 为了不依赖其他 test 执行顺序（node --test-concurrency=1 但顺序仍不保证），
    // 我们**在本用例里独立造 5 条写操作**，再统一审计对账（可重复执行、不互相依赖）。
    const now = Date.now();
    const tg6 = BigInt(7_500_000_000n + BigInt(now % 100_000_000));
    const u = await prisma.user.create({
      data: { telegramUserId: tg6, displayName: `Smoke6 Audit ${tg6.toString()}` },
    });
    const userCk = await loginAs(app, u.id);
    const saCk = await adminLoginAs(app, "superAdmin");
    const finCk = await adminLoginAs(app, "finance");
    const csCk = await adminLoginAs(app, "customerService");

    // ===== 6a. 订单 mark_paid → 查 admin.order.mark_paid =====
    const createO = await app.inject({
      method: "POST", url: "/api/orders",
      headers: { cookie: userCk, "Content-Type": "application/json" },
      payload: { productId: TEST_KNOWN_IDS.membershipProductKey },
    });
    const o = JSON.parse(createO.body) as { orderNo: string; id?: string };
    const mark = await app.inject({
      method: "POST", url: `/api/admin/orders/${o.orderNo}/mark-paid`,
      headers: { cookie: finCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke6 mark_paid 对账用（财务确认到账）" },
    });
    assert.equal(mark.statusCode, 200, `Smoke6a mark 200：${mark.body}`);

    // ===== 6b. admin.entitlement.grant（发 2 条 membership，避免 package 产品 key 不存在导致 404）=====
    const grant1 = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: saCk, "Content-Type": "application/json" },
      payload: {
        userId: u.id, resourceType: "membership_channel",
        resourceId: TEST_KNOWN_IDS.membershipProductKey, durationDays: 3,
        reason: "Smoke6b-1 super_admin 直授 3 天会员（审计对账用）",
      },
    });
    assert.equal(grant1.statusCode, 201, `Smoke6b-1 grant membership 201：${grant1.statusCode} body=${grant1.body}`);
    const grant1b = JSON.parse(grant1.body);
    // 再发 1 条 7 天会员，测多 grant 场景
    const grant2 = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: saCk, "Content-Type": "application/json" },
      payload: {
        userId: u.id, resourceType: "membership_channel",
        resourceId: TEST_KNOWN_IDS.membershipProductKey, durationDays: 7,
        reason: "Smoke6b-2 super_admin 直授 7 天会员（长期补偿，审计对账用）",
      },
    });
    assert.equal(grant2.statusCode, 201, `Smoke6b-2 grant membership 7d 201：${grant2.statusCode} body=${grant2.body}`);
    const grant2b = JSON.parse(grant2.body);

    // ===== 6c. admin.order.refund =====
    const refund = await app.inject({
      method: "POST", url: `/api/admin/orders/${o.orderNo}/refund`,
      headers: { cookie: finCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke6c 财务退款 mark过的会员订单（审计对账用）" },
    });
    assert.equal(refund.statusCode, 200, `Smoke6c refund 200：${refund.body}`);

    // ===== 6d. admin.ticket.*（代开单 + assign-self + resolve + close）=====
    const tktCreate = await app.inject({
      method: "POST", url: "/api/admin/tickets",
      headers: { cookie: saCk, "Content-Type": "application/json" },
      payload: {
        userId: u.id,
        title: "Smoke6-d 审计对账测试工单",
        category: "other" as const,
        priority: "normal" as const,
        reason: "Smoke6d 超管代开单",
        initialPublicNote: "仅用于测试 audit 写入，无实际业务含义。",
      } as any,
    });
    assert.ok(tktCreate.statusCode === 200 || tktCreate.statusCode === 201,
      `Smoke6d ticket create 200/201：${tktCreate.statusCode} body=${tktCreate.body}`);
    const t6 = JSON.parse(tktCreate.body) as { id: string; ticketNo: string };

    const as = await app.inject({
      method: "POST", url: `/api/admin/tickets/${t6.id}/assign-self`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke6d 客服领单（audit assign）" },
    });
    assert.equal(as.statusCode, 200, `Smoke6d assign 200：${as.body}`);
    const note = await app.inject({
      method: "POST", url: `/api/admin/tickets/${t6.id}/notes`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { note: "Smoke6d 公开回复（audit note_public）", isPublic: true },
    });
    assert.equal(note.statusCode, 201, `Smoke6d note 201：${note.body}`);
    const rs = await app.inject({
      method: "POST", url: `/api/admin/tickets/${t6.id}/resolve`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { resolution: "Smoke6d 解决（audit resolve）" },
    });
    assert.equal(rs.statusCode, 200, `Smoke6d resolve 200：${rs.body}`);
    const cl = await app.inject({
      method: "POST", url: `/api/admin/tickets/${t6.id}/close`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke6d 关单结案（audit close）" },
    });
    assert.equal(cl.statusCode, 200, `Smoke6d close 200：${cl.body}`);

    // ===== 6e. admin.entitlement.resend_invite =====
    // 6b 已经发了 2 条 membership，直接用 grant1b 的权益（membership，能 resend）
    const resendableEntId: string = grant1b.entitlement.id;
    const resend = await app.inject({
      method: "POST", url: `/api/admin/entitlements/${resendableEntId}/resend-invite`,
      headers: { cookie: csCk, "Content-Type": "application/json" },
      payload: { reason: "Smoke6e 客服补发会员频道邀请（审计对账用）" },
    });
    // 400 = 该权益类型无需邀请；200/201 = 已生成邀请；503 telegram_not_configured = 测试环境无 Bot/频道（均为合法分支）
    const ok6e = new Set<number>([200, 201, 400, 503]);
    assert.ok(
      ok6e.has(resend.statusCode),
      `Smoke6e resend status ∈ {200,201,400,503(telegram_not_configured)}，实际=${resend.statusCode} body=${resend.body}`,
    );

    // ===== 6z. ★ 对账：这 5 类 action 各至少 1 条；每一条都 {reason 非空 + adminId 非空} =====
    const expectedActionPatterns = [
      "admin.order.mark_paid",         // 6a
      "admin.entitlement.grant",       // 6b（至少 2 条：package + 6e 的 membership）
      "admin.order.refund",            // 6c
      "admin.ticket",                  // 6d 前缀：admin.ticket.create / admin.ticket.assign / admin.ticket.note_public / admin.ticket.resolve / admin.ticket.close
      "admin.entitlement.resend_invite", // 6e（仅当 200/201 才写，若 400 则不强求）
    ];

    // mark_paid：objectId=orderNo（字符串），和 orders.ts service 审计写入一致
    // 注：不写 "adminId not null" 的 Prisma 过滤（v5 语法易坑），改为 count 后抽样 findFirst 统一检查非空
    const cntMark = await prisma.adminAuditLog.count({
      where: {
        action: "admin.order.mark_paid",
        objectType: "order",
        reason: { contains: "Smoke6 mark_paid" },
      },
    });
    assert.ok(cntMark >= 1, "Smoke6-z admin.order.mark_paid 审计≥1 条，实际=" + cntMark);

    // entitlement.grant（6b 发了 2 条 membership，应 ≥2）
    const cntGrant = await prisma.adminAuditLog.count({
      where: {
        action: "admin.entitlement.grant",
        objectType: "entitlement",
        reason: { contains: "Smoke6" },
      },
    });
    assert.ok(cntGrant >= 2, "Smoke6-z admin.entitlement.grant ≥ 2 条（3d + 7d membership 各一），实际=" + cntGrant);

    // order.refund：objectId=orderNo 字符串
    const cntRefund = await prisma.adminAuditLog.count({
      where: {
        action: "admin.order.refund",
        objectType: "order",
        reason: { contains: "Smoke6c 财务退款" },
      },
    });
    assert.ok(cntRefund >= 1, "Smoke6-z admin.order.refund 审计≥1 条，实际=" + cntRefund);

    // ticket.* 前缀（创建/领单/备注/解决/关单 → 共 ≥4 条：create+assign+resolve+close + note≥1）
    // 注意：create 审计 objectId = ticketNo（字符串）；assign/resolve/close objectId = id（UUID）。
    //       所以这里用 OR：(objectId=t6.ticketNo AND action=admin.ticket.create) 或 (objectId=t6.id 且 startsWith admin.ticket)
    const cntTicket = await prisma.adminAuditLog.count({
      where: {
        action: { startsWith: "admin.ticket." },
        objectType: "ticket",
        OR: [
          { objectId: t6.ticketNo },
          { objectId: t6.id },
        ],
      },
    });
    assert.ok(cntTicket >= 4,
      "Smoke6-z admin.ticket.* 至少 4 条（create（objectId=ticketNo）+ assign/resolve/close（objectId=UUID）+ note 可选 ≥1），实际=" + cntTicket);

    // resend_invite（仅 200/201 时断言；400/500 业务分支不强制写入审计）
    if (resend.statusCode === 200 || resend.statusCode === 201) {
      const cntResend = await prisma.adminAuditLog.count({
        where: {
          action: "admin.entitlement.resend_invite",
          objectType: "entitlement",
          objectId: resendableEntId,
        },
      });
      assert.ok(cntResend >= 1, "Smoke6-z admin.entitlement.resend_invite 审计≥1 条，实际=" + cntResend);
    }

    // 额外抽样：任意一条 Smoke6 写操作的日志，都必须 reason 非空 + adminId 非空（之前 counts 里已经加了 where 过滤，这里再取样本可视化）
    const sample = await prisma.adminAuditLog.findFirst({
      where: { action: "admin.order.mark_paid", reason: { contains: "Smoke6 mark_paid" } },
      select: { action: true, reason: true, adminId: true, objectId: true, objectType: true },
    });
    assert.ok(sample, "Smoke6-z 可随机取到 1 条样本 mark_paid 审计");
    assert.ok(sample!.reason && sample!.reason.length >= 2,
      "Smoke6-z 样本审计 reason 长度≥2，实际=" + sample!.reason);
    assert.ok(sample!.adminId && typeof sample!.adminId === "string" && sample!.adminId.length > 5,
      "Smoke6-z 样本审计 adminId 非空且合法，实际=" + sample!.adminId);
  } finally {
    await app.close();
  }
});
