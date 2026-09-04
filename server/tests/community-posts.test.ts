import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import { Readable } from "node:stream";
import { registerCommunityPostRoutes } from "../src/routes/communityPosts.js";
import communityMediaRoutes from "../src/routes/communityMedia.js";
import publicSeoRoutes from "../src/routes/publicSeo.js";
import { getS3Client } from "../src/services/objectStorage.js";
import { seedTestData, setupTestHarness, teardownTestHarness } from "./_testHarness.js";

process.env.OBJECT_STORAGE_ENDPOINT = process.env.OBJECT_STORAGE_ENDPOINT || "https://example-object-storage.local";
process.env.OBJECT_STORAGE_REGION = process.env.OBJECT_STORAGE_REGION || "local";
process.env.OBJECT_STORAGE_BUCKET = process.env.OBJECT_STORAGE_BUCKET || "intune-test-private";
process.env.OBJECT_STORAGE_ACCESS_KEY = process.env.OBJECT_STORAGE_ACCESS_KEY || "test-access";
process.env.OBJECT_STORAGE_SECRET_KEY = process.env.OBJECT_STORAGE_SECRET_KEY || "test-secret";
process.env.COMMUNITY_MEDIA_RUNNER = "mock";
process.env.COMMUNITY_ENABLED = "true";
process.env.COMMUNITY_POSTING_ENABLED = "true";
process.env.COMMUNITY_VIDEO_UPLOAD_ENABLED = "false";

function cookieFromResponse(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const cookies: string[] = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  return cookies.map((c: string) => c.split(";")[0]).join("; ");
}

function installS3CommandMock(factory: (command: any) => any) {
  const client = getS3Client() as any;
  const originalSend = client.send.bind(client);
  client.send = async (command: any) => {
    const mocked = await factory(command);
    if (typeof mocked !== "undefined") return mocked;
    return originalSend(command);
  };
  return () => {
    client.send = originalSend;
  };
}

async function createApp(prisma: any) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, { secret: "test-session-secret-is-at-least-thirty-two-characters", cookie: { secure: false } });
  app.decorate("prisma", prisma);
  app.decorateRequest("userId", null);
  app.decorateRequest("telegramUserId", null);
  app.addHook("preHandler", async (req) => {
    const sess = req.session as any;
    if (sess?.userId) {
      (req as any).userId = sess.userId;
      (req as any).telegramUserId = sess.telegramUserId || null;
    }
  });
  app.post("/__test/login-user/:id", async (req) => {
    (req.session as any).userId = (req.params as any).id;
    return { ok: true };
  });
  await app.register(registerCommunityPostRoutes, { prefix: "/api" });
  await app.register(communityMediaRoutes, { prefix: "/api" });
  await app.register(publicSeoRoutes, { prefix: "" });
  return app;
}

async function createUser(prisma: any, displayName: string) {
  return prisma.user.create({
    data: {
      displayName,
      status: "active",
      telegramUserId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 100000)),
    },
  });
}

async function loginUser(app: any, userId: string) {
  const login = await app.inject({ method: "POST", url: `/__test/login-user/${userId}` });
  return cookieFromResponse(login);
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("community posts list stays public-only while authors can inspect their own pending drafts", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const author = await createUser(prisma, "社区作者 A");
    const visitor = await createUser(prisma, "社区访客 A");
    const authorCookie = await loginUser(app, author.id);
    const visitorCookie = await loginUser(app, visitor.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/community/posts",
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: { body: "待审核的圈子首帖", topics: ["边界", "沟通"] },
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = created.json() as any;
    const postId = String(createdBody.post.id);

    const publicList = await app.inject({ method: "GET", url: "/api/community/posts" });
    assert.equal(publicList.statusCode, 200, publicList.body);
    assert.equal((publicList.json() as any).items.some((item: any) => item.id === postId), false);

    const visitorDetail = await app.inject({
      method: "GET",
      url: `/api/community/posts/${encodeURIComponent(postId)}`,
      headers: { cookie: visitorCookie },
    });
    assert.equal(visitorDetail.statusCode, 404, visitorDetail.body);

    const authorDetail = await app.inject({
      method: "GET",
      url: `/api/community/posts/${encodeURIComponent(postId)}`,
      headers: { cookie: authorCookie },
    });
    assert.equal(authorDetail.statusCode, 200, authorDetail.body);
    assert.equal((authorDetail.json() as any).status, "pending");

    const myPosts = await app.inject({
      method: "GET",
      url: "/api/community/me/posts",
      headers: { cookie: authorCookie },
    });
    assert.equal(myPosts.statusCode, 200, myPosts.body);
    assert.equal((myPosts.json() as any).items[0].id, postId);

    await prisma.communityPost.update({
      where: { id: postId },
      data: { status: "rejected", moderationReason: "请补充上下文" },
    });
    const resubmitted = await app.inject({
      method: "PATCH",
      url: `/api/community/posts/${encodeURIComponent(postId)}`,
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: { body: "已补充上下文的圈子首帖", topics: ["边界"] },
    });
    assert.equal(resubmitted.statusCode, 200, resubmitted.body);
    assert.equal((resubmitted.json() as any).post.status, "pending");
    assert.equal((resubmitted.json() as any).post.moderationReason, null);

    await prisma.communityPost.update({
      where: { id: postId },
      data: { status: "published", publishedAt: new Date() },
    });
    const publishedList = await app.inject({ method: "GET", url: "/api/community/posts" });
    assert.equal(publishedList.statusCode, 200, publishedList.body);
    const listedPost = (publishedList.json() as any).items.find((item: any) => item.id === postId);
    assert.ok(listedPost);
    assert.equal(listedPost.isOfficial, false);
    assert.equal(listedPost.aiAssisted, false);
  } finally {
    await app.close();
  }
});

test("community cursor pagination preserves pinned ordering without duplicates", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const author = await createUser(prisma, "社区置顶作者");
    const now = new Date();
    const rows = await Promise.all([
      prisma.communityPost.create({ data: { authorId: author.id, body: "普通帖子一", topics: ["测试"], status: "published", publishedAt: new Date(now.getTime() - 2_000) } }),
      prisma.communityPost.create({ data: { authorId: author.id, body: "置顶帖子", topics: ["测试"], status: "published", isPinned: true, publishedAt: new Date(now.getTime() - 3_000) } }),
      prisma.communityPost.create({ data: { authorId: author.id, body: "普通帖子二", topics: ["测试"], status: "published", publishedAt: new Date(now.getTime() - 1_000) } }),
    ]);
    const first = await app.inject({ method: "GET", url: "/api/community/posts?limit=1" });
    assert.equal(first.statusCode, 200, first.body);
    const firstBody = first.json() as any;
    assert.equal(firstBody.items[0].id, rows[1].id);
    assert.ok(firstBody.nextCursor);
    const second = await app.inject({ method: "GET", url: `/api/community/posts?limit=10&cursor=${encodeURIComponent(firstBody.nextCursor)}` });
    assert.equal(second.statusCode, 200, second.body);
    const ids = (second.json() as any).items.map((item: any) => item.id);
    assert.equal(ids.includes(rows[1].id), false);
    assert.equal(ids.includes(rows[0].id), true);
    assert.equal(ids.includes(rows[2].id), true);
  } finally {
    await app.close();
  }
});

test("community image gateway stays private but author can preview own pending image through the gateway", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  let currentSessionId = "";
  const restoreS3 = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "HeadObjectCommand") {
      return {
        ContentLength: 1024,
        ContentType: "image/jpeg",
        Metadata: { uploadsessionid: currentSessionId, sha256: "C".repeat(44) },
      };
    }
    if (name === "GetObjectCommand") {
      return { Body: Readable.from(Buffer.from("mock-community-image")) };
    }
    if (name === "PutObjectCommand") {
      return {};
    }
    return undefined;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from("thumb-bytes"), { status: 200, headers: { "content-type": "image/jpeg" } });
  try {
    const author = await createUser(prisma, "社区作者 B");
    const outsider = await createUser(prisma, "社区访客 B");
    const authorCookie = await loginUser(app, author.id);
    const outsiderCookie = await loginUser(app, outsider.id);
    const created = await app.inject({
      method: "POST",
      url: "/api/community/posts",
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: { body: "带图片的待审帖子", topics: ["图文"] },
    });
    const postId = String((created.json() as any).post.id);
    const uploadInit = await app.inject({
      method: "POST",
      url: `/api/community/posts/${encodeURIComponent(postId)}/assets/upload-session`,
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: { kind: "image", filename: "cover.jpg", mimeType: "image/jpeg", byteSize: 1024, sha256: "C".repeat(44) },
    });
    assert.equal(uploadInit.statusCode, 200, uploadInit.body);
    const uploadBody = uploadInit.json() as any;
    currentSessionId = uploadBody.uploadSessionId;
    const complete = await app.inject({
      method: "POST",
      url: `/api/community/upload-sessions/${encodeURIComponent(currentSessionId)}/complete`,
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(complete.statusCode, 200, complete.body);
    const asset = await prisma.communityPostAsset.findFirstOrThrow({ where: { postId } });

    const outsiderRead = await app.inject({
      method: "GET",
      url: `/api/community/posts/${encodeURIComponent(postId)}/assets/${encodeURIComponent(asset.id)}/image`,
      headers: { cookie: outsiderCookie },
    });
    assert.equal(outsiderRead.statusCode, 404, outsiderRead.body);

    const authorRead = await app.inject({
      method: "GET",
      url: `/api/community/posts/${encodeURIComponent(postId)}/assets/${encodeURIComponent(asset.id)}/image`,
      headers: { cookie: authorCookie },
    });
    assert.equal(authorRead.statusCode, 200, authorRead.body);
  } finally {
    globalThis.fetch = originalFetch;
    restoreS3();
    await app.close();
  }
});

test("community SEO pages expose public list metadata and respect per-post indexability", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    await prisma.platformMetadata.upsert({
      where: { id: "default" },
      update: {
        seoTitle: "同频社区",
        seoDescription: "社区平台默认描述",
        seoKeywords: ["社区", "同频"],
        geoKeywords: ["中国", "华语"],
      },
      create: {
        id: "default",
        seoTitle: "同频社区",
        seoDescription: "社区平台默认描述",
        seoKeywords: ["社区", "同频"],
        geoKeywords: ["中国", "华语"],
      },
    });
    const author = await createUser(prisma, "社区作者 SEO");
    const publicPost = await prisma.communityPost.create({
      data: {
        authorId: author.id,
        body: "管理员精选圈子帖子内容",
        topics: ["精选", "社区"],
        status: "published",
        publishedAt: new Date(),
        seoTitle: "管理员精选标题",
        seoDescription: "管理员精选描述",
        seoKeywords: ["精选SEO"],
        geoKeywords: ["北京"],
        searchIndexable: true,
      },
    });
    const normalPost = await prisma.communityPost.create({
      data: {
        authorId: author.id,
        body: "普通公开圈子帖子内容",
        topics: ["普通", "社区"],
        status: "published",
        publishedAt: new Date(),
        searchIndexable: false,
      },
    });

    const listPage = await app.inject({ method: "GET", url: "/community" });
    assert.equal(listPage.statusCode, 200, listPage.body);
    assert.match(listPage.body, /<link rel="canonical" href="https:\/\/samewave\.cc\/community">/);
    assert.match(listPage.body, /index,follow/);

    const indexedDetail = await app.inject({ method: "GET", url: `/community/${encodeURIComponent(publicPost.id)}` });
    assert.equal(indexedDetail.statusCode, 200, indexedDetail.body);
    assert.match(indexedDetail.body, /管理员精选标题/);
    assert.match(indexedDetail.body, /<meta name="robots" content="index,follow">/);
    assert.match(indexedDetail.body, /"@type":"SocialMediaPosting"/);

    const noindexDetail = await app.inject({ method: "GET", url: `/community/${encodeURIComponent(normalPost.id)}` });
    assert.equal(noindexDetail.statusCode, 200, noindexDetail.body);
    assert.match(noindexDetail.body, /<meta name="robots" content="noindex,follow">/);
  } finally {
    await app.close();
  }
});
