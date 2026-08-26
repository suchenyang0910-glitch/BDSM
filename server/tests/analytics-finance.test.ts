import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import adminRoutes from "../src/routes/admin.js";
import analyticsAndPreferenceRoutes from "../src/routes/analyticsPreferences.js";
import adminFinanceRoutes from "../src/routes/adminFinance.js";
import trafficEntryRoutes from "../src/routes/trafficEntries.js";
import campaignRoutes from "../src/routes/campaigns.js";
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
  await app.register(trafficEntryRoutes, { prefix: "/api" });
  await app.register(campaignRoutes, { prefix: "/api" });
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
          {
            eventName: "checkout_open",
            payload: {
              platform: "telegram_mini_app",
              contentId: TEST_KNOWN_IDS.contentMembership,
              productId: TEST_KNOWN_IDS.membershipProductKey,
              orderNo: "INT20260823000002",
              paymentMethod: "telegram_stars",
              invoiceLink: "https://t.me/invoice_should_not_be_kept",
            },
          },
          {
            eventName: "playback_first_frame",
            payload: {
              platform: "h5",
              contentId: TEST_KNOWN_IDS.contentMembership,
              sessionId: "playback-session-raw-id",
              quality: "1080p",
              elapsedMs: 1380,
              manifestUrl: "https://video.example.com/private.m3u8",
            },
          },
          {
            eventName: "playback_prefetch_result",
            payload: {
              platform: "h5",
              contentId: TEST_KNOWN_IDS.contentMembership,
              sessionId: "playback-session-raw-id",
              quality: "preview",
              result: "hit",
              source: "preview_prefetch",
              segmentUrl: "https://video.example.com/seg-1.m4s",
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

    const checkoutRow = await prisma.analyticsEvent.findFirst({
      where: { eventName: "checkout_open", userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(checkoutRow);
    const checkoutProps = (checkoutRow as any).propertiesJson as Record<string, unknown>;
    assert.equal(checkoutProps.paymentMethod, "telegram_stars");
    assert.equal(typeof checkoutProps.orderNoHmac, "string");
    assert.equal(typeof checkoutProps.productIdHmac, "string");
    assert.equal(typeof checkoutProps.contentIdHmac, "string");
    assert.equal("invoiceLink" in checkoutProps, false);

    const playbackRow = await prisma.analyticsEvent.findFirst({
      where: { eventName: "playback_first_frame", userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(playbackRow);
    const playbackProps = (playbackRow as any).propertiesJson as Record<string, unknown>;
    assert.equal(playbackProps.quality, "1080p");
    assert.equal(playbackProps.elapsedBucket, "1_2s");
    assert.equal(typeof playbackProps.sessionIdHmac, "string");
    assert.equal("manifestUrl" in playbackProps, false);
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
    assert.equal(body.funnel.length, 7);
    assert.equal(typeof body.playback.prefetch.hitRate, "number");
    assert.equal(Array.isArray(body.playback.qualityChanges), true);
    assert.equal(Array.isArray(body.preferences), true);
    assert.equal(JSON.stringify(body).includes("analytics user"), false, "overview must not expose user identity");
    assert.equal(JSON.stringify(body).includes("INT20260823000001"), false, "overview must not expose order identifiers");
  } finally {
    await app.close();
  }
});

test("traffic entries support admin CRUD, public resolve, and aggregated attribution metrics", async () => {
  const app = await createApp(prisma);
  try {
    const operatorCookie = await loginAdmin(app, "operator");
    const supportCookie = await loginAdmin(app, "customerService");
    const trafficCode = `tg_channel_q3_${Date.now().toString().slice(-6)}`;

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/traffic-entries",
      headers: { cookie: operatorCookie, "Content-Type": "application/json" },
      payload: {
        name: "TG Channel Q3",
        code: trafficCode,
        entryType: "telegram_channel",
        destinationType: "content",
        destinationId: TEST_KNOWN_IDS.contentMembership,
        status: "active",
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const createdBody = created.json() as any;
    assert.equal(typeof createdBody.id, "string");

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/traffic-entries?preset=7d",
      headers: { cookie: supportCookie },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);

    const resolved = await app.inject({
      method: "GET",
      url: `/api/traffic-entries/resolve?code=${encodeURIComponent(trafficCode)}`,
      headers: { host: "admin.invalid", "x-forwarded-proto": "http" },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    const resolvedBody = resolved.json() as any;
    assert.equal(resolvedBody.entry.code, trafficCode);
    assert.equal(resolvedBody.entry.destinationType, "content");
    assert.equal(typeof resolvedBody.links.h5, "string");
    assert.equal(resolvedBody.links.h5.includes(`te=${trafficCode}`), true);
    assert.equal(resolvedBody.links.h5.includes("admin.invalid"), false, "H5 link must not inherit an admin Host header");
    assert.equal(resolvedBody.links.miniApp.includes("admin.invalid"), false, "Mini App link must not inherit an admin Host header");
    assert.match(resolvedBody.links.h5, /^https:\/\//);
    assert.match(resolvedBody.links.miniApp, /^https:\/\//);

    const user = await prisma.user.create({
      data: {
        telegramUserId: BigInt(`8${Date.now().toString().slice(-9)}`),
        displayName: "traffic entry user",
      },
    });
    const userCookie = await loginUser(app, user.id, user.telegramUserId?.toString());
    const analyticsRes = await app.inject({
      method: "POST",
      url: "/api/analytics/events",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: {
        events: [
          {
            eventName: "session_started",
            payload: {
              platform: "h5",
              entrySource: "h5_direct",
              trafficEntryCode: trafficCode,
              entryType: "telegram_channel",
              destinationType: "content",
              destinationId: TEST_KNOWN_IDS.contentMembership,
            },
          },
          {
            eventName: "traffic_entry_open",
            payload: {
              platform: "h5",
              trafficEntryCode: trafficCode,
              entryType: "telegram_channel",
              destinationType: "content",
              destinationId: TEST_KNOWN_IDS.contentMembership,
              contentId: TEST_KNOWN_IDS.contentMembership,
            },
          },
          {
            eventName: "content_opened",
            payload: {
              platform: "h5",
              contentId: TEST_KNOWN_IDS.contentMembership,
              sourceModule: "home",
              trafficEntryCode: trafficCode,
              entryType: "telegram_channel",
              destinationType: "content",
              destinationId: TEST_KNOWN_IDS.contentMembership,
            },
          },
          {
            eventName: "checkout_open",
            payload: {
              platform: "h5",
              contentId: TEST_KNOWN_IDS.contentMembership,
              productId: TEST_KNOWN_IDS.membershipProductKey,
              paymentMethod: "telegram_stars",
              trafficEntryCode: trafficCode,
              entryType: "telegram_channel",
              destinationType: "content",
              destinationId: TEST_KNOWN_IDS.contentMembership,
            },
          },
          {
            eventName: "payment_confirmed",
            payload: {
              platform: "h5",
              orderNo: "INT_TRAFFIC_001",
              productId: TEST_KNOWN_IDS.membershipProductKey,
              paymentMethod: "telegram_stars",
              trafficEntryCode: trafficCode,
              entryType: "telegram_channel",
              destinationType: "content",
              destinationId: TEST_KNOWN_IDS.contentMembership,
            },
          },
        ],
      },
    });
    assert.equal(analyticsRes.statusCode, 202, analyticsRes.body);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/traffic-entries?preset=7d",
      headers: { cookie: operatorCookie },
    });
    assert.equal(list.statusCode, 200, list.body);
    const listBody = list.json() as any;
    const row = listBody.items.find((item: any) => item.code === trafficCode);
    assert.ok(row, list.body);
    assert.equal(row.metrics.opens, 1);
    assert.equal(row.metrics.contentOpened, 1);
    assert.equal(row.metrics.checkoutOpen, 1);
    assert.equal(row.metrics.paymentConfirmed, 1);
    assert.equal(row.destinationLabel, "深度睡眠引导");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/admin/traffic-entries/${encodeURIComponent(createdBody.id)}`,
      headers: { cookie: operatorCookie, "Content-Type": "application/json" },
      payload: {
        name: "TG Channel Q3 Disabled",
        code: trafficCode,
        entryType: "telegram_channel",
        destinationType: "content",
        destinationId: TEST_KNOWN_IDS.contentMembership,
        status: "inactive",
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);

    const resolveInactive = await app.inject({
      method: "GET",
      url: `/api/traffic-entries/resolve?code=${encodeURIComponent(trafficCode)}`,
    });
    assert.equal(resolveInactive.statusCode, 404, resolveInactive.body);
  } finally {
    await app.close();
  }
});

test("campaigns support admin CRUD and aggregate linked traffic entry metrics", async () => {
  const app = await createApp(prisma);
  try {
    const operatorCookie = await loginAdmin(app, "operator");
    const auditorCookie = await loginAdmin(app, "auditor");
    const trafficCode = `camp_tg_${Date.now().toString().slice(-6)}`;

    const trafficCreate = await app.inject({
      method: "POST",
      url: "/api/admin/traffic-entries",
      headers: { cookie: operatorCookie, "Content-Type": "application/json" },
      payload: {
        name: "Campaign Entry",
        code: trafficCode,
        entryType: "telegram_channel",
        destinationType: "content",
        destinationId: TEST_KNOWN_IDS.contentPublic,
        status: "active",
      },
    });
    assert.equal(trafficCreate.statusCode, 200, trafficCreate.body);
    const trafficEntryId = (trafficCreate.json() as any).id;

    const campaignCreate = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      headers: { cookie: operatorCookie, "Content-Type": "application/json" },
      payload: {
        name: "Q3 Campaign",
        code: `q3_campaign_${Date.now().toString().slice(-6)}`,
        status: "active",
        summary: "绑定 banner 与流量入口",
        bannerIds: [TEST_KNOWN_IDS.bannerHomeTop1],
        trafficEntryIds: [trafficEntryId],
      },
    });
    assert.equal(campaignCreate.statusCode, 200, campaignCreate.body);
    const campaignId = (campaignCreate.json() as any).id;

    const campaignForbidden = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      headers: { cookie: auditorCookie, "Content-Type": "application/json" },
      payload: {
        name: "forbidden",
        code: "forbidden_campaign",
        status: "draft",
        bannerIds: [],
        trafficEntryIds: [],
      },
    });
    assert.equal(campaignForbidden.statusCode, 403, campaignForbidden.body);

    const user = await prisma.user.create({
      data: {
        telegramUserId: BigInt(`9${Date.now().toString().slice(-9)}`),
        displayName: "campaign user",
      },
    });
    const userCookie = await loginUser(app, user.id, user.telegramUserId?.toString());
    const analyticsRes = await app.inject({
      method: "POST",
      url: "/api/analytics/events",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: {
        events: [
          {
            eventName: "traffic_entry_open",
            payload: {
              platform: "h5",
              trafficEntryCode: trafficCode,
              entryType: "telegram_channel",
              destinationType: "content",
              destinationId: TEST_KNOWN_IDS.contentPublic,
              contentId: TEST_KNOWN_IDS.contentPublic,
            },
          },
          {
            eventName: "content_opened",
            payload: {
              platform: "h5",
              contentId: TEST_KNOWN_IDS.contentPublic,
              sourceModule: "home",
              trafficEntryCode: trafficCode,
              entryType: "telegram_channel",
              destinationType: "content",
              destinationId: TEST_KNOWN_IDS.contentPublic,
            },
          },
          {
            eventName: "checkout_open",
            payload: {
              platform: "h5",
              contentId: TEST_KNOWN_IDS.contentPublic,
              productId: TEST_KNOWN_IDS.singleProductKey,
              paymentMethod: "telegram_stars",
              trafficEntryCode: trafficCode,
              entryType: "telegram_channel",
              destinationType: "content",
              destinationId: TEST_KNOWN_IDS.contentPublic,
            },
          },
          {
            eventName: "payment_confirmed",
            payload: {
              platform: "h5",
              orderNo: "INT_CAMPAIGN_001",
              productId: TEST_KNOWN_IDS.singleProductKey,
              paymentMethod: "telegram_stars",
              trafficEntryCode: trafficCode,
              entryType: "telegram_channel",
              destinationType: "content",
              destinationId: TEST_KNOWN_IDS.contentPublic,
            },
          },
        ],
      },
    });
    assert.equal(analyticsRes.statusCode, 202, analyticsRes.body);

    const campaignList = await app.inject({
      method: "GET",
      url: "/api/admin/campaigns",
      headers: { cookie: operatorCookie },
    });
    assert.equal(campaignList.statusCode, 200, campaignList.body);
    const campaignBody = campaignList.json() as any;
    const row = campaignBody.items.find((item: any) => item.id === campaignId);
    assert.ok(row, campaignList.body);
    assert.equal(row.banners.length, 1);
    assert.equal(row.trafficEntries.length, 1);
    assert.equal(row.metrics.opens, 1);
    assert.equal(row.metrics.contentOpened, 1);
    assert.equal(row.metrics.checkoutOpen, 1);
    assert.equal(row.metrics.paymentConfirmed, 1);

    const campaignUpdate = await app.inject({
      method: "PATCH",
      url: `/api/admin/campaigns/${encodeURIComponent(campaignId)}`,
      headers: { cookie: operatorCookie, "Content-Type": "application/json" },
      payload: {
        name: "Q3 Campaign Archived",
        code: row.code,
        status: "archived",
        summary: "活动归档",
        bannerIds: [TEST_KNOWN_IDS.bannerHomeTop1],
        trafficEntryIds: [trafficEntryId],
      },
    });
    assert.equal(campaignUpdate.statusCode, 200, campaignUpdate.body);
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
