import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";

import adminRoutes from "../src/routes/admin.js";
import adminArticleRoutes from "../src/routes/adminArticles.js";
import { setupTestHarness, teardownTestHarness, seedTestData, TEST_CREDENTIALS } from "./_testHarness.js";

function cookieFromResponse(res: { headers: Record<string, unknown> }): string {
  const value = res.headers["set-cookie"];
  const rows = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return rows.map((row) => row.split(";")[0]).join("; ");
}

async function createApp(prisma: any) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, { secret: "test-session-secret-is-at-least-thirty-two-characters", cookie: { secure: false } });
  app.decorate("prisma", prisma);
  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(adminArticleRoutes, { prefix: "/api" });
  return app;
}

async function login(app: any, role: "editor" | "auditor" | "superAdmin") {
  const credentials = TEST_CREDENTIALS[role];
  const response = await app.inject({ method: "POST", url: "/api/admin/login", payload: { email: credentials.email, password: credentials.password } });
  assert.equal(response.statusCode, 200, response.body);
  return cookieFromResponse(response);
}

const harness = await setupTestHarness();
await seedTestData(harness.prisma);

test.after(async () => { await teardownTestHarness(harness.prisma); });

test("article publish requires a cover, requires content:publish, and reports an unconfigured free channel", async () => {
  const app = await createApp(harness.prisma);
  try {
    const editorCookie = await login(app, "editor");
    const auditorCookie = await login(app, "auditor");
    const superCookie = await login(app, "superAdmin");
    const base = {
      slug: `article-${Date.now()}`,
      title: "后台文章发布验收",
      summary: "这是一段用于后台文章发布流程验收的足够长摘要。",
      bodyHtml: "<p>这是一段超过二十个字符的文章正文，用于测试后台发布。</p>",
      topics: ["沟通"], seoKeywords: ["边界"], geoKeywords: [],
    };
    const create = await app.inject({ method: "POST", url: "/api/admin/articles", headers: { cookie: editorCookie }, payload: base });
    assert.equal(create.statusCode, 201, create.body);
    const id = create.json().article.id as string;

    const forbidden = await app.inject({ method: "POST", url: `/api/admin/articles/${id}/publish`, headers: { cookie: auditorCookie } });
    assert.equal(forbidden.statusCode, 403, forbidden.body);

    const missingCover = await app.inject({ method: "POST", url: `/api/admin/articles/${id}/publish`, headers: { cookie: superCookie } });
    assert.equal(missingCover.statusCode, 409, missingCover.body);
    assert.equal(missingCover.json().error, "article_cover_required");

    await harness.prisma.article.update({ where: { id }, data: { coverImageUrl: "https://samewave.cc/article-assets/example.png" } });
    const published = await app.inject({ method: "POST", url: `/api/admin/articles/${id}/publish`, headers: { cookie: superCookie } });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json().article.status, "published");
    assert.equal(published.json().delivery.reason, "no_free_channel");
  } finally { await app.close(); }
});
