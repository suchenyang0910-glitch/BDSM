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
  TEST_KNOWN_IDS,
} from "./_testHarness.js";

function cookieFromResponse(res: { headers: Record<string, unknown> }): string {
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

async function createTrustedUser(prisma: any, displayName: string) {
  return prisma.user.create({
    data: {
      displayName,
      status: "active",
      telegramUserId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 100000)),
    },
  });
}

async function createEstablishedTelegramUser(prisma: any, displayName: string) {
  const user = await createTrustedUser(prisma, displayName);
  await prisma.interactionComment.create({
    data: {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      userId: user.id,
      body: `${displayName} 已有通过评论`,
      status: "approved",
    },
  });
  return user;
}

async function createUser(prisma: any, displayName: string) {
  return prisma.user.create({
    data: {
      displayName,
      status: "active",
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

async function createPublishedArticle(prisma: any, title: string) {
  return prisma.article.create({
    data: {
      slug: `interaction-article-${randomUUID().slice(0, 8)}`,
      title,
      summary: `${title} 摘要内容足够长，可以参与互动。`,
      bodyMarkdown: `${title} 正文`,
      bodyHtml: `<p>${title} 正文至少二十个可读字符，用于互动测试。</p>`,
      status: "published",
      publishedAt: new Date(),
    },
  });
}

async function createComment(app: any, cookieHeader: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/interactions/comments",
    headers: { cookie: cookieHeader, "Content-Type": "application/json" },
    payload,
  });
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("interaction APIs support approved content/article comments, stable cursor pagination, and duplicate report protection", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const user = await createEstablishedTelegramUser(prisma, "互动用户 A");
    const article = await createPublishedArticle(prisma, "互动已发布文章");
    const userCookie = await loginUser(app, user.id);

    const firstCommentResp = await createComment(app, userCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      body: "第一条公开视频评论",
    });
    assert.equal(firstCommentResp.statusCode, 201, firstCommentResp.body);
    const firstComment = (firstCommentResp.json() as any).comment;
    assert.equal(firstComment.status, "approved");

    const replyResp = await createComment(app, userCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      parentId: firstComment.id,
      body: "这是对首条评论的回复",
    });
    assert.equal(replyResp.statusCode, 201, replyResp.body);

    const articleCommentResp = await createComment(app, userCookie, {
      targetType: "article",
      targetId: article.id,
      body: "文章评论也应该走同一套底座",
    });
    assert.equal(articleCommentResp.statusCode, 201, articleCommentResp.body);

    for (const body of ["第二条评论", "第三条评论", "第四条评论"]) {
      const resp = await createComment(app, userCookie, {
        targetType: "video_content",
        targetId: TEST_KNOWN_IDS.contentPublic,
        body,
      });
      assert.equal(resp.statusCode, 201, resp.body);
    }

    const page1 = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(TEST_KNOWN_IDS.contentPublic)}&sort=new&pageSize=2`,
      headers: { cookie: userCookie },
    });
    assert.equal(page1.statusCode, 200, page1.body);
    const page1Body = page1.json() as any;
    assert.equal(page1Body.items.length, 2);
    assert.ok(page1Body.nextCursor);
    assert.equal(page1Body.pageSize, 2);

    const page2 = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(TEST_KNOWN_IDS.contentPublic)}&sort=new&pageSize=2&cursor=${encodeURIComponent(page1Body.nextCursor)}`,
      headers: { cookie: userCookie },
    });
    assert.equal(page2.statusCode, 200, page2.body);
    const page2Body = page2.json() as any;
    assert.equal(page2Body.items.length, 2);
    assert.notEqual(page1Body.items[0].id, page2Body.items[0].id);

    const invalidCursor = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(TEST_KNOWN_IDS.contentPublic)}&cursor=broken`,
      headers: { cookie: userCookie },
    });
    assert.equal(invalidCursor.statusCode, 400, invalidCursor.body);

    const likeTarget = await app.inject({
      method: "POST",
      url: "/api/interactions/likes/toggle",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { targetType: "video_content", targetId: TEST_KNOWN_IDS.contentPublic, subjectKind: "target" },
    });
    assert.equal(likeTarget.statusCode, 200, likeTarget.body);

    const likeComment = await app.inject({
      method: "POST",
      url: "/api/interactions/likes/toggle",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { targetType: "video_content", targetId: TEST_KNOWN_IDS.contentPublic, subjectKind: "comment", commentId: firstComment.id },
    });
    assert.equal(likeComment.statusCode, 200, likeComment.body);
    assert.equal((likeComment.json() as any).likeCount, 1);

    const summary = await app.inject({
      method: "GET",
      url: `/api/interactions/summary?targetType=video_content&targetId=${encodeURIComponent(TEST_KNOWN_IDS.contentPublic)}`,
      headers: { cookie: userCookie },
    });
    assert.equal(summary.statusCode, 200, summary.body);
    const summaryBody = summary.json() as any;
    assert.equal(summaryBody.summary.likedByMe, true);
    assert.ok(summaryBody.summary.commentCount >= 5);

    const reportResp = await app.inject({
      method: "POST",
      url: "/api/interactions/reports",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: {
        targetType: "video_content",
        targetId: TEST_KNOWN_IDS.contentPublic,
        commentId: firstComment.id,
        reasonCode: "spam",
      },
    });
    assert.equal(reportResp.statusCode, 201, reportResp.body);

    const duplicateReport = await app.inject({
      method: "POST",
      url: "/api/interactions/reports",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: {
        targetType: "video_content",
        targetId: TEST_KNOWN_IDS.contentPublic,
        commentId: firstComment.id,
        reasonCode: "spam",
      },
    });
    assert.equal(duplicateReport.statusCode, 409, duplicateReport.body);
  } finally {
    await app.close();
  }
});

test("pending comments stay invisible until moderation approves them, and overly long comments are rejected", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const untrustedUser = await createUser(prisma, "互动用户 Pending");
    const userCookie = await loginUser(app, untrustedUser.id);

    const tooLong = await createComment(app, userCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentMembership,
      body: "长".repeat(501),
    });
    assert.equal(tooLong.statusCode, 400, tooLong.body);

    const pendingResp = await createComment(app, userCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentMembership,
      body: "这是一条需要审核的评论",
    });
    assert.equal(pendingResp.statusCode, 201, pendingResp.body);
    const pendingComment = (pendingResp.json() as any).comment;
    assert.equal(pendingComment.status, "pending");

    const publicListBefore = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(TEST_KNOWN_IDS.contentMembership)}`,
      headers: { cookie: userCookie },
    });
    assert.equal(publicListBefore.statusCode, 200, publicListBefore.body);
    assert.equal((publicListBefore.json() as any).items.length, 0);

    const adminCookie = await loginAdmin(app, "customer_service");
    const approveResp = await app.inject({
      method: "POST",
      url: `/api/admin/interactions/comments/${pendingComment.id}/moderate`,
      headers: { cookie: adminCookie, "Content-Type": "application/json" },
      payload: {
        status: "approved",
        reason: "人工审核通过",
      },
    });
    assert.equal(approveResp.statusCode, 200, approveResp.body);

    const publicListAfter = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(TEST_KNOWN_IDS.contentMembership)}`,
      headers: { cookie: userCookie },
    });
    assert.equal(publicListAfter.statusCode, 200, publicListAfter.body);
    const publicListAfterBody = publicListAfter.json() as any;
    assert.equal(publicListAfterBody.items.length, 1);
    assert.equal(publicListAfterBody.items[0].id, pendingComment.id);
  } finally {
    await app.close();
  }
});

test("third-level replies are rejected, deleting comments is soft-delete, and counters stay consistent", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const user = await createEstablishedTelegramUser(prisma, "互动用户 Delete");
    const otherUser = await createEstablishedTelegramUser(prisma, "互动用户 Other");
    const userCookie = await loginUser(app, user.id);
    const otherCookie = await loginUser(app, otherUser.id);

    const rootResp = await createComment(app, userCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      body: "根评论",
    });
    const rootComment = (rootResp.json() as any).comment;

    const childResp = await createComment(app, userCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      parentId: rootComment.id,
      body: "二级回复",
    });
    assert.equal(childResp.statusCode, 201, childResp.body);
    const childComment = (childResp.json() as any).comment;

    const thirdLevelResp = await createComment(app, otherCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      parentId: childComment.id,
      body: "三级回复不应该成功",
    });
    assert.equal(thirdLevelResp.statusCode, 409, thirdLevelResp.body);

    const deleteReply = await app.inject({
      method: "DELETE",
      url: `/api/interactions/comments/${childComment.id}`,
      headers: { cookie: userCookie },
    });
    assert.equal(deleteReply.statusCode, 200, deleteReply.body);

    const rootAfterReplyDelete = await prisma.interactionComment.findUnique({ where: { id: rootComment.id } });
    const replyAfterDelete = await prisma.interactionComment.findUnique({ where: { id: childComment.id } });
    assert.equal(rootAfterReplyDelete?.replyCount, 0);
    assert.equal(replyAfterDelete?.status, "deleted");
    assert.ok(replyAfterDelete?.deletedAt);

    const deleteRoot = await app.inject({
      method: "DELETE",
      url: `/api/interactions/comments/${rootComment.id}`,
      headers: { cookie: userCookie },
    });
    assert.equal(deleteRoot.statusCode, 200, deleteRoot.body);

    const publicList = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(TEST_KNOWN_IDS.contentPublic)}&sort=new&pageSize=10`,
      headers: { cookie: userCookie },
    });
    assert.equal(publicList.statusCode, 200, publicList.body);
    assert.ok(!(publicList.json() as any).items.some((item: any) => item.id === rootComment.id));
  } finally {
    await app.close();
  }
});

test("concurrent likes and duplicate reports stay deduplicated under race conditions", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const likerA = await createEstablishedTelegramUser(prisma, "并发点赞 A");
    const likerB = await createEstablishedTelegramUser(prisma, "并发点赞 B");
    const reporter = await createEstablishedTelegramUser(prisma, "并发举报用户");
    const owner = await createEstablishedTelegramUser(prisma, "被互动作者");
    const ownerCookie = await loginUser(app, owner.id);
    const likeCookieA = await loginUser(app, likerA.id);
    const likeCookieB = await loginUser(app, likerB.id);
    const reportCookie = await loginUser(app, reporter.id);

    const commentResp = await createComment(app, ownerCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      body: "并发测试评论",
    });
    assert.equal(commentResp.statusCode, 201, commentResp.body);
    const comment = (commentResp.json() as any).comment;

    const likePayload = {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      subjectKind: "comment",
      commentId: comment.id,
    };
    const [likeA, likeB] = await Promise.all([
      app.inject({ method: "POST", url: "/api/interactions/likes/toggle", headers: { cookie: likeCookieA, "Content-Type": "application/json" }, payload: likePayload }),
      app.inject({ method: "POST", url: "/api/interactions/likes/toggle", headers: { cookie: likeCookieB, "Content-Type": "application/json" }, payload: likePayload }),
    ]);
    assert.equal(likeA.statusCode, 200, likeA.body);
    assert.equal(likeB.statusCode, 200, likeB.body);
    const commentAfterLikes = await prisma.interactionComment.findUnique({ where: { id: comment.id } });
    assert.equal(commentAfterLikes?.likeCount, 2);

    const reportPayload = {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      commentId: comment.id,
      reasonCode: "abuse",
      detailText: "并发举报",
    };
    const [report1, report2] = await Promise.all([
      app.inject({ method: "POST", url: "/api/interactions/reports", headers: { cookie: reportCookie, "Content-Type": "application/json" }, payload: reportPayload }),
      app.inject({ method: "POST", url: "/api/interactions/reports", headers: { cookie: reportCookie, "Content-Type": "application/json" }, payload: reportPayload }),
    ]);
    const statuses = [report1.statusCode, report2.statusCode].sort();
    assert.deepEqual(statuses, [201, 409]);
    const reportCount = await prisma.interactionReport.count({
      where: {
        reporterUserId: reporter.id,
        commentId: comment.id,
        status: { in: ["open", "reviewing"] },
      },
    });
    assert.equal(reportCount, 1);
  } finally {
    await app.close();
  }
});

test("admin permissions block overreach, and E1 target-level reports cannot be actioned without comment moderation", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const user = await createEstablishedTelegramUser(prisma, "互动用户 Admin");
    const userCookie = await loginUser(app, user.id);

    const commentResp = await createComment(app, userCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentMembership,
      body: "等待后台处理的评论",
    });
    assert.equal(commentResp.statusCode, 201, commentResp.body);
    const comment = (commentResp.json() as any).comment;

    const commentReport = await app.inject({
      method: "POST",
      url: "/api/interactions/reports",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: {
        targetType: "video_content",
        targetId: TEST_KNOWN_IDS.contentMembership,
        commentId: comment.id,
        reasonCode: "abuse",
      },
    });
    assert.equal(commentReport.statusCode, 201, commentReport.body);
    const commentReportId = (commentReport.json() as any).report.id;

    const targetReport = await app.inject({
      method: "POST",
      url: "/api/interactions/reports",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: {
        targetType: "video_content",
        targetId: TEST_KNOWN_IDS.contentMembership,
        reasonCode: "illegal",
        detailText: "目标级举报",
      },
    });
    assert.equal(targetReport.statusCode, 201, targetReport.body);
    const targetReportId = (targetReport.json() as any).report.id;

    const auditorCookie = await loginAdmin(app, "auditor");
    const forbiddenReview = await app.inject({
      method: "POST",
      url: `/api/admin/interactions/reports/${commentReportId}/review`,
      headers: { cookie: auditorCookie, "Content-Type": "application/json" },
      payload: {
        status: "actioned",
        commentStatus: "hidden",
      },
    });
    assert.equal(forbiddenReview.statusCode, 403, forbiddenReview.body);

    const csCookie = await loginAdmin(app, "customer_service");
    const targetActioned = await app.inject({
      method: "POST",
      url: `/api/admin/interactions/reports/${targetReportId}/review`,
      headers: { cookie: csCookie, "Content-Type": "application/json" },
      payload: {
        status: "actioned",
        resolutionNote: "不能只改举报状态",
      },
    });
    assert.equal(targetActioned.statusCode, 409, targetActioned.body);

    const reviewComment = await app.inject({
      method: "POST",
      url: `/api/admin/interactions/reports/${commentReportId}/review`,
      headers: { cookie: csCookie, "Content-Type": "application/json" },
      payload: {
        status: "actioned",
        resolutionNote: "已隐藏违规评论",
        commentStatus: "hidden",
        commentReason: "辱骂",
      },
    });
    assert.equal(reviewComment.statusCode, 200, reviewComment.body);

    const publicList = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(TEST_KNOWN_IDS.contentMembership)}`,
      headers: { cookie: userCookie },
    });
    assert.equal(publicList.statusCode, 200, publicList.body);
    assert.ok(!(publicList.json() as any).items.some((item: any) => item.id === comment.id));
  } finally {
    await app.close();
  }
});

test("pending comments appear in admin moderation queue before any report", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const telegramUser = await createTrustedUser(prisma, "Telegram 首评用户");
    const userCookie = await loginUser(app, telegramUser.id);

    const firstCommentResp = await createComment(app, userCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentMembership,
      body: "Telegram 首条评论也必须先待审核",
    });
    assert.equal(firstCommentResp.statusCode, 201, firstCommentResp.body);
    const firstComment = (firstCommentResp.json() as any).comment;
    assert.equal(firstComment.status, "pending");

    const adminCookie = await loginAdmin(app, "customer_service");
    const queueResp = await app.inject({
      method: "GET",
      url: "/api/admin/interactions/comments?status=pending&page=1&pageSize=20",
      headers: { cookie: adminCookie },
    });
    assert.equal(queueResp.statusCode, 200, queueResp.body);
    const queueBody = queueResp.json() as any;
    assert.ok(queueBody.items.some((item: any) => item.id === firstComment.id));
  } finally {
    await app.close();
  }
});

test("cursor pagination loads comments beyond the first 80 rows", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const user = await createEstablishedTelegramUser(prisma, "Cursor Bulk User");
    const userCookie = await loginUser(app, user.id);
    const article = await createPublishedArticle(prisma, "长评论分页文章");
    for (let index = 1; index <= 85; index += 1) {
      await prisma.interactionComment.create({
        data: {
          targetType: "article",
          targetId: article.id,
          userId: user.id,
          body: `bulk-${String(index).padStart(3, "0")}`,
          status: "approved",
          createdAt: new Date(Date.now() + index),
        },
      });
    }

    const page1 = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=article&targetId=${encodeURIComponent(article.id)}&sort=new&pageSize=30`,
      headers: { cookie: userCookie },
    });
    const body1 = page1.json() as any;
    assert.equal(page1.statusCode, 200, page1.body);
    assert.equal(body1.items.length, 30);
    assert.ok(body1.nextCursor);

    const page2 = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=article&targetId=${encodeURIComponent(article.id)}&sort=new&pageSize=30&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: { cookie: userCookie },
    });
    const body2 = page2.json() as any;
    assert.equal(page2.statusCode, 200, page2.body);
    assert.equal(body2.items.length, 30);
    assert.ok(body2.nextCursor);

    const page3 = await app.inject({
      method: "GET",
      url: `/api/interactions/comments?targetType=article&targetId=${encodeURIComponent(article.id)}&sort=new&pageSize=30&cursor=${encodeURIComponent(body2.nextCursor)}`,
      headers: { cookie: userCookie },
    });
    const body3 = page3.json() as any;
    assert.equal(page3.statusCode, 200, page3.body);
    assert.equal(body3.items.length, 25);
    assert.ok(body3.items.some((item: any) => item.body === "bulk-001"));
  } finally {
    await app.close();
  }
});

test("rapid second like click cancels immediately", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const user = await createEstablishedTelegramUser(prisma, "Rapid Toggle User");
    const userCookie = await loginUser(app, user.id);
    const createResp = await createComment(app, userCookie, {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      body: "快速点赞切换评论",
    });
    assert.equal(createResp.statusCode, 201, createResp.body);
    const comment = (createResp.json() as any).comment;

    const payload = {
      targetType: "video_content",
      targetId: TEST_KNOWN_IDS.contentPublic,
      subjectKind: "comment",
      commentId: comment.id,
    };
    const likedResp = await app.inject({
      method: "POST",
      url: "/api/interactions/likes/toggle",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload,
    });
    assert.equal(likedResp.statusCode, 200, likedResp.body);
    assert.equal((likedResp.json() as any).liked, true);

    const unlikedResp = await app.inject({
      method: "POST",
      url: "/api/interactions/likes/toggle",
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload,
    });
    assert.equal(unlikedResp.statusCode, 200, unlikedResp.body);
    assert.equal((unlikedResp.json() as any).liked, false);
    assert.equal((unlikedResp.json() as any).likeCount, 0);
  } finally {
    await app.close();
  }
});
