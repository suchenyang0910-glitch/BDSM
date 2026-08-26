import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import adminRoutes from "../src/routes/admin.js";
import analyticsAndPreferenceRoutes from "../src/routes/analyticsPreferences.js";
import adminFinanceRoutes from "../src/routes/adminFinance.js";
import {
  computePaymentAddressIntegrityMac,
  verifyAndFreezePaymentAddressIntegrity,
} from "../src/services/paymentAddressIntegrity.js";
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
  await app.register(session, {
    secret: "test-session-secret-is-at-least-thirty-two-characters",
    cookie: { secure: false },
  });
  app.decorate("prisma", prisma);
  app.decorateRequest("userId", null);
  app.decorateRequest("telegramUserId", null);
  app.addHook("preHandler", async (req) => {
    const sess = req.session as any;
    if (sess?.userId) (req as any).userId = sess.userId;
    if (sess?.telegramUserId) (req as any).telegramUserId = sess.telegramUserId;
  });
  app.post("/__test/login-user", async (req: any, reply: any) => {
    const sess = req.session as any;
    sess.userId = req.body.userId;
    sess.telegramUserId = req.body.telegramUserId ?? null;
    return reply.send({ ok: true });
  });
  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(analyticsAndPreferenceRoutes, { prefix: "/api" });
  await app.register(adminFinanceRoutes, { prefix: "/api" });
  return app;
}

async function loginUser(app: any, userId: string, telegramUserId?: string | null) {
  const res = await app.inject({
    method: "POST",
    url: "/__test/login-user",
    headers: { "Content-Type": "application/json" },
    payload: { userId, telegramUserId: telegramUserId ?? null },
  });
  assert.equal(res.statusCode, 200, res.body);
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
  assert.equal(r.statusCode, 200, `${role} login failed ${r.body}`);
  return cookieFromResponse(r);
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("payment address integrity freezes a tampered address when dedicated key is configured", async () => {
  const previousKey = process.env.PAYMENT_ADDRESS_INTEGRITY_KEY;
  const row: any = {
    id: "addr-integrity-test",
    network: "tron_trc20",
    address: "TIntegrityOriginalAddress00000001",
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    createdBy: "finance-test",
    lifecycleVersion: 1,
    status: "available",
  };
  process.env.PAYMENT_ADDRESS_INTEGRITY_KEY = "payment-address-integrity-test-key-32bytes";
  try {
    row.integrityMac = computePaymentAddressIntegrityMac(row);
    const updates: any[] = [];
    const fakePrisma = { paymentAddress: { update: async (args: any) => { updates.push(args); return args; } } };
    const good = await verifyAndFreezePaymentAddressIntegrity(fakePrisma, row, "assign");
    assert.equal(good.ok, true);

    const tampered = { ...row, address: "TTamperedAddress0000000000000001" };
    const bad = await verifyAndFreezePaymentAddressIntegrity(fakePrisma, tampered, "monitor");
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "payment_address_integrity_failed");
    assert.equal(updates.some((item) => item.data?.autoCreditFreezeReason === "payment_address_integrity_failed"), true);
  } finally {
    if (previousKey === undefined) delete process.env.PAYMENT_ADDRESS_INTEGRITY_KEY;
    else process.env.PAYMENT_ADDRESS_INTEGRITY_KEY = previousKey;
  }
});

test("analytics events enforce whitelist and store only HMAC-safe identifiers", async () => {
  const app = await createApp(prisma);
  try {
    const user = await prisma.user.create({
      data: {
        telegramUserId: BigInt(`9${Date.now().toString().slice(-9)}`),
        displayName: "analytics user",
      },
    });
    const userCookie = await loginUser(app, user.id, user.telegramUserId?.toString());
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/events",
      headers: {
        cookie: userCookie,
        "Content-Type": "application/json",
      },
      payload: {
        events: [
          {
            eventName: "payment_confirmed",
            payload: {
              platform: "h5",
              orderNo: "INT20260823000001",
              productId: TEST_KNOWN_IDS.singleProductKey,
              paymentMethod: "usdt_trc20",
              txHash: "should_not_be_kept",
              inviteLink: "https://t.me/+secret",
            },
          },
        ],
      },
    });
    assert.equal(res.statusCode, 202, res.body);

    const row = await prisma.analyticsEvent.findFirst({
      where: { eventName: "payment_confirmed", userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(row);
    const properties = (row as any).propertiesJson as Record<string, unknown>;
    assert.equal(typeof properties.orderNoHmac, "string");
    assert.equal(typeof properties.productIdHmac, "string");
    assert.equal(properties.paymentMethod, "usdt_trc20");
    assert.equal("orderNo" in properties, false);
    assert.equal("txHash" in properties, false);
    assert.equal("inviteLink" in properties, false);
    assert.notEqual(properties.orderNoHmac, "INT20260823000001");
  } finally {
    await app.close();
  }
});

test("analytics events reject requests without an established account session", async () => {
  const app = await createApp(prisma);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/events",
      headers: { "Content-Type": "application/json" },
      payload: { events: [{ eventName: "page_viewed", payload: { platform: "h5", pageName: "home" } }] },
    });
    assert.equal(res.statusCode, 401, res.body);
  } finally {
    await app.close();
  }
});

test("admin analytics overview exposes aggregate funnel only and enforces analytics:view", async () => {
  const app = await createApp(prisma);
  try {
    const operatorCookie = await loginAdmin(app, "operator");
    const supportCookie = await loginAdmin(app, "customerService");
    const forbidden = await app.inject({ method: "GET", url: "/api/admin/analytics/overview?preset=7d", headers: { cookie: supportCookie } });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    const ok = await app.inject({ method: "GET", url: "/api/admin/analytics/overview?preset=7d", headers: { cookie: operatorCookie } });
    assert.equal(ok.statusCode, 200, ok.body);
    const body = ok.json() as any;
    assert.equal(body.period.preset, "7d");
    assert.equal(Array.isArray(body.funnel), true);
    assert.equal(body.funnel.length, 6);
    assert.equal(Array.isArray(body.preferences), true);
    assert.equal(JSON.stringify(body).includes("analytics user"), false, "overview must not expose user identity");
    assert.equal(JSON.stringify(body).includes("INT20260823000001"), false, "overview must not expose order identifiers");
  } finally {
    await app.close();
  }
});

test("me preferences support save and clear without exposing raw sensitive fields", async () => {
  const app = await createApp(prisma);
  try {
    const guest = await prisma.user.create({
      data: {
        displayName: "guest pref user",
      },
    });
    const userCookie = await loginUser(app, guest.id, null);

    const save = await app.inject({
      method: "POST",
      url: "/api/me/preferences",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: {
        topicCategoryIds: [TEST_KNOWN_IDS.categoryFeatured],
        contentFormats: ["curated_on_demand", "creator_interview"],
        discoveryModes: ["latest_first"],
        notifications: { order_status: true, campaign_notice: true },
        personalizationEnabled: false,
        source: "my_preferences",
      },
    });
    assert.equal(save.statusCode, 200, save.body);

    const get = await app.inject({
      method: "GET",
      url: "/api/me/preferences",
      headers: { cookie: userCookie },
    });
    assert.equal(get.statusCode, 200, get.body);
    const body = get.json() as any;
    assert.equal(body.personalizationEnabled, false);
    assert.deepEqual(body.topicCategoryIds, [TEST_KNOWN_IDS.categoryFeatured]);
    assert.deepEqual(body.contentFormats.sort(), ["creator_interview", "curated_on_demand"]);
    assert.equal(body.notifications.order_status, true);
    assert.equal(body.notifications.campaign_notice, true);

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/me/preferences",
      headers: { cookie: userCookie },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);

    const after = await prisma.userContentPreference.count({ where: { userId: guest.id } });
    assert.equal(after, 0);
  } finally {
    await app.close();
  }
});

test("finance routes enforce role checks and keep address pool masked", async () => {
  const app = await createApp(prisma);
  try {
    const financeCookie = await loginAdmin(app, "finance");
    const operatorCookie = await loginAdmin(app, "operator");

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/finance/address-pool",
      headers: { cookie: operatorCookie },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);

    const financeRes = await app.inject({
      method: "GET",
      url: "/api/admin/finance/address-pool",
      headers: { cookie: financeCookie },
    });
    assert.equal(financeRes.statusCode, 200, financeRes.body);
    const body = financeRes.json() as any;
    assert.equal(Array.isArray(body.rows), true);
    if (body.rows.length > 0) {
      assert.equal(typeof body.rows[0].addressMasked, "string");
      assert.equal("address" in body.rows[0], false);
    }

    const overview = await app.inject({
      method: "GET",
      url: "/api/admin/finance/overview",
      headers: { cookie: financeCookie },
    });
    assert.equal(overview.statusCode, 200, overview.body);
    const metrics = (overview.json() as any).metrics;
    assert.equal("totalConfirmedAmount" in metrics, false, "不得把 Stars 与 USDT 合并为总金额");
    assert.equal("averageOrderValue" in metrics, false, "不得生成跨币种平均客单价");
    assert.equal(typeof metrics.averageOrderValueByMethod.telegram_stars, "string");
    assert.equal(typeof metrics.averageOrderValueByMethod.usdt_trc20, "string");
  } finally {
    await app.close();
  }
});
