import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import interactionRoutes from "../src/routes/interactions.js";
import adminInteractionRoutes from "../src/routes/adminInteractions.js";
import {
  setupTestHarness,
  teardownTestHarness,
  seedTestData,
} from "./_testHarness.js";

process.env.COMMUNITY_ENABLED = "true";
process.env.COMMUNITY_POSTING_ENABLED = "true";
process.env.COMMUNITY_VIDEO_UPLOAD_ENABLED = "true";

function cookieFromResponse(res: { headers: Record<string, unknown> }) {
  const setCookie = res.headers["set-cookie"];
  const cookies: string[] = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  return cookies.map((item) => item.split(";")[0]).join("; ");
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
    const sess = req.session as any;
    sess.userId = (req.params as any).id;
    sess.telegramUserId = null;
    return { ok: true };
  });
  app.post("/__test/login-admin/:role", async (req) => {
    const role = (req.params as any).role as string;
    const admin = await prisma.adminUser.findFirst({ where: { role }, select: { id: true, email: true, role: true } });
    if (!admin) throw new Error(`missing admin for role ${role}`);
    (req.session as any).admin = { adminId: admin.id, email: admin.email, role: admin.role };
    return { ok: true };
  });
  await app.register(interactionRoutes, { prefix: "/api" });
  await app.register(adminInteractionRoutes, { prefix: "/api" });
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

async function loginAdmin(app: any, role: string) {
  const login = await app.inject({ method: "POST", url: `/__test/login-admin/${role}` });
  return cookieFromResponse(login);
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("community post admin queue exposes safe media summaries, supports publish pin report and audit flows", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const author = await createUser(prisma, "圈子作者 A");
    const reporter = await createUser(prisma, "举报人 A");
    const adminCookie = await loginAdmin(app, "customer_service");

    const post = await prisma.communityPost.create({
      data: {
        id: `community-post-${randomUUID().slice(0, 8)}`,
        authorId: author.id,
        body: "一条等待审核的圈子帖子，带有图片媒体摘要。",
        topics: ["调教", "安全"],
        status: "pending",
        mediaCount: 1,
      },
    });
    const imageAssetId = `community-asset-${randomUUID().slice(0, 8)}`;
    await prisma.communityPostAsset.create({
      data: {
        id: imageAssetId,
        postId: post.id,
        ordinal: 0,
        kind: "image",
        objectKey: `community/posts/${post.id}/images/${imageAssetId}/original.webp`,
        moderationStatus: "approved",
        transcodeStatus: "ready",
        width: 1080,
        height: 1440,
      },
    });
    await prisma.interactionReport.create({
      data: {
        targetType: "circle_post",
        targetId: post.id,
        reporterUserId: reporter.id,
        reasonCode: "spam",
      },
    });
    await prisma.communityPost.update({
      where: { id: post.id },
      data: { reportCount: 1 },
    });

    const listResp = await app.inject({
      method: "GET",
      url: "/api/admin/community/posts?status=pending",
      headers: { cookie: adminCookie },
    });
    assert.equal(listResp.statusCode, 200, listResp.body);
    const listBody = listResp.json() as any;
    const row = (listBody.items || []).find((item: any) => item.id === post.id);
    assert.ok(row, "community post should be visible in admin queue");
    assert.equal(row.status, "pending");
    assert.equal(row.reportCount, 1);
    assert.equal(Array.isArray(row.assets), true);
    assert.equal(Object.hasOwn(row.assets[0], "objectKey"), false, "admin queue must not expose community source object keys");
    assert.equal(Object.hasOwn(row.assets[0], "originalAssetId"), false, "admin queue must not expose original asset IDs");

    const publishResp = await app.inject({
      method: "POST",
      url: `/api/admin/community/posts/${encodeURIComponent(post.id)}/moderate`,
      headers: { cookie: adminCookie, "Content-Type": "application/json" },
      payload: { status: "published", reason: "E2 圈子帖子审核通过" },
    });
    assert.equal(publishResp.statusCode, 200, publishResp.body);

    const pinResp = await app.inject({
      method: "POST",
      url: `/api/admin/community/posts/${encodeURIComponent(post.id)}/pin`,
      headers: { cookie: adminCookie, "Content-Type": "application/json" },
      payload: { pinned: true, reason: "测试置顶" },
    });
    assert.equal(pinResp.statusCode, 200, pinResp.body);

    const reportListResp = await app.inject({
      method: "GET",
      url: `/api/admin/interactions/reports?targetType=circle_post&targetId=${encodeURIComponent(post.id)}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(reportListResp.statusCode, 200, reportListResp.body);
    assert.equal((reportListResp.json() as any).items.length, 1);

    const auditResp = await app.inject({
      method: "GET",
      url: `/api/admin/community/posts/${encodeURIComponent(post.id)}/audit-logs`,
      headers: { cookie: adminCookie },
    });
    assert.equal(auditResp.statusCode, 200, auditResp.body);
    const auditActions = ((auditResp.json() as any).items || []).map((item: any) => item.action);
    assert.ok(auditActions.includes("community.post.moderate"));
    assert.ok(auditActions.includes("community.post.pin"));
  } finally {
    await app.close();
  }
});

test("community post publish rejects invalid video storage prefix or queue and hidden posts hide comments from user side", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const author = await createUser(prisma, "圈子作者 B");
    const commenter = await createUser(prisma, "评论用户 B");
    const adminCookie = await loginAdmin(app, "customer_service");
    const userCookie = await loginUser(app, commenter.id);

    const invalidPost = await prisma.communityPost.create({
      data: {
        id: `community-invalid-${randomUUID().slice(0, 8)}`,
        authorId: author.id,
        body: "带视频的圈子帖子，故意使用错误前缀。",
        topics: ["短视频"],
        status: "pending",
        mediaCount: 1,
      },
    });
    await prisma.communityPostAsset.create({
      data: {
        id: `community-video-${randomUUID().slice(0, 8)}`,
        postId: invalidPost.id,
        ordinal: 0,
        kind: "video",
        objectKey: `contents/${invalidPost.id}/source.mp4`,
        moderationStatus: "approved",
        transcodeStatus: "ready",
        transcodeQueueName: "vod_transcode",
        playbackQuotaBucket: "vod_video",
      },
    });
    const blockedPublish = await app.inject({
      method: "POST",
      url: `/api/admin/community/posts/${encodeURIComponent(invalidPost.id)}/moderate`,
      headers: { cookie: adminCookie, "Content-Type": "application/json" },
      payload: { status: "published", reason: "不应通过" },
    });
    assert.equal(blockedPublish.statusCode, 409, blockedPublish.body);
    assert.equal((blockedPublish.json() as any).error, "community_asset_prefix_invalid");

    const visiblePost = await prisma.communityPost.create({
      data: {
        id: `community-visible-${randomUUID().slice(0, 8)}`,
        authorId: author.id,
        body: "一条已发布的圈子帖子，用于验证隐藏后评论同步失效。",
        topics: ["互动"],
        status: "published",
        publishedAt: new Date(),
      },
    });
    const comment = await prisma.interactionComment.create({
      data: {
        targetType: "circle_post",
        targetId: visiblePost.id,
        userId: commenter.id,
        body: "圈子评论应先可见，隐藏帖子后不可见。",
        status: "approved",
      },
    });
    await prisma.communityPost.update({
      where: { id: visiblePost.id },
      data: { commentCount: 1 },
    });

    const beforeHide = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=circle_post&targetId=${encodeURIComponent(visiblePost.id)}&sort=new&pageSize=10`,
      headers: { cookie: userCookie },
    });
    assert.equal(beforeHide.statusCode, 200, beforeHide.body);
    assert.equal((beforeHide.json() as any).items[0].id, comment.id);

    const hideResp = await app.inject({
      method: "POST",
      url: `/api/admin/community/posts/${encodeURIComponent(visiblePost.id)}/moderate`,
      headers: { cookie: adminCookie, "Content-Type": "application/json" },
      payload: { status: "hidden", reason: "帖子隐藏后评论要同步消失" },
    });
    assert.equal(hideResp.statusCode, 200, hideResp.body);

    const afterHide = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=circle_post&targetId=${encodeURIComponent(visiblePost.id)}&sort=new&pageSize=10`,
      headers: { cookie: userCookie },
    });
    assert.equal(afterHide.statusCode, 404, afterHide.body);

    const restoreResp = await app.inject({
      method: "POST",
      url: `/api/admin/community/posts/${encodeURIComponent(visiblePost.id)}/moderate`,
      headers: { cookie: adminCookie, "Content-Type": "application/json" },
      payload: { status: "published", reason: "恢复已发布状态" },
    });
    assert.equal(restoreResp.statusCode, 200, restoreResp.body);

    const afterRestore = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=circle_post&targetId=${encodeURIComponent(visiblePost.id)}&sort=new&pageSize=10`,
      headers: { cookie: userCookie },
    });
    assert.equal(afterRestore.statusCode, 200, afterRestore.body);
    assert.equal((afterRestore.json() as any).items.length, 1);
  } finally {
    await app.close();
  }
});

test("community admin routes stay available when COMMUNITY_ENABLED=false", { concurrency: false }, async () => {
  const previous = {
    enabled: process.env.COMMUNITY_ENABLED,
    posting: process.env.COMMUNITY_POSTING_ENABLED,
    video: process.env.COMMUNITY_VIDEO_UPLOAD_ENABLED,
  };
  process.env.COMMUNITY_ENABLED = "false";
  process.env.COMMUNITY_POSTING_ENABLED = "false";
  process.env.COMMUNITY_VIDEO_UPLOAD_ENABLED = "false";
  const app = await createApp(prisma);
  try {
    const adminCookie = await loginAdmin(app, "customer_service");

    const queueResp = await app.inject({
      method: "GET",
      url: "/api/admin/community/posts?status=pending",
      headers: { cookie: adminCookie },
    });
    assert.equal(queueResp.statusCode, 200, queueResp.body);

    const auditResp = await app.inject({
      method: "GET",
      url: `/api/admin/community/posts/${encodeURIComponent("missing-post")}/audit-logs`,
      headers: { cookie: adminCookie },
    });
    assert.equal(auditResp.statusCode, 200, auditResp.body);

    const commentResp = await app.inject({
      method: "GET",
      url: `/api/admin/interactions/comments?targetType=circle_post&targetId=${encodeURIComponent("missing-post")}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(commentResp.statusCode, 200, commentResp.body);

    const reportResp = await app.inject({
      method: "GET",
      url: `/api/admin/interactions/reports?targetType=circle_post&targetId=${encodeURIComponent("missing-post")}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(reportResp.statusCode, 200, reportResp.body);

    const moderateResp = await app.inject({
      method: "POST",
      url: `/api/admin/community/posts/${encodeURIComponent("missing-post")}/moderate`,
      headers: { cookie: adminCookie, "Content-Type": "application/json" },
      payload: { status: "hidden", reason: "route should stay registered" },
    });
    assert.equal(moderateResp.statusCode, 404, moderateResp.body);
    assert.equal((moderateResp.json() as any).error, "community_post_not_found");

    const pinResp = await app.inject({
      method: "POST",
      url: `/api/admin/community/posts/${encodeURIComponent("missing-post")}/pin`,
      headers: { cookie: adminCookie, "Content-Type": "application/json" },
      payload: { pinned: true, reason: "route should stay registered" },
    });
    assert.equal(pinResp.statusCode, 404, pinResp.body);
    assert.equal((pinResp.json() as any).error, "community_post_not_found");
  } finally {
    process.env.COMMUNITY_ENABLED = previous.enabled || "true";
    process.env.COMMUNITY_POSTING_ENABLED = previous.posting || "true";
    process.env.COMMUNITY_VIDEO_UPLOAD_ENABLED = previous.video || "true";
    await app.close();
  }
});
