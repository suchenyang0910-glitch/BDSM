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
    const homeBody = home.json() as { banners: unknown[]; categories: unknown[]; contents: unknown[] };
    assert.ok(homeBody.banners.length > 0, "home banners should be seeded");
    assert.ok(homeBody.categories.length > 0, "home categories should be seeded");
    assert.ok(homeBody.contents.length > 0, "home contents should be seeded");

    const contents = await app.inject({ method: "GET", url: "/api/contents?pageSize=5" });
    assert.equal(contents.statusCode, 200, contents.body);
    assert.ok((contents.json() as { items: unknown[] }).items.length > 0, "contents paged should have seed data");

    const detail = await app.inject({ method: "GET", url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}` });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal((detail.json() as any).id, TEST_KNOWN_IDS.contentMembership, "content detail id match");
  } finally {
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
  } finally {
    await app.close();
  }
});
