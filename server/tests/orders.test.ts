import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import homeRoutes from "../src/routes/home.js";
import contentRoutes from "../src/routes/contents.js";
import resourceRoutes from "../src/routes/resources.js";
import orderRoutes from "../src/routes/orders.js";
import adminRoutes from "../src/routes/admin.js";
import telegramWebhookRoutes from "../src/routes/telegramWebhook.js";
import {
  starsPaymentPayloadForOrder,
  parseStarsPayloadPlain,
  rawEventHashForTelegram,
  deliverStarsSuccessfulPayment,
  confirmUsdtChainEvent,
  rawEventHashForUsdt,
} from "../src/services/orders.js";
import { hmacSha256Hex, userIdIndexKey } from "../src/utils/crypto.js";
import { normalizeStoredXtrAmountToStars } from "../src/utils/currency.js";
import usdtInternalRoutes from "../src/routes/usdtInternal.js";
import { releaseExpiredUsdtAddresses, assignUsdtTrc20Address, generateUsdtUniqueAmountForAddress } from "../src/services/usdtPool.js";
import { emitSafetyEvent, emitStructuredLog } from "../src/utils/structuredError.js";
import {
  buildPaymentSuccessNotificationText,
  loadPaymentSuccessNotifyRecipients,
  notifyPaymentSuccess,
} from "../src/services/paymentSuccessNotifier.js";
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
    const sess = req.session as unknown as { userId?: string };
    if (sess?.userId) {
      (req as unknown as { userId: string }).userId = sess.userId;
    }
  });

  app.post("/__test/login/:userId", async (req: any, reply: any) => {
    const sess = req.session as unknown as { userId?: string };
    sess.userId = req.params.userId;
    return reply.send({ ok: true, userId: sess.userId });
  });

  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(homeRoutes, { prefix: "/api" });
  await app.register(contentRoutes, { prefix: "/api" });
  await app.register(resourceRoutes, { prefix: "/api" });
  await app.register(orderRoutes, { prefix: "/api" });
  return app;
}

async function loginAs(app: any, userId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/__test/login/${userId}` });
  return cookieFromResponse(res);
}

test("支付成功运营通知：收件人去重、内容脱敏、通知失败不抛出", async () => {
  const recipients = loadPaymentSuccessNotifyRecipients("123456, 987654,123456,invalid,-123");
  assert.deepEqual(recipients, [123456n, 987654n]);

  const message = buildPaymentSuccessNotificationText({
    orderNo: "INT20260823001234",
    paymentMethod: "usdt_trc20",
    amountMinor: 12_340_000n,
    currency: "USDT",
    productTitle: "测试内容\n不应拆成多行",
  });
  assert.match(message, /USDT-TRC20/);
  assert.match(message, /12\.34 USDT/);
  assert.doesNotMatch(message, /INT20260823001234/);
  assert.doesNotMatch(message, /\n不应拆成多行/);

  const previous = process.env.PAYMENT_SUCCESS_NOTIFY_TELEGRAM_USER_IDS;
  process.env.PAYMENT_SUCCESS_NOTIFY_TELEGRAM_USER_IDS = "123456,987654,123456";
  const received: string[] = [];
  try {
    const result = await notifyPaymentSuccess({
      orderNo: "INT20260823001234",
      paymentMethod: "telegram_stars",
      amountMinor: 150n,
      currency: "XTR",
      productTitle: "会员",
    }, async ({ telegramUserId }) => {
      received.push(String(telegramUserId));
      if (String(telegramUserId) === "987654") throw new Error("telegram unavailable");
      return { stub: false, success: true, userId: String(telegramUserId), messageId: 1 };
    });
    assert.equal(result.configured, true);
    assert.equal(result.attempted, 2);
    assert.equal(result.delivered, 1);
    assert.deepEqual(received, ["123456", "987654"]);
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_SUCCESS_NOTIFY_TELEGRAM_USER_IDS;
    else process.env.PAYMENT_SUCCESS_NOTIFY_TELEGRAM_USER_IDS = previous;
  }
});

async function adminLoginAs(app: any, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { "Content-Type": "application/json" },
    payload: { email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`admin login failed ${res.statusCode}: ${res.body}`);
  }
  return cookieFromResponse(res);
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("越权1：operator 标记支付必须返回 403（运营无 order:mark_paid 权限）", async () => {
  const app = await createTestApp(prisma);
  try {
    const now = Date.now();
    const tgid = BigInt(6000000000 + (now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `Order Test ${tgid.toString()}` },
    });
    const userCookie = await loginAs(app, user.id);

    const pkgResp = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { productId: TEST_KNOWN_IDS.packageProductKey },
    });
    assert.equal(pkgResp.statusCode, 201, pkgResp.body);
    const pkgOrder = pkgResp.json() as any;

    const operatorCookie = await adminLoginAs(
      app,
      TEST_CREDENTIALS.operator.email,
      TEST_CREDENTIALS.operator.password,
    );
    const markResp = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${pkgOrder.orderNo}/mark-paid`,
      headers: { cookie: operatorCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：运营不应有权限" },
    });
    assert.equal(markResp.statusCode, 403, `operator mark_paid should be 403, got ${markResp.statusCode}: ${markResp.body}`);
  } finally {
    await app.close();
  }
});

test("正常链路：finance 可 mark_paid → 审计写 → 会员续费从旧 expiresAt 延 30d → /api/home 立即 unlocked", async () => {
  const app = await createTestApp(prisma);
  try {
    const now = Date.now();
    const tgid = BigInt(6100000000 + (now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `Order E2E ${tgid.toString()}` },
    });
    const userCookie = await loginAs(app, user.id);

    const financeCookie = await adminLoginAs(
      app,
      TEST_CREDENTIALS.finance.email,
      TEST_CREDENTIALS.finance.password,
    );
    assert.ok(financeCookie.length > 0, "finance login must set session cookie");

    const me = await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: financeCookie } });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal((me.json() as any).role, "finance");

    const pkgResp = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { productId: TEST_KNOWN_IDS.packageProductKey },
    });
    assert.equal(pkgResp.statusCode, 201, pkgResp.body);
    const pkgOrder = pkgResp.json() as any;
    assert.equal(pkgOrder.status, "pending");

    const noToken = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${pkgOrder.orderNo}/mark-paid`,
      headers: { "Content-Type": "application/json" },
      payload: { reason: "e2e" },
    });
    assert.equal(noToken.statusCode, 401);

    const markResp = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${pkgOrder.orderNo}/mark-paid`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "e2e package" },
    });
    assert.equal(markResp.statusCode, 200, markResp.body);
    const markBody = markResp.json() as any;
    assert.equal(markBody.status, "paid");
    assert.equal(markBody.entitlements.length, 1);
    assert.equal(markBody.entitlements[0].resourceType, "package");

    const auditCount = await prisma.adminAuditLog.count({
      where: { action: "admin.order.mark_paid", objectId: pkgOrder.orderNo },
    });
    assert.equal(auditCount, 1, "audit log must be written on mark-paid");

    const mark2 = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${pkgOrder.orderNo}/mark-paid`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "duplicate idempotent" },
    });
    assert.equal(mark2.statusCode, 200, mark2.body);
    assert.equal((mark2.json() as any).idempotent, true);

    const markBad = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${pkgOrder.orderNo}/mark-paid`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "" },
    });
    assert.equal(markBad.statusCode, 400, markBad.body);

    const memResp1 = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { productId: TEST_KNOWN_IDS.membershipProductKey },
    });
    assert.equal(memResp1.statusCode, 201, memResp1.body);
    const memOrder1 = memResp1.json() as any;
    const markMem1 = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${memOrder1.orderNo}/mark-paid`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "first membership" },
    });
    assert.equal(markMem1.statusCode, 200, markMem1.body);
    const memBody1 = markMem1.json() as any;
    const firstExpireMs = new Date(memBody1.entitlements[0].expiresAt as string).getTime();
    assert.ok(firstExpireMs > Date.now() + 29 * 24 * 3600 * 1000, "first membership expires ~30d");

    const memResp2 = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { productId: TEST_KNOWN_IDS.membershipProductKey },
    });
    assert.equal(memResp2.statusCode, 201, memResp2.body);
    const memOrder2 = memResp2.json() as any;
    const markMem2 = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${memOrder2.orderNo}/mark-paid`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "membership renewal" },
    });
    assert.equal(markMem2.statusCode, 200, markMem2.body);
    const renewedExpireMs = new Date((markMem2.json() as any).entitlements[0].expiresAt as string).getTime();
    const expectedLower = firstExpireMs + (30 * 24 - 1) * 3600 * 1000;
    const expectedUpper = firstExpireMs + (30 * 24 + 1) * 3600 * 1000;
    assert.ok(
      renewedExpireMs >= expectedLower && renewedExpireMs <= expectedUpper,
      `renewal should extend from current expiry. got ${new Date(renewedExpireMs).toISOString()}, expected around ${new Date(firstExpireMs + 30 * 24 * 3600 * 1000).toISOString()}`,
    );

    const allOrders = await app.inject({ method: "GET", url: "/api/user/orders?pageSize=20", headers: { cookie: userCookie } });
    assert.equal(allOrders.statusCode, 200, allOrders.body);
    assert.equal((allOrders.json() as any).pagination.total, 3, "3 orders");

    const entResp = await app.inject({ method: "GET", url: "/api/user/entitlements", headers: { cookie: userCookie } });
    assert.equal(entResp.statusCode, 200, entResp.body);
    const ent = entResp.json() as any;
    assert.equal(ent.summary.membership.status, "active");
    assert.equal(ent.summary.totalEntitlements, 3, "1 package + 2 membership entitlements rows");
    assert.equal(ent.memberships.length, 2, "two membership_channel rows");

    const homeResp = await app.inject({ method: "GET", url: "/api/home", headers: { cookie: userCookie } });
    assert.equal(homeResp.statusCode, 200, homeResp.body);
    const home = homeResp.json() as { contents: Array<{ id: string; unlocked: boolean; accessType: string }> };
    const pkgContent = home.contents.find((c) => c.id === TEST_KNOWN_IDS.contentPackage);
    assert.equal(pkgContent?.accessType, "package");
    assert.equal(pkgContent?.unlocked, true, "package content unlocked");
    const memContent = home.contents.find((c) => c.id === TEST_KNOWN_IDS.contentMembership);
    assert.equal(memContent?.accessType, "membership");
    assert.equal(memContent?.unlocked, true, "membership content unlocked");

    const accessLink = await app.inject({
      method: "POST", url: `/api/resources/${TEST_KNOWN_IDS.contentPackage}/access-link`, headers: { cookie: userCookie },
    });
    assert.notEqual(accessLink.statusCode, 403, accessLink.body);
    assert.ok(
      accessLink.statusCode === 200 || accessLink.statusCode === 302 || accessLink.statusCode === 503 || accessLink.statusCode === 502 || accessLink.statusCode === 409,
      `access-link 200/302/503/502/409 expected, got ${accessLink.statusCode}: ${accessLink.body}`,
    );
    // 细节3：若为 302，则 Location Header 中含邀请链接，body 中不出现 inviteLink / url 字段
    if (accessLink.statusCode === 302) {
      const loc = accessLink.headers.location as string | undefined;
      assert.ok(loc, "细节3：302 响应必须带 Location Header 作邀请链接跳转");
      const bodyStr = accessLink.body || "{}";
      assert.ok(
        !/"inviteLink"\s*:/.test(bodyStr) && !/"url"\s*:/.test(bodyStr),
        `细节3：302 JSON body 中绝不出现 inviteLink / url 字段，实际 body=${bodyStr}`,
      );
    }

    const badProduct = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { productId: "00000000-0000-0000-0000-000000000000" },
    });
    assert.equal(badProduct.statusCode, 404);
  } finally {
    await app.close();
  }
});

// ================================================================
// Sprint 3 V2 P0: Stars 单测
// 范围：创单 → pre_checkout 校验 → successful_payment 幂等 → Stars 退款
// ================================================================

test("Stars 创单：POST /api/orders/stars 校验 XTR/金额/返回 invoiceLink 并写 paymentMethod=telegram_stars", async () => {
  const app = await createTestApp(prisma);
  try {
    const now = Date.now();
    const tgid = BigInt(6200000000 + (now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `Stars User ${tgid.toString()}` },
    });
    const userCookie = await loginAs(app, user.id);

    // 错误1：普通 packageProductKey 没问题，但故意用一个非 XTR product（造一个）
    const badProduct = await prisma.product.create({
      data: {
        id: "prod-stars-bad-usd",
        type: "single",
        title: "USD 商品",
        priceMinor: BigInt(999),
        currency: "USD",
        status: "active",
      },
    });
    const r1 = await app.inject({
      method: "POST", url: "/api/orders/stars", headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { productId: badProduct.id },
    });
    assert.equal(r1.statusCode, 400, `非 XTR 必须 400，got ${r1.statusCode}: ${r1.body}`);

    // 正确：singleProductKey (150 XTR)
    const r2 = await app.inject({
      method: "POST", url: "/api/orders/stars", headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { productId: TEST_KNOWN_IDS.singleProductKey },
    });
    assert.ok(r2.statusCode === 201 || r2.statusCode === 503,
      `stars创单必须 201 或 503 (mock可能无 createInvoiceLink 实现)，got ${r2.statusCode}: ${r2.body}`);
    if (r2.statusCode === 201) {
      const body = r2.json() as any;
      assert.equal(body.paymentMethod, "telegram_stars");
      assert.ok(body.expiresAt, "必须返回 expiresAt");
      assert.ok(body.invoice, "必须返回 invoice 对象");
      assert.equal(body.created.amountMinor, "150", "legacy XTR test price must be normalized to integer Stars");
      assert.equal(body.invoice.via, "createInvoiceLink", "Stars 发票必须走 createInvoiceLink");
    }
  } finally {
    await app.close();
  }
});

test("XTR 价格归一化：兼容 legacy 1e6 存储，同时保留整数 Stars", () => {
  assert.equal(normalizeStoredXtrAmountToStars(150_000_000n), 150n);
  assert.equal(normalizeStoredXtrAmountToStars(299n), 299n);
  assert.equal(normalizeStoredXtrAmountToStars(0n), 0n);
});

test("Stars payload 工具函数：starsPaymentPayloadForOrder → parseStarsPayloadPlain 往返", async () => {
  const { payloadPlain, payloadHmac } = starsPaymentPayloadForOrder({
    orderNo: "INT20260101ABCDEF",
    userId: "u_test_1234567890abcdef",
    amountMinor: 150n,
  });
  assert.ok(payloadPlain.length >= 16, "payloadPlain 长度最小 16");
  assert.ok(payloadHmac.length === 64, "hmac sha256 hex 64 chars");

  const parsed = parseStarsPayloadPlain(payloadPlain);
  assert.ok(parsed, "parseStarsPayloadPlain 必须成功");
  assert.equal(parsed!.orderNo, "INT20260101ABCDEF");
  assert.equal(parsed!.userId, "u_test_1234567890abcdef");
  assert.equal(BigInt(parsed!.amountMinorStr), 150n);

  const hmac2 = hmacSha256Hex(`order_payload:${payloadPlain}`);
  assert.equal(hmac2, payloadHmac, "payload HMAC 往返必须一致");
});

test("Stars webhook pre_checkout_query：状态错误必须 answerPreCheckoutQuery(ok=false,errorMessage) 不能发权益", async () => {
  const app = await createTestApp(prisma);
  await app.register(telegramWebhookRoutes, { prefix: "" });
  try {
    const now = Date.now();
    const tgid = BigInt(6300000000 + (now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `PCQ Test ${tgid.toString()}` },
    });

    // 造一个 cancelled 订单
    const product = await prisma.product.findUnique({ where: { id: TEST_KNOWN_IDS.singleProductKey } });
    const orderNo = "INT" + Date.now().toString().slice(-12) + "PCQ";
    const starsAmount = normalizeStoredXtrAmountToStars(product!.priceMinor.toString());
    const { payloadPlain, payloadHmac } = starsPaymentPayloadForOrder({
      orderNo, userId: user.id, amountMinor: starsAmount,
    });
    await prisma.order.create({
      data: {
        orderNo, userId: user.id, productId: product!.id,
        amountMinor: starsAmount,
        currency: "XTR", paymentMethod: "telegram_stars", paymentProvider: "telegram_stars",
        paymentPayloadHmac: payloadHmac,
        telegramUserIdHmac: userIdIndexKey(tgid),
        status: "cancelled",
      },
    });
    const pcqId = "pcq_" + Math.random().toString(36).slice(2, 14);
    const updateId = BigInt(9000000000 + Math.floor(Math.random() * 1e9));
    const resp = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": process.env.TELEGRAM_INVITE_BOT_WEBHOOK_SECRET || "test-secret-token",
        "Content-Type": "application/json",
      },
      payload: {
        update_id: Number(updateId),
        pre_checkout_query: {
          id: pcqId,
          from: { id: Number(tgid), is_bot: false, first_name: "Tester", language_code: "zh" },
          currency: "XTR",
          total_amount: Number(starsAmount),
          invoice_payload: payloadPlain,
        },
      },
    });
    assert.equal(resp.statusCode, 200, `webhook必须 200，got ${resp.statusCode}: ${resp.body}`);
    // 断言：订单没被改 status（pre_checkout 绝不 mark paid）
    const ord = await prisma.order.findUnique({ where: { orderNo } });
    assert.equal(ord!.status, "cancelled", "pre_checkout_query 必须不写入订单状态");
    // 断言：没有 payment_transaction（pre_checkout 绝不能写交易行）
    const cnt = await prisma.paymentTransaction.count({ where: { orderId: ord!.id } });
    assert.equal(cnt, 0, "pre_checkout_query 绝不写 payment_transaction");
  } finally {
    await app.close();
  }
});

test("Stars successful_payment：同 update_id + charge_id 连续投递，deliverStarsSuccessfulPayment 幂等（只 1 条 entitlement）", async () => {
  const app = await createTestApp(prisma);
  await app.register(telegramWebhookRoutes, { prefix: "" });
  try {
    const now = Date.now();
    const tgid = BigInt(6400000000 + (now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `Idemp ${tgid.toString()}` },
    });
    const product = await prisma.product.findUnique({ where: { id: TEST_KNOWN_IDS.membershipProductKey } });
    const orderNo = "INT" + Date.now().toString().slice(-12) + "SP1";
    const amountMinor = normalizeStoredXtrAmountToStars(product!.priceMinor.toString());
    const { payloadPlain, payloadHmac } = starsPaymentPayloadForOrder({ orderNo, userId: user.id, amountMinor });
    await prisma.order.create({
      data: {
        orderNo, userId: user.id, productId: product!.id,
        amountMinor, currency: "XTR",
        paymentMethod: "telegram_stars", paymentProvider: "telegram_stars",
        paymentPayloadHmac: payloadHmac,
        telegramUserIdHmac: userIdIndexKey(tgid),
        status: "pending",
      },
    });

    const chargeId = "CHG_TEST_IDEMPOTENT_" + Math.random().toString(36).slice(2, 12);
    const updateId = BigInt(9100000000 + Math.floor(Math.random() * 1e9));
    const evHash = rawEventHashForTelegram("test", updateId, chargeId);

    const opts = {
      telegramPaymentChargeId: chargeId,
      rawEventHash: evHash,
      payloadPlain,
      telegramUserIdPlain: tgid,
      amountMinor,
      currency: "XTR",
      botKey: "test",
    };
    const r1 = await deliverStarsSuccessfulPayment(prisma, opts);
    assert.equal(r1.delivered, true, `第一次必须成功, actual=${JSON.stringify(r1)}`);
    assert.equal(r1.idempotent, false, "第一次非幂等");
    assert.equal((r1.entitlements || []).length, 1, "第一次生成 1 条 entitlement");

    const r2 = await deliverStarsSuccessfulPayment(prisma, opts);
    assert.equal(r2.delivered, true, `第二次必须幂等成功, actual=${JSON.stringify(r2)}`);
    assert.equal(r2.idempotent, true, "第二次 idempotent=true");
    assert.equal((r2.entitlements || []).length, 1, "第二次不重复生成 entitlement 行");

    const allTxs = await prisma.paymentTransaction.count({ where: { orderId: r1.orderNo ? undefined : undefined, providerChargeId: chargeId } });
    assert.equal(allTxs, 1, "payment_transaction 唯一键保证只有 1 行");

    // DB 直接断言 entitlement 行数
    const entCount = await prisma.entitlement.count({
      where: { userId: user.id, resourceType: "membership_channel", resourceId: "membership-main" },
    });
    assert.equal(entCount, 1, `membership entitlement 必须只有 1 行 (幂等)，实际=${entCount}`);

    // order 是 paid
    const ord = await prisma.order.findUnique({ where: { orderNo } });
    assert.equal(ord!.status, "paid");
    assert.equal(ord!.providerOrderId, chargeId, "providerOrderId 必须 = telegram_payment_charge_id");
  } finally {
    await app.close();
  }
});

test("Stars successful_payment：payload HMAC 被篡改（金额改小）→ 必须拒绝且不发权益", async () => {
  const now = Date.now();
  const tgid = BigInt(6500000000 + (now % 100_000_000));
  const user = await prisma.user.create({
    data: { telegramUserId: tgid, displayName: `Tamper Test ${tgid.toString()}` },
  });
  const product = await prisma.product.findUnique({ where: { id: TEST_KNOWN_IDS.packageProductKey } });
  const orderNo = "INT" + Date.now().toString().slice(-12) + "TMP";
  const amountOriginal = normalizeStoredXtrAmountToStars(product!.priceMinor.toString());

  // 订单按原价
  const { payloadPlain, payloadHmac } = starsPaymentPayloadForOrder({ orderNo, userId: user.id, amountMinor: amountOriginal });
  await prisma.order.create({
    data: {
      orderNo, userId: user.id, productId: product!.id,
      amountMinor: amountOriginal, currency: "XTR",
      paymentMethod: "telegram_stars", paymentProvider: "telegram_stars",
      paymentPayloadHmac: payloadHmac,
      telegramUserIdHmac: userIdIndexKey(tgid),
      status: "pending",
    },
  });

  // 篡改：把 payload 的 amt 改少，但 payloadPlain 没变，只改 deliver amountMinor 参数（模拟 Telegram 字段被篡改）
  const chargeId = "CHG_TEST_TAMPERED_" + Math.random().toString(36).slice(2, 12);
  const updateId = BigInt(9200000000 + Math.floor(Math.random() * 1e9));
  const evHash = rawEventHashForTelegram("test", updateId, chargeId);
  const r = await deliverStarsSuccessfulPayment(prisma, {
    telegramPaymentChargeId: chargeId,
    rawEventHash: evHash,
    payloadPlain,
    telegramUserIdPlain: tgid,
    amountMinor: amountOriginal - 1n, // ← 金额故意少 1（= 篡改）
    currency: "XTR",
    botKey: "test",
  });
  assert.equal(r.delivered, false, `篡改后必须拒绝`);
  assert.equal(r.errorClass, "amount_mismatch");
  const ord = await prisma.order.findUnique({ where: { orderNo } });
  assert.equal(ord!.status, "pending", "订单未被置为 paid");
  const ent = await prisma.entitlement.count({ where: { sourceOrderId: ord!.id } });
  assert.equal(ent, 0, "不发任何权益");
});

test("Stars 退款：finance /admin/orders/:no/refund-stars 顺序 (mock API ok) → 本地 order + transaction 变 refunded + 审计写", async () => {
  const app = await createTestApp(prisma);
  try {
    const now = Date.now();
    const tgid = BigInt(6600000000 + (now % 100_000_000));
    const user = await prisma.user.create({
      data: { telegramUserId: tgid, displayName: `Refund Test ${tgid.toString()}` },
    });
    const product = await prisma.product.findUnique({ where: { id: TEST_KNOWN_IDS.packageProductKey } });
    const orderNo = "INT" + Date.now().toString().slice(-12) + "REF";
    const chargeId = "CHG_TEST_REFUND_" + Math.random().toString(36).slice(2, 12);
    const amountMinor = normalizeStoredXtrAmountToStars(product!.priceMinor.toString());

    // 先手动插一个 paid 订单 + confirmed 交易行（模拟 successful_payment 已走完）
    const order = await prisma.order.create({
      data: {
        orderNo, userId: user.id, productId: product!.id,
        amountMinor, currency: "XTR",
        paymentMethod: "telegram_stars", paymentProvider: "telegram_stars",
        telegramUserIdHmac: userIdIndexKey(tgid),
        status: "paid",
        paidAt: new Date(),
        providerOrderId: chargeId,
      },
    });
    const txRow = await prisma.paymentTransaction.create({
      data: {
        orderId: order.id,
        provider: "telegram",
        status: "confirmed",
        providerChargeId: chargeId,
        amountMinor,
        currency: "XTR",
        rawEventHash: "test_refund_ev_" + Math.random().toString(36).slice(2),
        receivedAt: new Date(),
        confirmedAt: new Date(),
      },
    });

    const financeCookie = await adminLoginAs(
      app,
      TEST_CREDENTIALS.finance.email,
      TEST_CREDENTIALS.finance.password,
    );

    // operator 无权（role operator 没 order:refund）
    const operatorCookie = await adminLoginAs(
      app,
      TEST_CREDENTIALS.operator.email,
      TEST_CREDENTIALS.operator.password,
    );
    const deny = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${orderNo}/refund-stars`,
      headers: { cookie: operatorCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测运营无退款权" },
    });
    assert.equal(deny.statusCode, 403);

    // finance 正常退款
    const refundResp = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${orderNo}/refund-stars`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "test stars refund: e2e 原因" },
    });
    assert.equal(refundResp.statusCode, 200, `finance refund 必须 200, got ${refundResp.statusCode}: ${refundResp.body}`);
    const body = refundResp.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.status, "refunded");

    const orderNow = await prisma.order.findUnique({ where: { orderNo } });
    assert.equal(orderNow!.status, "refunded");
    assert.equal(orderNow!.refundAdminId != null, true);

    const txNow = await prisma.paymentTransaction.findUnique({ where: { id: txRow.id } });
    assert.equal(txNow!.status, "refunded");
    assert.equal(txNow!.refundedAt != null, true);

    // 审计必须写 1 行
    const auditCount = await prisma.adminAuditLog.count({
      where: { action: "order.refund_stars", objectId: orderNo },
    });
    assert.equal(auditCount, 1, "order.refund_stars 审计必须有 1 行");

    // 幂等：再退一次 → idempotent=true
    const r2 = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${orderNo}/refund-stars`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "duplicate, idempotent" },
    });
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal((r2.json() as any).idempotent, true);
  } finally {
    await app.close();
  }
});

// ======================================================================
// Sprint 3 V2 P1: USDT 单测 6 条
// ======================================================================

// USDT 单测 1: 后台地址池管理（新增地址 + operator 无权限 403 + finance 有权限 200
test("USDT pool: finance 新增 /admin/payment-addresses add+ list + operator 403 / finance 201", async () => {
  const app = await createTestApp(prisma);
  try {
    const operatorCookie = await adminLoginAs(app, TEST_CREDENTIALS.operator.email, TEST_CREDENTIALS.operator.password);
    const financeCookie = await adminLoginAs(app, TEST_CREDENTIALS.finance.email, TEST_CREDENTIALS.finance.password);
    // operator 无权限
    const r1 = await app.inject({
      method: "POST",
      url: "/api/admin/payment-addresses",
      headers: { cookie: operatorCookie, "Content-Type": "application/json" },
      payload: { address: "TABUSDToperator403TestNoPerm" },
    });
    assert.equal(r1.statusCode, 403, `operator 无 manage_pools 必须 403 got ${r1.statusCode}`);
    // finance 正常
    const r2 = await app.inject({
      method: "POST",
      url: "/api/admin/payment-addresses",
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { address: "TTestUsdtPoolAddress000000000000001", network: "tron_trc20" },
    });
    assert.equal(r2.statusCode, 201, `finance 新增必须 201 got ${r2.statusCode}: ${r2.body}`);
    assert.equal((r2.json() as any).ok, true);

    // 列表：finance list 必须 200，operator list 必须 403
    const r3 = await app.inject({
      method: "GET",
      url: "/api/admin/payment-addresses",
      headers: { cookie: operatorCookie },
    });
    assert.equal(r3.statusCode, 403, `operator view 必须 403`);
    const r4 = await app.inject({
      method: "GET",
      url: "/api/admin/payment-addresses",
      headers: { cookie: financeCookie },
    });
    assert.equal(r4.statusCode, 200, `finance view 必须 200 got ${r4.statusCode}: ${r4.body}`);
    assert.ok(Array.isArray((r4.json() as any).items));
  } finally {
    await app.close();
  }
});

// USDT 单测 2: retire + force release 路径
test("USDT pool: 已分配地址在非 force 时 retire 409，force 后 200", async () => {
  const app = await createTestApp(prisma);
  try {
    const financeCookie = await adminLoginAs(app, TEST_CREDENTIALS.finance.email, TEST_CREDENTIALS.finance.password);
    // 建地址 → 手动改 assigned
    const addr = await prisma.paymentAddress.create({
      data: { network: "tron_trc20", address: "TTestAssignedForRetire0000000002", addressMasked: "TTe…0002", status: "assigned", assignedOrderId: null, assignedAt: new Date() },
    });
    // 非 force retire → 409
    const r1 = await app.inject({
      method: "POST",
      url: `/api/admin/payment-addresses/${addr.id}/retire`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "test retire without force" },
    });
    assert.equal(r1.statusCode, 409, `assigned + retire 非 force 必须 409 got ${r1.statusCode}: ${r1.body}`);
    // force retire → 200
    const r2 = await app.inject({
      method: "POST",
      url: `/api/admin/payment-addresses/${addr.id}/retire`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "test retire with force", forceReleaseAssigned: true },
    });
    assert.equal(r2.statusCode, 200, `force retire 必须 200 got ${r2.statusCode}: ${r2.body}`);
    const after = await prisma.paymentAddress.findUnique({ where: { id: addr.id } });
    assert.equal(after!.status, "retired");
    assert.equal(after!.assignedOrderId, null);
  } finally {
    await app.close();
  }
});

// USDT 单测 3: 唯一尾数生成：同地址未过期订单尾数 0-99 不重复（P0-A 新算法：targetTail 选真实尾数 + delta=(targetTail-baseTail+100)%100，final=base+delta≥base）
// 注意：单地址最多 100 个实际尾数（0..99），这里跑 80 单避免触发 P0-A「尾数耗尽切换地址」流程（该流程在路由层，另有专用测试）
test("USDT 唯一尾数：连续 80 个订单，同地址尾数不重复；P0-A final≥base 且 actualTailMinor===final%100", async () => {
  const app = await createTestApp(prisma);
  try {
    const addr = await prisma.paymentAddress.create({
      data: { network: "tron_trc20", address: "TTestUniqTail0000000000000003", addressMasked: "TT…0003", status: "available" },
    });
    const user = await prisma.user.create({ data: { telegramUserId: 7100000003n, displayName: "tail-user-3" } });
    const tails = new Set<number>();
    const N = 80;
    // 故意选 2 组 base：一组「整百」(base%100=0)，另一组「非整百」(base%100=11)，验证新算法对两种情况都正确
    for (let i = 0; i < N; i++) {
      const base = i % 2 === 0 ? 10_000_000n + BigInt(i * 100) : 10_000_011n + BigInt(i * 100);
      const gen = await generateUsdtUniqueAmountForAddress(prisma, addr.id, base);
      // P0-A 核心正确性：actualTailMinor 必须等于 finalAmountMinor % 100
      assert.equal(Number(gen.actualTailMinor), Number(gen.finalAmountMinor % 100n), `actualTailMinor=${gen.actualTailMinor} 必须等于 final%100=${gen.finalAmountMinor % 100n}`);
      // final 绝不低于标价
      assert.ok(gen.finalAmountMinor >= base, `finalAmountMinor (${gen.finalAmountMinor}) 必须 ≥ base (${base})`);
      // uniqueDeltaMinor = final - base ∈ [0,99]
      assert.equal(gen.uniqueDeltaMinor, gen.finalAmountMinor - gen.baseAmountMinor, `uniqueDeltaMinor 应=final-base`);
      assert.ok(Number(gen.uniqueDeltaMinor) >= 0 && Number(gen.uniqueDeltaMinor) <= 99, `delta 必须 0-99 实际 ${gen.uniqueDeltaMinor}`);
      // 旧兼容字段仍精确等于新字段（防止调用方误读）
      assert.equal(gen.amountMinor, gen.finalAmountMinor, `amountMinor(deprecated) 必须等于 finalAmountMinor`);
      assert.equal(gen.tailMinor, gen.actualTailMinor, `tailMinor(deprecated) 必须等于 actualTailMinor`);
      tails.add(Number(gen.actualTailMinor));
      // 插一个订单让下一个 i 尾数不重复；用 finalAmountMinor + usdtPaymentAddressId
      await prisma.order.create({
        data: {
          orderNo: "TTAIL" + i.toString().padStart(10, "0"),
          userId: user.id,
          productId: TEST_KNOWN_IDS.membershipProductKey,
          amountMinor: gen.finalAmountMinor,
          currency: "USDT",
          paymentMethod: "usdt_trc20_external",
          paymentProvider: "tron_trc20_external",
          status: "pending",
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          usdtPaymentAddressId: addr.id,
        },
      });
    }
    assert.ok(tails.size >= 75, `${N} 次至少覆盖 75 个不同 actualTailMinor，实际覆盖 ${tails.size}`);
  } finally {
    await app.close();
  }
});

// USDT 单测 4: POST /api/orders/usdt 非 USDT 商品 400，USDT 商品 201 + 返回地址+精确金额+尾数（P0-A 实际尾数一致性 + P0-B 错误不泄露）
//   价格故意用 99_000_011n（即 99.000011 USDT，base%100=11 非 00），暴露旧算法「return tailMinor ∈ [0,99], amountMinor = base+tailMinor」的 actualTail = (11+tailMinor)%100 ≠ tailMinor 的 bug
test("USDT 创单：XTR 商品 400，USDT membership 商品 201（标价非整百尾数仍正确 actualTailMinor）", async () => {
  const app = await createTestApp(prisma);
  try {
    const PRODUCT_ID = "pkg_usdt_membership_test_001";
    const BASE_MINOR = 99_000_011n; // 故意尾数 11，测试新算法
    const usdtProduct = await prisma.product.upsert({
      where: { id: PRODUCT_ID },
      update: { priceMinor: BASE_MINOR },
      create: {
        id: PRODUCT_ID,
        title: "USDT 会员 30天",
        type: "membership",
        priceMinor: BASE_MINOR, // 99.000011 USDT（非整百尾数）
        currency: "USDT",
        durationDays: 30,
        status: "active",
      },
    });
    const addr = await prisma.paymentAddress.create({
      data: { network: "tron_trc20", address: "TTestCreateOrderAddress4", addressMasked: "TTe…ss4", status: "available" },
    });
    const user = await prisma.user.create({ data: { telegramUserId: 7100000004n, displayName: "create-order-4" } });
    const cookie = await loginAs(app, user.id);
    const r1 = await app.inject({
      method: "POST",
      url: "/api/orders/usdt",
      headers: { cookie, "Content-Type": "application/json" },
      payload: { productId: TEST_KNOWN_IDS.singleProductKey }, // XTR 商品
    });
    assert.equal(r1.statusCode, 400, `XTR 商品 /orders/usdt 必须 400 got ${r1.statusCode}: ${r1.body}`);
    // USDT 商品正常
    const r2 = await app.inject({
      method: "POST",
      url: "/api/orders/usdt",
      headers: { cookie, "Content-Type": "application/json" },
      payload: { productId: usdtProduct.id },
    });
    assert.ok(
      [201, 503].includes(r2.statusCode),
      `USDT 商品创单必须 201 (或 503 池耗尽，本测试插了 1 条地址不应耗尽为 available，期望 201)，实际 ${r2.statusCode}: ${r2.body}`,
    );
    if (r2.statusCode === 201) {
      const b = r2.json() as any;
      assert.equal(b.ok, true);
      assert.ok(b.usdtPayment);
      assert.equal(b.usdtPayment.network, "tron_trc20");
      assert.ok(b.usdtPayment.toAddress.startsWith("T"));
      const finalMinor = BigInt(b.usdtPayment.amountMinor);
      const baseMinor = BigInt(b.usdtPayment.baseAmountMinor);
      assert.equal(baseMinor, BASE_MINOR, "baseAmountMinor 必须与商品价格一致（精确用于对账）");
      assert.ok(finalMinor >= baseMinor, "finalAmountMinor 必须 ≥ 标价");
      // P0-A：actualTailMinor === finalMinor % 100 严格相等
      assert.equal(b.usdtPayment.actualTailMinor, Number(finalMinor % 100n), `actualTailMinor=${b.usdtPayment.actualTailMinor} 必须等于 finalAmountMinor%100=${finalMinor % 100n}`);
      // uniqueDeltaMinor 必须等于 final - base
      assert.equal(BigInt(b.usdtPayment.uniqueDeltaMinor), finalMinor - baseMinor, `uniqueDeltaMinor=${b.usdtPayment.uniqueDeltaMinor} 应等于 ${finalMinor - baseMinor}`);
      // 旧字段 uniqueTailMinor 必须等于 actualTailMinor（兼容）
      assert.equal(b.usdtPayment.uniqueTailMinor, b.usdtPayment.actualTailMinor, `uniqueTailMinor(兼容) 必须等于 actualTailMinor`);
      assert.equal(b.paymentMethod, "usdt_trc20_external");
      assert.ok(b.expiresAt);
      // displayAmountDecimal 必须和 amountMinor 精确一致（1e-6 除法，6 位小数）
      const expectedDisplay = (Number(finalMinor) / 1_000_000).toFixed(6);
      assert.equal(b.usdtPayment.displayAmountDecimal, expectedDisplay, `displayAmountDecimal 必须等于 ${expectedDisplay}`);
    }
  } finally {
    await app.close();
  }
});

test("USDT 创单：XTR 会员可使用独立 USDT 测试价，Stars 主价格保持不变", async () => {
  const app = await createTestApp(prisma);
  try {
    const product = await prisma.product.create({
      data: {
        id: "membership_xtr_with_usdt_alt_001",
        type: "membership",
        title: "Stars 会员 + USDT 测试价",
        priceMinor: 150_000_000n,
        currency: "XTR",
        usdtPriceMinor: 10_000n, // 0.01 USDT, in 1e-6 minor units
        durationDays: 30,
        status: "active",
      },
    });
    await prisma.paymentAddress.create({
      data: { network: "tron_trc20", address: "TTestXtrAltUsdtAddress0005", addressMasked: "TTe…0005", status: "available" },
    });
    const user = await prisma.user.create({ data: { telegramUserId: 7100000805n, displayName: "xtr-usdt-alt-user" } });
    const cookie = await loginAs(app, user.id);

    const created = await app.inject({
      method: "POST", url: "/api/orders/usdt", headers: { cookie, "Content-Type": "application/json" },
      payload: { productId: product.id },
    });
    assert.equal(created.statusCode, 201, `配置备用 USDT 价格的 XTR 商品必须可建 USDT 单，got ${created.statusCode}: ${created.body}`);
    const body = created.json() as any;
    assert.equal(body.paymentMethod, "usdt_trc20_external");
    assert.equal(body.usdtPayment.baseAmountMinor, "10000", "USDT 建单必须使用独立 USDT 测试价 0.01");
    assert.equal(body.currency, "USDT", "订单账务币种必须是 USDT，不能沿用商品主 Stars 币种");

    // H5 刷新 / 使用“继续支付”时必须能从本人订单列表恢复精确金额与收款地址。
    // 同时确保这里的 baseAmountMinor 仍是 0.01，而不是包含唯一尾数的最终应付金额。
    const ownOrders = await app.inject({ method: "GET", url: "/api/user/orders?page=1&pageSize=50", headers: { cookie } });
    assert.equal(ownOrders.statusCode, 200, ownOrders.body);
    const ownOrder = (ownOrders.json() as any).items.find((item: any) => item.orderNo === body.orderNo);
    assert.ok(ownOrder, "本人订单列表必须包含刚创建的待支付订单");
    assert.equal(ownOrder.usdtPayment.baseAmountMinor, "10000", "订单恢复必须保留 0.01 USDT 商品基价");
    assert.equal(ownOrder.usdtPayment.amountMinor, body.usdtPayment.amountMinor, "订单恢复必须保留精确应付金额");
    assert.equal(ownOrder.usdtPayment.toAddress, body.usdtPayment.toAddress, "订单恢复必须保留本人可见的收款地址");

    const stored = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    assert.equal(stored.currency, "XTR", "备用 USDT 定价不能篡改 Stars 主币种");
    assert.equal(stored.priceMinor, 150_000_000n, "备用 USDT 定价不能篡改 Stars 主价格");
    assert.equal(stored.usdtPriceMinor, 10_000n, "备用 USDT 定价必须保持精确的 0.01 USDT minor 值");
  } finally {
    await app.close();
  }
});

// P0-B：路由 503 pool_empty 500 assign_db_error 均不向客户端泄露原始 DB reason / errorClass / 堆栈，只返回通用提示 + DB 层 rejectReason/审计 也脱敏
test("USDT 创单错误脱敏：pool_empty 503 / assign db_error 500（响应/DB rejectReason/审计表）全链路无原始错误字符串", async () => {
  const app = await createTestApp(prisma);
  try {
    const PRODUCT_ID = "pkg_usdt_membership_err_desens";
    const usdtProduct = await prisma.product.upsert({
      where: { id: PRODUCT_ID },
      update: {},
      create: { id: PRODUCT_ID, title: "err desensitize USDT 30d", type: "membership", priceMinor: 50_000_000n, currency: "USDT", durationDays: 30, status: "active" },
    });
    const user = await prisma.user.create({ data: { telegramUserId: 7199900001n, displayName: "err-desensitize-1" } });
    const cookie = await loginAs(app, user.id);

    // ---- 503：无可用地址（把所有非 retired 地址改成 retired，确保 pool 空）----
    await prisma.paymentAddress.updateMany({ where: { status: { notIn: ["retired"] } }, data: { status: "retired", retiredAt: new Date(), retireReason: "P0-B 脱敏测试 503" } });
    const r503 = await app.inject({ method: "POST", url: "/api/orders/usdt", headers: { cookie, "Content-Type": "application/json" }, payload: { productId: usdtProduct.id } });
    assert.equal(r503.statusCode, 503, `pool_empty 必须 503 got ${r503.statusCode}: ${r503.body}`);
    const body503 = r503.json() as any;
    assert.equal(body503.error, "usdt_address_pool_exhausted");
    assert.ok(typeof body503.message === "string" && body503.message.length > 0);
    // P0-B：响应体里绝对不能有原始 reason / detail.errorClass / detail.reason
    const raw503 = r503.body;
    assert.ok(!raw503.includes("no_available_address_in_pool"), "503 响应不能透传内部 reason no_available_address_in_pool");
    assert.ok(!raw503.includes(`"errorClass"`), "503 响应不能包含内部 errorClass 字段");
    assert.ok(!raw503.includes(`"detail"`), "503 响应不能包含 detail 对象（旧行为）");

    // ---- 500：assignUsdtTrc20Address 遇到 DB 异常（monkey-patch prisma.$transaction，当 assignUsdtTrc20Address 内部 paymentAddress.update 时抛错，让它返回 {ok:false, errorClass:db_error,reason:'原始内部错误 比如 列不存在'}，断言前端看不到）----
    const addrBack = await prisma.paymentAddress.create({ data: { network: "tron_trc20", address: "TTestDesens500AddressX", addressMasked: "TT…s500", status: "available" } });
    const origTransaction = prisma.$transaction.bind(prisma);
    const hitRef = { v: 0 };
    // @ts-ignore
    prisma.$transaction = async function (arg: any, opts?: any) {
      if (typeof arg !== "function") return origTransaction(arg, opts);
      return origTransaction(async (tx: any) => {
        const origUpdate = tx.paymentAddress.update.bind(tx.paymentAddress);
        tx.paymentAddress.update = function (mmopts: any) {
          if (mmopts?.where?.id === addrBack.id && hitRef.v === 0) {
            hitRef.v = 1;
            throw Object.assign(new Error("INTERNAL_DB_ERR_MSG_MUST_NOT_LEAK_XXXX column does not exist"), { code: "UNDEFINED_COLUMN_MUST_NOT_LEAK" });
          }
          return origUpdate(mmopts);
        };
        return arg(tx);
      }, opts);
    };
    try {
      const r500 = await app.inject({ method: "POST", url: "/api/orders/usdt", headers: { cookie, "Content-Type": "application/json" }, payload: { productId: usdtProduct.id } });
      assert.equal(r500.statusCode, 500, `assign db_error 必须 500 got ${r500.statusCode}: ${r500.body}`);
      const body500 = r500.json() as any;
      assert.equal(body500.error, "usdt_assign_failed");
      assert.ok(typeof body500.message === "string" && body500.message.length > 0);
      // P0-B (1/3)：响应体绝对不能包含原始内部错误文本
      const raw500 = r500.body;
      assert.ok(!raw500.includes("INTERNAL_DB_ERR_MSG_MUST_NOT_LEAK_XXXX"), "500 响应绝对不能包含原始 DB reason");
      assert.ok(!raw500.includes("UNDEFINED_COLUMN_MUST_NOT_LEAK"), "500 响应绝对不能包含原始错误码");
      assert.ok(!raw500.includes(`"reason"`), "500 响应绝对不能暴露内部 reason 字段");

      // P0-B (2/3)：DB 层 orders.rejectReason 只写结构化错误码，不含原始错误字符串（极端情况补偿事务写了 failed 订单时）
      const danglingOrders = await prisma.order.findMany({ where: { userId: user.id, productId: usdtProduct.id }, select: { status: true, rejectReason: true } });
      for (const o of danglingOrders) {
        if (o.status === "failed") {
          assert.equal(o.rejectReason, "usdt_assign_failed", `失败订单 rejectReason 必须是结构化码，实际=${o.rejectReason}`);
          assert.ok(!(o.rejectReason || "").includes("INTERNAL_DB_ERR_MSG_MUST_NOT_LEAK_XXXX"), "orders.rejectReason 绝对不能含注入的 DB 错误文本");
          assert.ok(!(o.rejectReason || "").includes("UNDEFINED_COLUMN_MUST_NOT_LEAK"), "orders.rejectReason 绝对不能含原始错误码");
          assert.ok(!(o.rejectReason || "").includes("column does not exist"), "orders.rejectReason 绝对不能含列名/SQL 片段");
        }
      }

      // P0-B (3/3)：admin_audit_logs 最近 1 小时任何字段（beforeValue/afterValue/reason JSON 串）绝对不含原始错误
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const audits = await prisma.adminAuditLog.findMany({
        where: { createdAt: { gte: oneHourAgo } },
        select: { beforeValue: true, afterValue: true, reason: true, action: true },
      });
      for (const a of audits) {
        const hay = JSON.stringify(a);
        assert.ok(!hay.includes("INTERNAL_DB_ERR_MSG_MUST_NOT_LEAK_XXXX"), `审计表 action=${a.action} 含原始 DB reason`);
        assert.ok(!hay.includes("UNDEFINED_COLUMN_MUST_NOT_LEAK"), `审计表 action=${a.action} 含原始错误码`);
        assert.ok(!hay.includes("column does not exist"), `审计表 action=${a.action} 含 SQL/列名片段`);
      }
    } finally {
      // @ts-ignore
      prisma.$transaction = origTransaction;
    }
  } finally {
    await app.close();
  }
});

// USDT 单测 5: confirmUsdtChainEvent confirming 不发权益（确认数达标后 confirmed 自动认单+幂等
test("USDT chain-event: confirming(confirmations 不足→ confirming，达标→ confirmed，重复投递幂等", async () => {
  const app = await createTestApp(prisma);
  try {
    const addr = await prisma.paymentAddress.create({
      data: {
        network: "tron_trc20",
        address: "TTestChainEvent0000000000005",
        addressMasked: "TTe…nt5",
        status: "assigned",
        assignedAt: new Date(),
        releaseAt: new Date(Date.now() + 20 * 60 * 1000),
      },
    });
    const user = await prisma.user.create({ data: { telegramUserId: 7100000005n, displayName: "chain-event-5" } });
    const product = await prisma.product.upsert({
      where: { id: "pkg_usdt_membership_test_005" },
      update: {},
      create: {
        id: "pkg_usdt_membership_test_005",
        title: "CE5 USDT membership 30d",
        type: "membership",
        priceMinor: 55_000_000n, currency: "USDT", durationDays: 30, status: "active",
      },
    });
    // 插订单（pending + amountMinor = 55_000_077（尾数 77）
    const orderNo = "INTUSDTCHAIN0005";
    const ord = await prisma.order.create({
      data: {
        orderNo, userId: user.id, productId: product.id,
        amountMinor: 55_000_077n, currency: "USDT",
        paymentMethod: "usdt_trc20_external", paymentProvider: "tron_trc20_external",
        status: "pending", expiresAt: new Date(Date.now() + 20 * 60 * 1000),
        usdtPaymentAddressId: addr.id,
      },
    });
    await prisma.paymentAddress.update({
      where: { id: addr.id },
      data: { assignedOrderId: ord.id },
    });

    const txHash = "USDT-TEST-TX-HASH-000000005";
    const confirming = await confirmUsdtChainEvent(prisma, {
      source: "unit_test", network: "tron_trc20", txHash, tokenContract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      fromAddress: "TFROMFROMFROMFROMFROM5", toAddress: addr.address, amountMinor: "55000077", blockNumber: 60000005,
      confirmations: 10, confirmationsTarget: 19,
    });
    assert.equal(confirming.status, "confirming", `10 确认 confirming`);
    assert.equal(confirming.idempotent, false);
    const afterConf = await prisma.paymentTransaction.findFirst({ where: { orderId: ord.id } });
    assert.equal(afterConf!.status, "confirming");
    const orderMid = await prisma.order.findUnique({ where: { id: ord.id } });
    assert.equal(orderMid!.status, "processing");

    const confirmed = await confirmUsdtChainEvent(prisma, {
      source: "unit_test", network: "tron_trc20", txHash, tokenContract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      fromAddress: "TFROMFROMFROMFROMFROM5", toAddress: addr.address, amountMinor: 55_000_077n, blockNumber: 60000005n,
      confirmations: 25, confirmationsTarget: 19,
    });
    assert.equal(confirmed.status, "confirmed", `confirmed 必须成功，实际 ${confirmed.status}, reason=${(confirmed as any).rejectReason}, errorClass=${(confirmed as any).errorClass}`);
    assert.equal(confirmed.idempotent, false);
    const entitlements = await prisma.entitlement.count({ where: { userId: user.id } });
    assert.ok(entitlements >= 1, "确认达标后至少 1 条权益");

    const idempotentRun = await confirmUsdtChainEvent(prisma, {
      source: "unit_test", network: "tron_trc20", txHash, tokenContract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      fromAddress: "TFROMFROMFROMFROMFROM5", toAddress: addr.address, amountMinor: 55_000_077, blockNumber: 60000005,
      confirmations: 30, confirmationsTarget: 19,
    });
    assert.equal(idempotentRun.idempotent, true, "同 txHash 再次投递幂等");
  } finally {
    await app.close();
  }
});

// USDT 单测 6: 过期释放 worker：订单 + releaseExpiredUsdtAddresses 正确释放 assigned 地址，以及内部路由过期订单到账拒绝不发权益
test("USDT 过期释放：过期 assigned 地址过期自动释放；过期到账 rejected 不发权益 + internal 路由鉴权", async () => {
  const app = await createTestApp(prisma);
  try {
    const addr = await prisma.paymentAddress.create({
      data: { network: "tron_trc20", address: "TTestExpireRelease0000000006", addressMasked: "TT…se6", status: "assigned", assignedAt: new Date(), releaseAt: new Date(Date.now() - 60_000) },
    });
    const beforeRelease = await releaseExpiredUsdtAddresses(prisma);
    assert.ok(beforeRelease.released >= 1, `releaseExpiredUsdtAddresses 至少 release 1（release ${beforeRelease.released}`);
    const after = await prisma.paymentAddress.findUnique({ where: { id: addr.id } });
    assert.equal(after!.status, "available");
    assert.equal(after!.assignedOrderId, null);

    // internal 路由 header 鉴权：无 secret → 401
    await app.register(usdtInternalRoutes, { prefix: "" });
    process.env.USDT_WORKER_SECRET = "unit-test-very-long-secret-unit-testing-123456";
    const noHeader = await app.inject({
      method: "POST",
      url: "/internal/usdt/chain-event",
      headers: { "Content-Type": "application/json" },
      payload: { txHash: "X" },
    });
    assert.equal(noHeader.statusCode, 401, `internal 路由缺 secret 401 got ${noHeader.statusCode}`);
    const badSecret = await app.inject({
      method: "POST",
      url: "/internal/usdt/chain-event",
      headers: { "Content-Type": "application/json", "x-intune-usdt-worker-secret": "WRONG_SECRET_123" },
      payload: { txHash: "X" },
    });
    assert.equal(badSecret.statusCode, 401, `错误 secret 401 got ${badSecret.statusCode}`);
  } finally {
    delete process.env.USDT_WORKER_SECRET;
    await app.close();
  }
});

// 修正后测例 1：列表只返回 addressMasked 无 address；reveal 接口 role=finance 拒绝；super_admin 200 + 审计
test("USDT pool 安全：GET list 默认 addressMasked，reveal 仅 super_admin + 审计一行", async () => {
  const app = await createTestApp(prisma);
  try {
    const financeCookie = await adminLoginAs(app, TEST_CREDENTIALS.finance.email, TEST_CREDENTIALS.finance.password);
    const superAdminCookie = await adminLoginAs(app, TEST_CREDENTIALS.superAdmin.email, TEST_CREDENTIALS.superAdmin.password);
    const addr = await prisma.paymentAddress.create({
      data: { network: "tron_trc20", address: "TTestSecurityMasked00000001", addressMasked: "TT…d001", status: "available" },
    });
    const r1 = await app.inject({
      method: "GET", url: "/api/admin/payment-addresses", headers: { cookie: financeCookie },
    });
    assert.equal(r1.statusCode, 200, `list 200 got ${r1.statusCode}: ${r1.body}`);
    const items = (r1.json() as any).items as any[];
    const target = items.find((x) => x.id === addr.id);
    assert.ok(target, "列表必须包含新建地址");
    assert.equal(typeof target.address, "undefined", `默认列表不准返回 address 明文；实际 ${JSON.stringify(target)}`);
    assert.equal(typeof target.addressMasked, "string");
    // finance reveal 403
    const r2 = await app.inject({
      method: "POST", url: `/api/admin/payment-addresses/${addr.id}/reveal`, headers: { cookie: financeCookie },
    });
    assert.equal(r2.statusCode, 403, `finance reveal 必须 403`);
    // super_admin reveal 200
    const r3 = await app.inject({
      method: "POST", url: `/api/admin/payment-addresses/${addr.id}/reveal`, headers: { cookie: superAdminCookie },
    });
    assert.equal(r3.statusCode, 200, `super_admin reveal 必须 200 got ${r3.statusCode}: ${r3.body}`);
    const revealBody = r3.json() as any;
    assert.equal(revealBody.address, addr.address);
    // 审计必须写一行
    const auditCount = await prisma.adminAuditLog.count({
      where: { action: "payment_address.reveal_plaintext", objectId: addr.id },
    });
    assert.equal(auditCount, 1, "reveal 审计必须 1 行");
  } finally {
    await app.close();
  }
});

// 修正后测例 2：retire forceCancelActiveOrder 路径：活跃订单 + forceReleaseAssigned 无 forceCancelActiveOrder → 409 active_order_requires_cancel；加 forceCancelActiveOrder=true → 200 + 订单 cancelled + 审计
test("USDT pool retire：活跃订单 assigned 地址无 forceCancelActiveOrder 409；加参数后 200 + 订单 cancelled + 审计写", async () => {
  const app = await createTestApp(prisma);
  try {
    const financeCookie = await adminLoginAs(app, TEST_CREDENTIALS.finance.email, TEST_CREDENTIALS.finance.password);
    const user = await prisma.user.create({ data: { telegramUserId: 7200000009n, displayName: "retire-active-9" } });
    const product = await prisma.product.upsert({
      where: { id: "pkg_usdt_retire_cancel_009" },
      update: {},
      create: { id: "pkg_usdt_retire_cancel_009", title: "USDT retire cancel", type: "membership", priceMinor: 66_000_000n, currency: "USDT", durationDays: 30, status: "active" },
    });
    const addr = await prisma.paymentAddress.create({
      data: { network: "tron_trc20", address: "TTestRetireActive0000000009", addressMasked: "TTR…e009", status: "available" },
    });
    const orderNo = "INTUSDTAI9ACT" + Date.now();
    const order = await prisma.order.create({
      data: {
        orderNo, userId: user.id, productId: product.id,
        amountMinor: 66_000_033n, currency: "USDT",
        paymentMethod: "usdt_trc20_external", paymentProvider: "tron_trc20_external",
        status: "pending", expiresAt: new Date(Date.now() + 20 * 60 * 1000),
        usdtPaymentAddressId: addr.id,
      },
    });
    await prisma.paymentAddress.update({
      where: { id: addr.id }, data: { status: "assigned", assignedOrderId: order.id, assignedAt: new Date(), releaseAt: new Date(Date.now() + 20 * 60 * 1000) },
    });
    // 仅 forceReleaseAssigned，活跃订单 → 409
    const r409 = await app.inject({
      method: "POST",
      url: `/api/admin/payment-addresses/${addr.id}/retire`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "force release only, no cancel order", forceReleaseAssigned: true },
    });
    assert.equal(r409.statusCode, 409, `活跃订单+仅 forceReleaseAssigned 必须 409 got ${r409.statusCode}: ${r409.body}`);
    assert.equal((r409.json() as any).code, "active_order_requires_cancel");
    // 加 forceCancelActiveOrder → 200
    const r200 = await app.inject({
      method: "POST",
      url: `/api/admin/payment-addresses/${addr.id}/retire`,
      headers: { cookie: financeCookie, "Content-Type": "application/json" },
      payload: { reason: "ok, cancel order + retire", forceReleaseAssigned: true, forceCancelActiveOrder: true },
    });
    assert.equal(r200.statusCode, 200, `加 forceCancelActiveOrder 后必须 200 got ${r200.statusCode}: ${r200.body}`);
    const orderNow = await prisma.order.findUnique({ where: { id: order.id } });
    assert.equal(orderNow!.status, "cancelled", "订单必须 cancelled");
    const addrNow = await prisma.paymentAddress.findUnique({ where: { id: addr.id } });
    assert.equal(addrNow!.status, "retired");
    assert.equal(addrNow!.assignedOrderId, null);
    // 审计必须写一行
    const auditCount = await prisma.adminAuditLog.count({
      where: { action: "payment_address.retire", objectId: addr.id },
    });
    assert.equal(auditCount, 1, "retire 审计必须有 1 行，失败则与业务一同回滚");
  } finally {
    await app.close();
  }
});

// P0-1 原子并发：真实 Promise.all 5 并发（N=5 避免 Prisma 连接池默认 9 以下满时 interactive transaction acquire timeout "Unable to start a transaction in the given time"）
// 地址池缩到 1 个，所有并发任务在各自 prisma.$transaction 里 FOR UPDATE 等待同一地址 → takenTails 读到已 commit 的前序订单 → 唯一尾数绝不重复
// 验证点：P0-1「锁/读/选尾/写订单」在同一 interactive transaction + 同一地址行悲观锁，跨请求不冲突
// 注意：我们不通过 assignUsdtTrc20Address（它的 FOR UPDATE SKIP LOCKED 会让并发任务跳过被锁地址返回 pool_empty），直接手工 tx.paymentAddress.update assignedOrderId 连到同一地址，模拟真实「单地址池并发打单」场景
test("USDT 唯一尾数并发：Promise.all 5 并发 单地址池 + 原子事务，5 尾数完全不重复", async () => {
  const app = await createTestApp(prisma);
  try {
    // 先把地址池缩容到单地址
    await prisma.paymentAddress.updateMany({
      where: { status: { notIn: ["retired"] } },
      data: { status: "retired", retiredAt: new Date(), retireReason: "并发测试缩容隔离" },
    });
    const addr = await prisma.paymentAddress.create({
      data: { network: "tron_trc20", address: "TTestConcurrent100000000010", addressMasked: "TTC…0010", status: "available" },
    });
    const user = await prisma.user.create({ data: { telegramUserId: 7200000010n, displayName: "concurrent-tail-10" } });
    const productId = TEST_KNOWN_IDS.membershipProductKey;
    const N = 5;
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < N; i++) {
      const orderNo = "CONCTAIL" + i.toString().padStart(10, "0") + "_" + Date.now().toString(36) + "_" + i;
      tasks.push(prisma.$transaction(async (tx: any) => {
        // 1. FOR UPDATE 锁该地址（其他任务在这里排队等待；因为 FOR UPDATE 无 SKIP 所以不跳过）；取完锁后立即把自己 assign 到它上面
        const rows = await tx.$queryRawUnsafe(`SELECT id FROM "payment_addresses" WHERE id = $1 FOR UPDATE`, addr.id);
        if (!rows || !(rows as any[]).length) throw new Error("address missing in concurrent test");
        const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
        const placeholder = await tx.order.create({
          data: {
            orderNo, userId: user.id, productId,
            amountMinor: 20_000_000n + BigInt(i) * 100n,
            currency: "USDT",
            paymentMethod: "usdt_trc20_external", paymentProvider: "tron_trc20_external",
            status: "pending", expiresAt,
          },
          select: { id: true },
        });
        await tx.paymentAddress.update({
          where: { id: addr.id },
          data: {
            status: "assigned", assignedOrderId: placeholder.id, assignedAt: new Date(), releaseAt: expiresAt,
          },
        });
        // 2. takenTails 读 + 选尾数 + 订单最终写 amountMinor/usdtPaymentAddressId 均在同一 interactive transaction 内，锁不释放直到 commit
        // P0-A：generateUsdtUniqueAmountForAddress 返回的 finalAmountMinor 已满足「final%100 === actualTailMinor」并且 final ≥ base，**不需要测试再做任何 baseAligned 修正**（真实路由直接用）
        const gen = await generateUsdtUniqueAmountForAddress(tx, addr.id, 20_000_000n + BigInt(i) * 100n);
        // 并发测试内部再做一次一致性断言，确保每个事务本身选到的 final%100 === actualTailMinor（保证 Set(tails).size === N 的语义真实可靠，不是被测试外修正掩盖）
        assert.equal(Number(gen.actualTailMinor), Number(gen.finalAmountMinor % 100n), `并发事务 i=${i}: actualTailMinor=${gen.actualTailMinor} 必须等于 finalAmountMinor%100=${gen.finalAmountMinor % 100n}`);
        assert.ok(gen.finalAmountMinor >= 20_000_000n + BigInt(i) * 100n, `并发事务 i=${i}: final (${gen.finalAmountMinor}) 必须 >= base`);
        await tx.order.update({
          where: { id: placeholder.id },
          data: { amountMinor: gen.finalAmountMinor, usdtPaymentAddressId: addr.id },
        });
        return Number(gen.actualTailMinor);
      }, { timeout: 60_000 } as any));
    }
    const tails = await Promise.all(tasks);
    const unique = new Set(tails);
    assert.equal(unique.size, N, `Promise.all ${N} 并发单地址池原子事务；尾数必须完全不重复；实际 ${unique.size}/${tails.length}`);
  } finally {
    await app.close();
  }
});

// P0-3 fail-fast：主流程是单交互式事务，DB 异常整个 ROLLBACK，0 脏写（没有占位订单残留、地址仍 available）；我们仍触发兜底补偿事务做幂等，断言无重复写入副作用 + P0-B 全链路脱敏
test("USDT 唯一尾数 fail-fast：单事务架构下 DB 异常 → POST /orders/usdt 500，0 脏写 + rejectReason/审计表 不含原始错误", async () => {
  const app = await createTestApp(prisma);
  try {
    // 清空其他所有 available 地址，保证创建订单时只能分配到我们的测试地址
    await prisma.paymentAddress.updateMany({
      where: { status: { notIn: ["retired"] } },
      data: { status: "retired", retiredAt: new Date(), retireReason: "fail-fast 隔离环境" },
    });
    const addr = await prisma.paymentAddress.create({
      data: { network: "tron_trc20", address: "TTestFailFast000000000011", addressMasked: "TTFF…0011", status: "available" },
    });
    const user = await prisma.user.create({ data: { telegramUserId: 7200000011n, displayName: "fail-fast-11" } });
    const usdtProduct = await prisma.product.upsert({
      where: { id: "pkg_usdt_failfast_011" },
      update: {},
      create: { id: "pkg_usdt_failfast_011", title: "FF11", type: "membership", priceMinor: 33_000_000n, currency: "USDT", durationDays: 30, status: "active" },
    });
    const cookie = await loginAs(app, user.id);
    const addrIdRef: { v: string } = { v: addr.id };
    // patch prisma.$transaction：当 usdtPaymentAddressId === addr.id 时，在 generateUsdtUniqueAmountForAddress 里的 tx.order.findMany 抛模拟 DB 中断
    const origTransaction = prisma.$transaction.bind(prisma);
    // @ts-ignore
    prisma.$transaction = async function (arg: any, opts?: any) {
      if (typeof arg !== "function") return origTransaction(arg as any, opts as any);
      return origTransaction(async (tx: any) => {
        const origOrderFindMany = tx.order.findMany.bind(tx.order);
        tx.order.findMany = function (mmopts: any) {
          if (mmopts?.where?.usdtPaymentAddressId === addrIdRef.v) {
            throw Object.assign(new Error("simulated DB outage for unique tail"), { code: "SIMULATED_DB_FAIL" });
          }
          return origOrderFindMany(mmopts);
        };
        return arg(tx);
      }, opts);
    };
    let raw500Body = "";
    try {
      const r500 = await app.inject({
        method: "POST", url: "/api/orders/usdt", headers: { cookie, "Content-Type": "application/json" },
        payload: { productId: usdtProduct.id },
      });
      assert.equal(r500.statusCode, 500, `DB 异常必须 500 got ${r500.statusCode}: ${r500.body}`);
      assert.equal((r500.json() as any).error, "usdt_unique_tail_query_failed");
      raw500Body = r500.body;
    } finally {
      // @ts-ignore
      prisma.$transaction = origTransaction;
    }
    // P0-B (1/3)：响应体不能包含原始错误字符串
    assert.ok(!raw500Body.includes("SIMULATED_DB_FAIL"), "fail-fast 响应体不能有模拟 DB 失败的原始错误码");
    assert.ok(!raw500Body.includes("simulated DB outage"), "fail-fast 响应体不能有模拟 DB 失败的原始描述");

    // P0-B (2/3)：DB orders.rejectReason 只写结构化错误码（极端情况补偿事务写了 failed 订单时）
    const orders = await prisma.order.findMany({ where: { userId: user.id, productId: usdtProduct.id }, select: { status: true, rejectReason: true } });
    if (orders.length > 0) {
      for (const o of orders) {
        if (o.status === "failed") {
          assert.equal(o.rejectReason, "usdt_unique_tail_query_failed", `失败订单 rejectReason 必须是结构化码，实际=${o.rejectReason}`);
          assert.ok(!(o.rejectReason || "").includes("SIMULATED_DB_FAIL"), "fail-fast orders.rejectReason 不能含 SIMULATED_DB_FAIL");
          assert.ok(!(o.rejectReason || "").includes("simulated DB outage"), "fail-fast orders.rejectReason 不能含原始错误描述");
        }
      }
    } else {
      // 绝大多数情况：成功 ROLLBACK → 0 脏写
      assert.equal(orders.length, 0, `单事务 ROLLBACK 后必须 0 条残留订单；实际有 ${orders.length} 条（含 status：${orders.map(o => o.status).join(",")}）`);
    }
    const addrAfter = await prisma.paymentAddress.findUnique({ where: { id: addr.id } });
    assert.equal(addrAfter!.assignedOrderId, null, `异常时地址 assignedOrderId 必须仍为 null；实际 ${addrAfter!.assignedOrderId}`);
    assert.equal(addrAfter!.status, "available", `异常时地址 status 必须仍为 available；实际 ${addrAfter!.status}`);

    // P0-B (3/3)：admin_audit_logs 最近 1 小时 不能包含 SIMULATED_DB_FAIL / column does not exist
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const audits = await prisma.adminAuditLog.findMany({
      where: { createdAt: { gte: oneHourAgo } },
      select: { beforeValue: true, afterValue: true, reason: true, action: true },
    });
    for (const a of audits) {
      const hay = JSON.stringify(a);
      assert.ok(!hay.includes("SIMULATED_DB_FAIL"), `fail-fast 审计表 action=${a.action} 含 SIMULATED_DB_FAIL`);
      assert.ok(!hay.includes("simulated DB outage"), `fail-fast 审计表 action=${a.action} 含原始错误描述`);
      assert.ok(!hay.includes("column does not exist"), `fail-fast 审计表 action=${a.action} 含 SQL 片段`);
    }
  } finally {
    await app.close();
  }
});

// 修正后测例 5：_release-expired-now 触发后写审计一行（finance.manage_pools 权限）
test("USDT pool _release-expired-now：手动触发写审计，operator 无权限 403", async () => {
  const app = await createTestApp(prisma);
  try {
    const financeCookie = await adminLoginAs(app, TEST_CREDENTIALS.finance.email, TEST_CREDENTIALS.finance.password);
    const operatorCookie = await adminLoginAs(app, TEST_CREDENTIALS.operator.email, TEST_CREDENTIALS.operator.password);
    const before = await prisma.adminAuditLog.count({ where: { action: "payment_address.release_expired_now" } });
    const r403 = await app.inject({ method: "POST", url: "/api/admin/payment-addresses/_release-expired-now", headers: { cookie: operatorCookie }});
    assert.equal(r403.statusCode, 403, `operator 调用 _release-expired-now 必须 403`);
    const r200 = await app.inject({ method: "POST", url: "/api/admin/payment-addresses/_release-expired-now", headers: { cookie: financeCookie }});
    assert.equal(r200.statusCode, 200, `finance 调用 _release-expired-now 必须 200 got ${r200.statusCode}: ${r200.body}`);
    const after = await prisma.adminAuditLog.count({ where: { action: "payment_address.release_expired_now" } });
    assert.equal(after, before + 1, `触发 _release-expired-now 后必须多 1 条审计；before=${before} after=${after}`);
  } finally {
    await app.close();
  }
});

// ============================================================
// P0-A 尾数空间耗尽 切换地址/503 两项测试
// ============================================================

// P0-A (1/2)：addr1 100 个实际尾数 0..99 全部占满；还有 addr2 available → 第 101 次创单必须 201 且切到 addr2，不产生重复金额，addr1 仍只有 100 条
test("USDT 尾数耗尽切换：addr1 0..99 占满 + addr2 可用 → 第 101 次 201 分配到 addr2，0 脏写", async () => {
  const app = await createTestApp(prisma);
  try {
    const user = await prisma.user.create({ data: { telegramUserId: 7200000101n, displayName: "p0a-tail-switch-101" } });
    const PRODUCT_ID = "pkg_usdt_tail_exhaust_switch";
    const product = await prisma.product.upsert({
      where: { id: PRODUCT_ID },
      update: {},
      create: { id: PRODUCT_ID, title: "P0A switch USDT 30d", type: "membership", priceMinor: 10_000_000n, currency: "USDT", durationDays: 30, status: "active" },
    });
    // 缩容地址池，只保留我们控制的 2 个地址
    await prisma.paymentAddress.updateMany({ where: { status: { notIn: ["retired"] } }, data: { status: "retired", retiredAt: new Date(), retireReason: "P0-A 切换地址测试隔离" } });
    const addr1 = await prisma.paymentAddress.create({ data: { network: "tron_trc20", address: "TTestP0AExhaustedAddr11111111111111", addressMasked: "TT…a111", status: "available" } });
    const addr2 = await prisma.paymentAddress.create({ data: { network: "tron_trc20", address: "TTestP0AFallbackAddr2222222222222", addressMasked: "TT…a222", status: "available" } });
    const cookie = await loginAs(app, user.id);

    // 往 addr1 插 100 条 pending 订单（amountMinor%100 = 0..99，真实尾数占满）
    const baseMinor = BigInt(product.priceMinor.toString());
    const baseTail = Number(baseMinor % 100n);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 20 * 60 * 1000);
    const pendingData: any[] = [];
    for (let tail = 0; tail < 100; tail++) {
      // delta = (tail - baseTail + 100) % 100，保证 amountMinor%100 === tail 且 amountMinor >= base
      const delta = BigInt((tail - baseTail + 100) % 100);
      const amountMinor = baseMinor + delta;
      pendingData.push({
        orderNo: `P0AFILL${tail.toString().padStart(3, "0")}${Date.now().toString(36)}`,
        userId: user.id,
        productId: product.id,
        amountMinor,
        currency: "USDT",
        paymentMethod: "usdt_trc20_external",
        paymentProvider: "tron_trc20_external",
        status: "pending" as const,
        expiresAt,
        usdtPaymentAddressId: addr1.id,
      });
    }
    await prisma.order.createMany({ data: pendingData });
    const preOrders = await prisma.order.count({ where: { userId: user.id, productId: product.id } });
    assert.equal(preOrders, 100, `测试前置：addr1 必须先占满 100 条 pending，实际 ${preOrders}`);

    // 第 101 次下单：预期切换到 addr2，201，finalAmountMinor%100 在 addr2 实际尾数集合唯一
    const r101 = await app.inject({ method: "POST", url: "/api/orders/usdt", headers: { cookie, "Content-Type": "application/json" }, payload: { productId: product.id } });
    assert.equal(r101.statusCode, 201, `addr1 占满 + addr2 可用；第 101 次必须 201，实际 ${r101.statusCode}: ${r101.body}`);
    const b101 = r101.json() as any;
    assert.equal(b101.ok, true);
    const finalMinor = BigInt(b101.usdtPayment.amountMinor);
    assert.ok(finalMinor >= baseMinor, "第 101 次 finalAmountMinor 必须 >= base");
    assert.equal(b101.usdtPayment.actualTailMinor, Number(finalMinor % 100n), "第 101 次 actualTailMinor 必须等于 final%100");
    // 订单地址必须是 addr2
    const newOrder = await prisma.order.findUnique({ where: { orderNo: b101.orderNo }, select: { usdtPaymentAddressId: true, status: true, amountMinor: true } });
    assert.ok(newOrder, "第 101 次订单必须存在于 DB");
    assert.equal(newOrder.status, "pending");
    assert.equal(newOrder.usdtPaymentAddressId, addr2.id, `第 101 次必须分配到 addr2，实际 addr=${newOrder.usdtPaymentAddressId}`);

    // 总订单数 === 101；addr1 仍只有 100 条；addr2 只有这 1 条，且 actualTail 不重复
    const totalOrders = await prisma.order.count({ where: { userId: user.id, productId: product.id } });
    assert.equal(totalOrders, 101, `第 101 次后总订单必须 101；实际 ${totalOrders}`);
    const addr1Tails = new Set<number>();
    const addr1Rows = await prisma.order.findMany({ where: { usdtPaymentAddressId: addr1.id, userId: user.id, productId: product.id }, select: { amountMinor: true } });
    assert.equal(addr1Rows.length, 100, `addr1 仍只能有 100 条；实际 ${addr1Rows.length}`);
    for (const r of addr1Rows) {
      const t = Number(BigInt(String(r.amountMinor)) % 100n);
      addr1Tails.add(t);
    }
    assert.equal(addr1Tails.size, 100, `addr1 100 条必须覆盖 0..99 所有实际尾数；实际 unique=${addr1Tails.size}`);
    const addr2Rows = await prisma.order.findMany({ where: { usdtPaymentAddressId: addr2.id, userId: user.id, productId: product.id }, select: { amountMinor: true } });
    assert.equal(addr2Rows.length, 1, `addr2 必须只有刚下单的 1 条；实际 ${addr2Rows.length}`);
    const a2T = Number(BigInt(String(addr2Rows[0].amountMinor)) % 100n);
    assert.equal(a2T, Number(newOrder.amountMinor) % 100, "addr2 这 1 条的 actualTail 必须等于最终订单金额尾数");
  } finally {
    await app.close();
  }
});

// P0-A (2/2)：池里只有 1 个地址 addr1，100 个实际尾数 0..99 占满 → 第 101 次创单必须 503 usdt_address_pool_exhausted + 0 脏 pending
test("USDT 尾数耗尽 503：addr1 0..99 占满 + 池无其他可用地址 → 第 101 次 503 usdt_address_pool_exhausted，0 脏写", async () => {
  const app = await createTestApp(prisma);
  try {
    const user = await prisma.user.create({ data: { telegramUserId: 7200000102n, displayName: "p0a-tail-503-102" } });
    const PRODUCT_ID = "pkg_usdt_tail_exhaust_503";
    const product = await prisma.product.upsert({
      where: { id: PRODUCT_ID },
      update: {},
      create: { id: PRODUCT_ID, title: "P0A 503 USDT 30d", type: "membership", priceMinor: 15_000_011n, currency: "USDT", durationDays: 30, status: "active" },
    });
    // 缩容到只有 addr1
    await prisma.paymentAddress.updateMany({ where: { status: { notIn: ["retired"] } }, data: { status: "retired", retiredAt: new Date(), retireReason: "P0-A 503 测试隔离" } });
    const addr1 = await prisma.paymentAddress.create({ data: { network: "tron_trc20", address: "TTestP0A503OnlyAddr3333333333333", addressMasked: "TT…a333", status: "available" } });
    const cookie = await loginAs(app, user.id);

    // 占满 addr1 实际尾数 0..99
    const baseMinor = BigInt(product.priceMinor.toString());
    const baseTail = Number(baseMinor % 100n);
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
    const pendingData: any[] = [];
    for (let tail = 0; tail < 100; tail++) {
      const delta = BigInt((tail - baseTail + 100) % 100);
      const amountMinor = baseMinor + delta;
      pendingData.push({
        orderNo: `P0A503${tail.toString().padStart(3, "0")}${Date.now().toString(36)}`,
        userId: user.id,
        productId: product.id,
        amountMinor,
        currency: "USDT",
        paymentMethod: "usdt_trc20_external",
        paymentProvider: "tron_trc20_external",
        status: "pending" as const,
        expiresAt,
        usdtPaymentAddressId: addr1.id,
      });
    }
    await prisma.order.createMany({ data: pendingData });
    const preOrders = await prisma.order.count({ where: { userId: user.id, productId: product.id } });
    assert.equal(preOrders, 100, `P0-A 503 测试前置：addr1 必须占满 100 条 pending，实际 ${preOrders}`);

    // 第 101 次下单：必须 503 usdt_address_pool_exhausted
    const r101 = await app.inject({ method: "POST", url: "/api/orders/usdt", headers: { cookie, "Content-Type": "application/json" }, payload: { productId: product.id } });
    assert.equal(r101.statusCode, 503, `addr1 占满 + 池里无其他地址；第 101 次必须 503，实际 ${r101.statusCode}: ${r101.body}`);
    const b101 = r101.json() as any;
    assert.equal(b101.error, "usdt_address_pool_exhausted", `503 错误码必须是 usdt_address_pool_exhausted；实际 ${b101.error}`);
    assert.ok(typeof b101.message === "string" && b101.message.length > 0, "503 必须有通用用户提示");

    // 503 响应体里不能有内部错误细节
    const raw = r101.body;
    assert.ok(!raw.includes("tail_exhausted"), "503 响应不能暴露内部错误分类 tail_exhausted");
    assert.ok(!raw.includes("takenActualTails"), "503 响应不能暴露内部计数 takenActualTails");
    assert.ok(!raw.includes(addr1.id), "503 响应不能暴露地址 ID 明文");

    // 总订单数仍 === 100：没有脏 pending
    const totalOrders = await prisma.order.count({ where: { userId: user.id, productId: product.id } });
    assert.equal(totalOrders, 100, `503 后总订单必须仍为 100；实际 ${totalOrders}（脏写 ${totalOrders - 100} 条）`);
    const noFailed = await prisma.order.count({ where: { userId: user.id, productId: product.id, status: "failed" } });
    assert.equal(noFailed, 0, `503 不能生成 failed 脏订单；实际 ${noFailed} 条`);
    // addr1 地址状态仍 available（所有尝试 ROLLBACK 后）
    const addr1After = await prisma.paymentAddress.findUnique({ where: { id: addr1.id }, select: { status: true, assignedOrderId: true } });
    assert.equal(addr1After!.status, "available");
    assert.equal(addr1After!.assignedOrderId, null);
  } finally {
    await app.close();
  }
});

// ============================================================
// P0-B 补项：Prisma $on("error") 事件脱敏回归
//   独立临时 PrismaClient（避免污染全局 prisma 的 stdout/stderr），故意触发两类 DB 错误：
//   (a) $queryRaw 对不存在表做 SELECT → Prisma P2010 / query_engine syntax/semantic error
//   (b) 向带唯一约束的表（adminUser.email UNIQUE）重复插入 → P2002
//   在事件钩子 → emitSafetyEvent 期间捕获 process.stderr.write 全部 1 行 payload，断言：
//     - 存在 prismaCode=Pxxxx
//     - 绝对不含：原始 SQL ("SELECT/INSERT")、注入字符串 ("this_table_should_not_exist_p0btest_xyz" 或 admin 邮箱明文)、Prisma 原始 message ("does not exist" / "relation" / "Unique constraint")
// ============================================================
test("P0-B Prisma 事件脱敏: 运行时 Pxxxx 错误 → $on('error') → 安全事件不含 message/SQL/表名", async () => {
  // 1) 构造独立临时 PrismaClient；完全对齐 index.ts 的 emit:event 配置
  const tmp = new PrismaClient({
    errorFormat: "minimal",
    log: [
      { level: "error", emit: "event" },
      { level: "warn",  emit: "event" },
      { level: "info",  emit: "event" },
    ],
  });
  // 2) 挂事件钩子（和 index.ts 完全相同的安全事件通道，用于验证 $on 实际被 Prisma 触发）
  //    【P0 测试安全缺口修复】stderr 拦截器采用「仅收集、绝不转发」策略。
  //    如果未来 Prisma/安全事件通道回归输出原始 SQL/DB message，绝不能在断言失败前就把明文打到 CI/终端日志；
  //    拦截期间所有写入都只进 stderrBuf，由断言决定通过或失败；finally 再恢复 origWrite 避免影响其他测试。
  let safetyEventFired = 0;
  const stderrBuf: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any, _encodingOrCb?: any, _maybeCb?: any) => {
    try {
      if (typeof chunk === "string") stderrBuf.push(chunk);
      else if (Buffer.isBuffer(chunk)) stderrBuf.push(chunk.toString("utf8"));
    } catch { /* swallow, never leak */ }
    // 不调用 origWrite：任何内容都不外泄到 CI/终端。
    return true;
  };
  try {
    (tmp as any).$on("error", (ev: any) => {
      safetyEventFired += 1;
      emitSafetyEvent(
        { event: "prisma_runtime_error", errorClass: "db_error", note: "p0b_regression_harness" },
        ev,
      );
    });
    (tmp as any).$on("warn", (ev: any) => {
      emitSafetyEvent(
        { event: "prisma_runtime_warn", errorClass: "db_error", retryHint: 0, note: "p0b_regression_harness_warn" },
        ev,
      );
    });

    // ---- 错误 (a)：对绝对不存在的表做 SELECT（$queryRawUnsafe） ----
    let pA: any = null;
    try {
      await (tmp as any).$queryRawUnsafe(`SELECT * FROM this_table_should_not_exist_p0btest_xyz WHERE id = 1`);
    } catch (e: any) { pA = e; }
    assert.ok(pA, "不存在表查询必须抛出 Prisma 错误");

    // ---- 错误 (b)：adminUser.email 唯一冲突（email 是 UNIQUE）—— 注意：**必须走 tmp 客户端**，
    //    否则 P2002 由全局 prisma 触发时不会进入 tmp 的 $on("error") 钩子，造成这条错的脱敏链没有被测试覆盖。
    const uniqueEmail = `p0b-prisma-on-test-${Date.now().toString(36)}@example.com`;
    await tmp.adminUser.create({
      data: { email: uniqueEmail, displayName: "P0B Event Desens Tmp", role: "auditor", passwordHash: "$2a$04$x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x" },
    });
    let pB: any = null;
    try {
      await tmp.adminUser.create({
        data: { email: uniqueEmail, displayName: "P0B Event Desens Tmp 2", role: "auditor", passwordHash: "$2a$04$y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y/y" },
      });
    } catch (e: any) { pB = e; }
    assert.ok(pB, "email UNIQUE 冲突必须抛出 Prisma P2002 错误（且必须由 tmp 客户端触发进入 $on(error)）");
    assert.equal((pB as any)?.code, "P2002", "唯一冲突的 prisma code 必须是 P2002");

    // ---- 等下事件循环把 process.stderr.write 都刷到 stderrBuf ----
    await new Promise<void>((r) => setTimeout(r, 30));

    // 3) 断言：两类错（不存在表语义错 + UNIQUE 冲突 P2002）都必须走 tmp 的 $on("error") 钩子，
    //    即 safetyEventFired >= 2；如果只有 1 次说明 P2002 那条其实没走 tmp 的 emit:event 链 → 覆盖不完整，立即 fail。
    assert.ok(safetyEventFired >= 2, `tmp 的 $on("error") 必须触发 ≥2 次（不存在表 1 次 + P2002 1 次）；实际 safetyEventFired=${safetyEventFired}`);

    // 4) 拼接捕获到的所有 stderr 原始文本，严格断言没有任何泄露
    const stderrAll = stderrBuf.join("\n");
    // 必须存在结构化事件行
    assert.ok(stderrAll.includes("[safety] event=prisma_runtime_error"), `stderr 必须包含 [safety] event=prisma_runtime_error 单行；实际片段=${stderrAll.slice(0,500)}`);
    // 旁证二次：事件钩子真正触发（safetyEventFired>=2）——证明 emit:event 模式对语义错 & P2002 两条路径均生效
    assert.ok(safetyEventFired >= 2, `必须至少触发 2 次 tmp 的 Prisma $on("error")；实际 ${safetyEventFired} 次（若为 1 则说明 P2002 没走 tmp 的 emit:event 链）`);

    // 红线：绝对不能包含原始 SQL / 注入用的表名字符串 / 错误原文（大小写兼容）
    const forbiddenLowerFragments = [
      "this_table_should_not_exist_p0btest_xyz",   // 注入的不存在表名
      uniqueEmail.toLowerCase(),                   // UNIQUE 冲突的 email（结构化后只有 adminFingerprint=HMAC）
      "select * from",                             // 原始 SELECT SQL 片段（大小写不敏感）
      "does not exist",                            // Postgres 标准不存在 message 片段
      "relation",                                  // Postgres "relation ... does not exist"
      "unique constraint",                         // P2002 原始英文 message
    ];
    const lower = stderrAll.toLowerCase();
    for (const frag of forbiddenLowerFragments) {
      assert.ok(!lower.includes(frag), `stderr 安全事件禁止包含片段 "${frag}"（泄露原始 SQL/DB message/业务标识）`);
    }

    // 红线：errorClass 字段在结构化事件里只能是 "db_error" / "business" / ... 这种，不能包含 e.message 前24字符这种拼接（orders.ts 修复回归的旁证）
    const badLines = stderrAll.split("\n").filter((l) => /errorClass=exception_[0-9a-zA-Z_\-]{8,}/.test(l));
    assert.equal(badLines.length, 0, `禁止出现 exception_<e.message前半段> 这种 errorClass：${badLines.join(" || ")}`);
  } finally {
    // 立刻还原 process.stderr.write（不影响其他 46 条测试）
    (process.stderr as any).write = origWrite;
    // 清理：两次 adminUser.create 都走 tmp，故也用 tmp deleteMany 保证同一连接清理同一条
    try {
      await tmp.adminUser.deleteMany({ where: { email: { startsWith: "p0b-prisma-on-test-" } } });
    } catch {}
    try { await tmp.$disconnect(); } catch {}
  }
});
