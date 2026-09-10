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

test("article create and draft edit return a clear conflict when the slug is already used", async () => {
  const app = await createApp(harness.prisma);
  try {
    const editorCookie = await login(app, "editor");
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const first = {
      slug: `article-slug-first-${suffix}`,
      title: "文章链接冲突验收一",
      summary: "这是一段用于文章链接冲突验收的足够长摘要一。",
      bodyHtml: "<p>这是一段超过二十个字符的文章正文，用于测试文章链接冲突一。</p>",
      topics: ["沟通"], seoKeywords: ["边界"], geoKeywords: [],
    };
    const second = { ...first, slug: `article-slug-second-${suffix}`, title: "文章链接冲突验收二" };
    const createdFirst = await app.inject({ method: "POST", url: "/api/admin/articles", headers: { cookie: editorCookie }, payload: first });
    const createdSecond = await app.inject({ method: "POST", url: "/api/admin/articles", headers: { cookie: editorCookie }, payload: second });
    assert.equal(createdFirst.statusCode, 201, createdFirst.body);
    assert.equal(createdSecond.statusCode, 201, createdSecond.body);

    const duplicateCreate = await app.inject({ method: "POST", url: "/api/admin/articles", headers: { cookie: editorCookie }, payload: { ...first, title: "重复链接新建" } });
    assert.equal(duplicateCreate.statusCode, 409, duplicateCreate.body);
    assert.deepEqual(duplicateCreate.json(), { error: "article_slug_taken", message: "文章链接标识已被使用，请换一个后再保存。" });

    const firstId = createdFirst.json().article.id as string;
    const duplicateEdit = await app.inject({ method: "PATCH", url: `/api/admin/articles/${firstId}`, headers: { cookie: editorCookie }, payload: second });
    assert.equal(duplicateEdit.statusCode, 409, duplicateEdit.body);
    assert.deepEqual(duplicateEdit.json(), { error: "article_slug_taken", message: "文章链接标识已被使用，请换一个后再保存。" });

    const ownSlugEdit = await app.inject({ method: "PATCH", url: `/api/admin/articles/${firstId}`, headers: { cookie: editorCookie }, payload: { ...first, title: "文章链接冲突验收一已更新" } });
    assert.equal(ownSlugEdit.statusCode, 200, ownSlugEdit.body);
  } finally { await app.close(); }
});

test("article list returns aggregate views and interaction counts without reader identities", async () => {
  const app = await createApp(harness.prisma);
  try {
    const editorCookie = await login(app, "editor");
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const created = await app.inject({ method: "POST", url: "/api/admin/articles", headers: { cookie: editorCookie }, payload: {
      slug: `article-metrics-${suffix}`,
      title: "文章数据统计验收",
      summary: "这是一段用于验证文章后台聚合数据的足够长摘要。",
      bodyHtml: "<p>这是一段用于验证后台聚合数据且超过二十个字符的文章正文。</p>",
      topics: ["沟通"], seoKeywords: [], geoKeywords: [],
    } });
    assert.equal(created.statusCode, 201, created.body);
    const article = created.json().article as { id: string; slug: string };
    const user = await harness.prisma.user.create({ data: {
      telegramUserId: BigInt(`91${String(Date.now()).slice(-10)}`),
      displayName: "文章统计测试用户",
      status: "active",
    } });
    await harness.prisma.analyticsEvent.createMany({ data: [1, 2].map((index) => ({
      occurredAt: new Date(), eventName: "article_opened", anonymousIdHmac: `anon-article-${suffix}`, sessionIdHmac: `session-article-${suffix}`,
      platform: "h5", propertiesJson: { articleSlug: article.slug },
    })) });
    await harness.prisma.interactionLike.create({ data: { subjectKind: "target", subjectKey: `article:${article.id}`, targetType: "article", targetId: article.id, userId: user.id } });
    await harness.prisma.interactionComment.create({ data: { targetType: "article", targetId: article.id, userId: user.id, body: "用于验证统计的公开评论。", status: "approved" } });
    await harness.prisma.interactionReport.create({ data: { targetType: "article", targetId: article.id, reporterUserId: user.id, reasonCode: "spam" } });
    const list = await app.inject({ method: "GET", url: "/api/admin/articles", headers: { cookie: editorCookie } });
    assert.equal(list.statusCode, 200, list.body);
    const row = list.json().items.find((item: any) => item.id === article.id);
    assert.deepEqual(row.metrics, { views: 2, viewers: 1, likeCount: 1, commentCount: 1, reportCount: 1 });
    assert.equal(JSON.stringify(row.metrics).includes("session-article"), false);
  } finally { await app.close(); }
});
