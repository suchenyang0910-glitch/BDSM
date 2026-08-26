import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import homeRoutes from "../src/routes/home.js";
import contentRoutes from "../src/routes/contents.js";
import resourceRoutes from "../src/routes/resources.js";
import {
  setupTestHarness,
  teardownTestHarness,
  seedTestData,
  TEST_KNOWN_IDS,
} from "./_testHarness.js";

async function createTestApp(prisma: any) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, { secret: "test-session-secret-is-at-least-thirty-two-characters", cookie: { secure: false } });
  app.decorate("prisma", prisma);
  app.decorateRequest("userId", null);
  app.addHook("preHandler", async (request) => {
    const storedSession = request.session as unknown as { userId?: string };
    if (storedSession.userId) (request as unknown as { userId: string }).userId = storedSession.userId;
  });
  await app.register(homeRoutes, { prefix: "/api" });
  await app.register(contentRoutes, { prefix: "/api" });
  await app.register(resourceRoutes, { prefix: "/api" });
  return app;
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("catalog APIs return seeded home, category and content data", async () => {
  const app = await createTestApp(prisma);
  try {
    const home = await app.inject({ method: "GET", url: "/api/home" });
    assert.equal(home.statusCode, 200, home.body);
    const homeBody = home.json() as { banners: unknown[]; categories: unknown[]; contents: any[]; seo?: any; robots?: string };
    assert.ok(homeBody.banners.length > 0, "home banners should be seeded");
    assert.ok(homeBody.categories.length > 0, "home categories should be seeded");
    assert.ok(homeBody.contents.length > 0, "home contents should be seeded");
    assert.equal(homeBody.robots, "noindex,nofollow", "home should stay noindex by default");
    assert.equal(homeBody.seo?.title, "同频平台默认 SEO 标题", "home should inherit platform SEO title");
    assert.ok(Array.isArray(homeBody.contents[0]?.effectiveSeo?.keywords), "content list should expose effectiveSeo");

    const contents = await app.inject({ method: "GET", url: "/api/contents?pageSize=5" });
    assert.equal(contents.statusCode, 200, contents.body);
    const listBody = contents.json() as { items: any[] };
    assert.ok(listBody.items.length > 0, "contents paged should have seed data");
    assert.ok(listBody.items.every((item) => item.effectiveSeo && typeof item.effectiveSeo === "object"), "list items should include effectiveSeo");

    const detail = await app.inject({ method: "GET", url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}` });
    assert.equal(detail.statusCode, 200, detail.body);
    const detailBody = detail.json() as any;
    assert.equal(detailBody.id, TEST_KNOWN_IDS.contentMembership, "content detail id match");
    assert.equal(detailBody.robots, "noindex,nofollow", "content detail should stay noindex by default");
    assert.equal(detailBody.effectiveSeo?.description, "会员内容 SEO 描述", "detail should prefer content SEO override");
    assert.equal(
      detailBody.product?.id,
      TEST_KNOWN_IDS.membershipProductKey,
      "membership content without an explicit product should inherit the sole active 30-day membership product",
    );
    assert.equal(detailBody.videoObjectJsonLd, null, "private detail must not expose VideoObject JSON-LD");
  } finally {
    await app.close();
  }
});

test("published VOD cover is exposed through a controlled public content route", async () => {
  const app = await createTestApp(prisma);
  try {
    await prisma.videoAsset.create({
      data: {
        contentId: TEST_KNOWN_IDS.contentMembership,
        kind: "cover",
        objectKey: `covers/${TEST_KNOWN_IDS.contentMembership}/00000000-0000-0000-0000-000000000001/cover.jpg`,
        mimeType: "image/jpeg",
        byteSize: 1024n,
        sha256: "a".repeat(64),
        status: "verified",
        verifiedAt: new Date(),
      },
    });

    const list = await app.inject({ method: "GET", url: "/api/contents?pageSize=20" });
    assert.equal(list.statusCode, 200, list.body);
    const listItem = (list.json() as any).items.find((item: any) => item.id === TEST_KNOWN_IDS.contentMembership);
    assert.equal(listItem?.coverUrl, `/api/contents/${TEST_KNOWN_IDS.contentMembership}/cover`);

    const home = await app.inject({ method: "GET", url: "/api/home" });
    assert.equal(home.statusCode, 200, home.body);
    const homeItem = (home.json() as any).contents.find((item: any) => item.id === TEST_KNOWN_IDS.contentMembership);
    assert.equal(homeItem?.coverUrl, `/api/contents/${TEST_KNOWN_IDS.contentMembership}/cover`);

    const detail = await app.inject({ method: "GET", url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}` });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal((detail.json() as any).coverUrl, `/api/contents/${TEST_KNOWN_IDS.contentMembership}/cover`);
  } finally {
    await app.close();
  }
});

test("legacy MediaAsset covers use the controlled route and never leak a durable storage URL", async () => {
  const app = await createTestApp(prisma);
  const assetId = "legacy-cover-control-test";
  try {
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        kind: "cover_image",
        status: "ready",
        storageBucket: "test-bucket",
        storageKey: "20260826/cover_image/legacy-cover.jpg",
        storagePublicUrl: "https://storage.invalid/durable-cover.jpg",
      },
    });
    await prisma.content.update({
      where: { id: TEST_KNOWN_IDS.contentPublic },
      data: { coverAssetId: assetId, coverUrl: "https://storage.invalid/durable-cover.jpg" },
    });

    const list = await app.inject({ method: "GET", url: "/api/contents?pageSize=20" });
    const listed = (list.json() as any).items.find((item: any) => item.id === TEST_KNOWN_IDS.contentPublic);
    assert.equal(listed?.coverUrl, `/api/contents/${TEST_KNOWN_IDS.contentPublic}/cover`);
    assert.doesNotMatch(String(listed?.coverUrl || ""), /storage\.invalid/);

    const detail = await app.inject({ method: "GET", url: `/api/contents/${TEST_KNOWN_IDS.contentPublic}` });
    assert.equal((detail.json() as any).coverUrl, `/api/contents/${TEST_KNOWN_IDS.contentPublic}/cover`);
  } finally {
    await prisma.content.update({ where: { id: TEST_KNOWN_IDS.contentPublic }, data: { coverAssetId: null, coverUrl: null } });
    await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
    await app.close();
  }
});

test("access-link routes enforce POST and authenticated session", async () => {
  const app = await createTestApp(prisma);
  try {
    const noSession = await app.inject({ method: "POST", url: "/api/resources/not-a-real-id/access-link" });
    assert.equal(noSession.statusCode, 401, "access-link without session = 401");

    const deprecated = await app.inject({ method: "GET", url: "/api/videos/not-a-real-id/telegram-link" });
    assert.equal(deprecated.statusCode, 410, "old GET /api/videos 410 gone");

    const wrongMethod = await app.inject({ method: "GET", url: "/api/resources/not-a-real-id/access-link" });
    assert.equal(wrongMethod.statusCode, 405, "GET access-link = 405 method not allowed");

    const browserFormPost = await app.inject({
      method: "POST",
      url: "/api/resources/not-a-real-id/access-link",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    assert.equal(browserFormPost.statusCode, 401, "browser form POST must reach auth, not fail with 415");
  } finally {
    await app.close();
  }
});
