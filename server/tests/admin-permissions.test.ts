import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import adminRoutes from "../src/routes/admin.js";
import contentRoutes from "../src/routes/contents.js";
import homeRoutes from "../src/routes/home.js";
import resourceRoutes from "../src/routes/resources.js";
import orderRoutes from "../src/routes/orders.js";
import adminCmsRoutes, { adminPackageRoutes } from "../src/routes/adminCms.js";
import adminUsersAndSupportRoutes from "../src/routes/adminUsersAndSupport.js";
import adminChannelsRoutes from "../src/routes/adminChannels.js";
import telegramWebhookRoutes from "../src/routes/telegramWebhook.js";
import { encryptChatIdAesGcm, chatIdIndexKey } from "../src/utils/crypto.js";
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
  await app.register(session, { secret: "test-session-secret-is-at-least-thirty-two-characters", cookie: { secure: false } });
  app.decorate("prisma", prisma);
  app.decorateRequest("userId", null);
  app.decorateRequest("telegramUserId", null);
  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(homeRoutes, { prefix: "/api" });
  await app.register(contentRoutes, { prefix: "/api" });
  await app.register(resourceRoutes, { prefix: "/api" });
  await app.register(orderRoutes, { prefix: "/api" });
  await app.register(adminCmsRoutes, { prefix: "/api" });
  await app.register(adminPackageRoutes, { prefix: "/api" });
  await app.register(adminUsersAndSupportRoutes, { prefix: "/api" });
  await app.register(adminChannelsRoutes, { prefix: "/api" });
  await app.register(telegramWebhookRoutes, { prefix: "/api" });
  return app;
}

async function loginAdmin(app: any, role: keyof typeof TEST_CREDENTIALS): Promise<string> {
  const c = TEST_CREDENTIALS[role];
  const r = await app.inject({
    method: "POST", url: "/api/admin/login",
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

async function seedReadyMediaAsset(
  prismaClient: any,
  input: { id: string; kind: "cover_image" | "preview_video" | "full_video"; ownerAdminId?: string | null; filename?: string }
) {
  if (input.kind === "full_video") {
    throw new Error("seedReadyMediaAsset no longer supports full_video; use seedReadyVideoAsset");
  }
  return prismaClient.mediaAsset.create({
    data: {
      id: input.id,
      kind: input.kind,
      status: "ready",
      ownerAdminId: input.ownerAdminId ?? null,
      originalFilename: input.filename || `${input.kind}.mp4`,
      mimeType: input.kind === "cover_image" ? "image/jpeg" : "video/mp4",
      contentLength: BigInt(1024),
      storageBucket: "test-bucket",
      storageRegion: "test-region",
      storageKey: `${input.id}.bin`,
      storagePublicUrl: `https://example.com/${input.id}.bin`,
      durationSeconds: input.kind === "cover_image" ? null : 60,
    },
  });
}

async function seedReadyVideoAsset(
  prismaClient: any,
  input: { id: string; contentId: string; filename?: string; kind?: "full_source" | "cover" }
) {
  const kind = input.kind || "full_source";
  return prismaClient.videoAsset.create({
    data: {
      id: input.id,
      contentId: input.contentId,
      kind,
      objectKey: `tests/${input.id}.${kind === "cover" ? "jpg" : "mp4"}`,
      originalFilename: input.filename || (kind === "cover" ? "cover.jpg" : "full-source.mp4"),
      mimeType: kind === "cover" ? "image/jpeg" : "video/mp4",
      byteSize: BigInt(1024),
      sha256: `legacy-test-${input.id}`,
      status: "verified",
      verifiedAt: new Date(),
    },
  });
}

test("越权2：customer_service 直接发放权益 entitlement:grant 必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const tgid = BigInt(8000000000 + (Date.now() % 100_000_000));
    const user = await prisma.user.create({ data: { telegramUserId: tgid, displayName: `CS test ${tgid}` } });

    const csCookie = await loginAdmin(app, "customerService");
    const grantResp = await app.inject({
      method: "POST", url: "/api/admin/_internal_/entitlements/_grant",
      headers: { cookie: csCookie, "Content-Type": "application/json" },
      payload: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: TEST_KNOWN_IDS.membershipProductKey,
        reason: "越权测试：客服无权发权益",
        durationDays: 7,
      },
    });
    assert.ok(grantResp.statusCode === 403 || grantResp.statusCode === 404,
      `CS grant entitlement must be 403 (or route 404 if removed), got ${grantResp.statusCode}: ${grantResp.body}`);
  } finally {
    await app.close();
  }
});

test("平台 SEO 设置遵循读写权限：operator 可读，auditor 可读，editor 不可写，super_admin 可更新", async () => {
  const app = await createApp(prisma);
  try {
    const opCookie = await loginAdmin(app, "operator");
    const audCookie = await loginAdmin(app, "auditor");
    const editorCookie = await loginAdmin(app, "editor");
    const superCookie = await loginAdmin(app, "superAdmin");

    const opRead = await app.inject({ method: "GET", url: "/api/admin/platform-metadata", headers: { cookie: opCookie } });
    assert.equal(opRead.statusCode, 200, opRead.body);
    assert.equal((opRead.json() as any).seoTitle, "同频平台默认 SEO 标题");

    const audRead = await app.inject({ method: "GET", url: "/api/admin/platform-metadata", headers: { cookie: audCookie } });
    assert.equal(audRead.statusCode, 200, audRead.body);

    const editorWrite = await app.inject({
      method: "PUT",
      url: "/api/admin/platform-metadata",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { seoTitle: "editor should fail" },
    });
    assert.equal(editorWrite.statusCode, 403, editorWrite.body);

    const superWrite = await app.inject({
      method: "PUT",
      url: "/api/admin/platform-metadata",
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        seoTitle: "新的平台 SEO 标题",
        seoDescription: "新的平台 SEO 描述",
        seoKeywords: ["平台词", "平台词", "  搜索词  "],
        geoKeywords: ["主题A", "主题A"],
        reason: "测试更新平台 SEO",
      },
    });
    assert.equal(superWrite.statusCode, 200, superWrite.body);
    const updated = (superWrite.json() as any).platformMetadata;
    assert.deepEqual(updated.seoKeywords, ["平台词", "搜索词"]);
    assert.deepEqual(updated.geoKeywords, ["主题A"]);

    const pastedKeywords = await app.inject({
      method: "PUT",
      url: "/api/admin/platform-metadata",
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        seoKeywords: "trueanal, true anal, adult video, anal scene",
        geoKeywords: "adult video；relationship topic\nanswer engine",
        reason: "验证逗号粘贴词组保留规则",
      },
    });
    assert.equal(pastedKeywords.statusCode, 200, pastedKeywords.body);
    const pastedMetadata = (pastedKeywords.json() as any).platformMetadata;
    assert.deepEqual(
      pastedMetadata.seoKeywords,
      ["trueanal", "true anal", "adult video", "anal scene"],
      "SEO 关键词必须保留词组空格，trueanal 与 true anal 不能误合并",
    );
    assert.deepEqual(pastedMetadata.geoKeywords, ["adult video", "relationship topic", "answer engine"]);

    const rejectedTooMany = await app.inject({
      method: "PUT",
      url: "/api/admin/platform-metadata",
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        seoKeywords: Array.from({ length: 21 }, (_, index) => `关键词${index + 1}`),
        reason: "验证 SEO 超过 20 项时必须报错",
      },
    });
    assert.equal(rejectedTooMany.statusCode, 400, rejectedTooMany.body);
    const rejectedTooManyBody = rejectedTooMany.json() as any;
    assert.equal(rejectedTooManyBody.error, "validation_error");
    assert.equal(rejectedTooManyBody.details?.[0]?.field, "seoKeywords");
    assert.match(String(rejectedTooManyBody.details?.[0]?.issues?.[0]?.message || ""), /20 项/);

    const rejectedTooLong = await app.inject({
      method: "PUT",
      url: "/api/admin/platform-metadata",
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        seoKeywords: ["a".repeat(81)],
        reason: "验证 SEO 单词超长时必须报错",
      },
    });
    assert.equal(rejectedTooLong.statusCode, 400, rejectedTooLong.body);
    const rejectedTooLongBody = rejectedTooLong.json() as any;
    assert.equal(rejectedTooLongBody.details?.[0]?.field, "seoKeywords");
    assert.match(String(rejectedTooLongBody.details?.[0]?.issues?.[0]?.message || ""), /80 个字符/);
  } finally {
    await app.close();
  }
});

test("start-telegram-publish 只合并内容标签与手填 Telegram 标签，不自动泄露 SEO/GEO 关键词", async () => {
  const mainKey = "TELEGRAM_FREE_CHANNEL_PREVIEW_MAIN_CHAT_ID";
  const tutorialKey = "TELEGRAM_FREE_CHANNEL_TUTORIAL_BASICS_CHAT_ID";
  const before = [process.env[mainKey], process.env[tutorialKey]];
  process.env[mainKey] = "-1000000000001";
  process.env[tutorialKey] = "-1000000000002";
  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const contentId = crypto.randomUUID();

    await prisma.content.create({
      data: {
        id: contentId,
        title: "SEO Telegram 标签测试",
        description: "用于测试标签清洗与隔离",
        accessType: "membership",
        status: "draft",
        tags: ["睡眠"],
        seoKeywords: ["内容关键词", "默认词"],
      },
    });
    const mediaAsset = await seedReadyVideoAsset(prisma, {
      id: crypto.randomUUID(),
      contentId,
      filename: "membership-full.mp4",
    });
    await seedReadyVideoAsset(prisma, {
      id: crypto.randomUUID(), contentId, filename: "membership-cover.jpg", kind: "cover",
    });
    await prisma.content.update({
      where: { id: contentId },
      data: {
        fullVideoAssetId: mediaAsset.id,
        fullVideoSegments: { create: [{ videoAssetId: mediaAsset.id, segmentOrder: 1 }] },
      },
    });

    const startResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${contentId}/start-telegram-publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        channelKinds: ["membership_full"],
        telegramTags: [" #睡眠 ", "夜间", "#夜间", "calm-mode", "默认词"],
        reason: "测试 Telegram 标签规范化",
      },
    });
    assert.equal(startResp.statusCode, 201, startResp.body);
    const startBody = startResp.json() as any;
    assert.deepEqual(
      startBody.normalizedTelegramTags,
      ["#睡眠", "#夜间", "#calmmode", "#默认词"],
      "Telegram 公开标签只能来自内容标签与本次手填标签",
    );

    const jobsResp = await app.inject({
      method: "GET",
      url: `/api/admin/contents/${contentId}/publish-jobs`,
      headers: { cookie: editorCookie },
    });
    assert.equal(jobsResp.statusCode, 200, jobsResp.body);
    const firstJob = (jobsResp.json() as any).items[0];
    assert.deepEqual(firstJob.telegramTags, ["#睡眠", "#夜间", "#calmmode", "#默认词"]);

    await prisma.platformMetadata.upsert({
      where: { id: "default" },
      update: { seoKeywords: ["平台关键词"], geoKeywords: ["平台主题"] },
      create: { id: "default", seoKeywords: ["平台关键词"], geoKeywords: ["平台主题"] },
    });
    const fallbackContentId = crypto.randomUUID();
    await prisma.content.create({
      data: {
        id: fallbackContentId,
        title: "平台关键词回退测试",
        accessType: "membership",
        status: "draft",
        seoKeywords: [],
        geoKeywords: [],
        tags: [],
      },
    });
    const fallbackAsset = await seedReadyVideoAsset(prisma, {
      id: crypto.randomUUID(),
      contentId: fallbackContentId,
      filename: "fallback-membership-full.mp4",
    });
    await seedReadyVideoAsset(prisma, {
      id: crypto.randomUUID(), contentId: fallbackContentId, filename: "fallback-cover.jpg", kind: "cover",
    });
    await prisma.content.update({
      where: { id: fallbackContentId },
      data: {
        fullVideoAssetId: fallbackAsset.id,
        fullVideoSegments: { create: [{ videoAssetId: fallbackAsset.id, segmentOrder: 1 }] },
      },
    });
    const fallbackResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${fallbackContentId}/start-telegram-publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { channelKinds: ["membership_full"], reason: "验证平台关键词回退" },
    });
    assert.equal(fallbackResp.statusCode, 201, fallbackResp.body);
    assert.deepEqual((fallbackResp.json() as any).normalizedTelegramTags, []);

    const dedupeResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${fallbackContentId}/start-telegram-publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        channelKinds: ["membership_full"],
        telegramTags: ["trueanal, true anal, adult video"],
        reason: "验证 Telegram 标签规范化去重",
      },
    });
    assert.equal(dedupeResp.statusCode, 201, dedupeResp.body);
    assert.deepEqual((dedupeResp.json() as any).normalizedTelegramTags, ["#trueanal", "#adultvideo"]);
  } finally {
    await app.close();
    if (before[0] === undefined) delete process.env[mainKey]; else process.env[mainKey] = before[0];
    if (before[1] === undefined) delete process.env[tutorialKey]; else process.env[tutorialKey] = before[1];
  }
});

test("免费频道自动投放封面推广入口，试看仍由 Web HLS 承担", async () => {
  const mainKey = "TELEGRAM_FREE_CHANNEL_PREVIEW_MAIN_CHAT_ID";
  const tutorialKey = "TELEGRAM_FREE_CHANNEL_TUTORIAL_BASICS_CHAT_ID";
  const announcementKey = "TELEGRAM_FREE_CHANNEL_ANNOUNCEMENTS_CHAT_ID";
  const before = [process.env[mainKey], process.env[tutorialKey], process.env[announcementKey]];
  process.env[mainKey] = "-1000000000001";
  process.env[tutorialKey] = "-1000000000002";
  delete process.env[announcementKey];

  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const editor = await prisma.adminUser.findUnique({ where: { email: TEST_CREDENTIALS.editor.email } });
    assert.ok(editor, "editor seed should exist");
    const contentId = crypto.randomUUID();
    await prisma.content.create({
      data: {
        id: contentId,
        title: "试看改走 Web HLS，不再投放 Telegram 免费频道",
        accessType: "public",
        status: "draft",
        freeChannelCode: null,
      },
    });
    const publicFullAsset = await seedReadyVideoAsset(prisma, {
      id: crypto.randomUUID(),
      contentId,
      filename: "public-full.mp4",
    });
    await prisma.content.update({
      where: { id: contentId },
      data: {
        fullVideoAssetId: publicFullAsset.id,
        fullVideoSegments: { create: [{ videoAssetId: publicFullAsset.id, segmentOrder: 1 }] },
      },
    });
    await seedReadyVideoAsset(prisma, {
      id: crypto.randomUUID(), contentId, filename: "public-cover.jpg", kind: "cover",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${contentId}/start-telegram-publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { channelKinds: ["public_free_preview"], reason: "验证免费频道推广入口" },
    });
    assert.equal(response.statusCode, 201, response.body);
    const publicJobs = (response.json() as any).jobs;
    assert.equal(publicJobs.length, 2, "应向全部两个免费频道各创建一条封面推广任务");
    assert.ok(publicJobs.every((job: any) => job.channelKind === "public_free_preview"));
    assert.ok(publicJobs.every((job: any) => job.videoAssetId));

    const membershipContentId = crypto.randomUUID();
    await prisma.content.create({
      data: {
        id: membershipContentId,
        title: "会员内容只投放完整交付，试看改走 Web HLS",
        accessType: "membership",
        status: "draft",
      },
    });
    const fullAsset = await seedReadyVideoAsset(prisma, {
      id: crypto.randomUUID(),
      contentId: membershipContentId,
      filename: "membership-full.mp4",
    });
    await seedReadyVideoAsset(prisma, {
      id: crypto.randomUUID(), contentId: membershipContentId, filename: "membership-cover.jpg", kind: "cover",
    });
    await prisma.content.update({
      where: { id: membershipContentId },
      data: {
        fullVideoAssetId: fullAsset.id,
        fullVideoSegments: { create: [{ videoAssetId: fullAsset.id, segmentOrder: 1 }] },
      },
    });
    const membershipResponse = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${membershipContentId}/start-telegram-publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { channelKinds: ["membership_full"], reason: "会员视频必须同时进入免费流量入口与私密完整交付" },
    });
    assert.equal(membershipResponse.statusCode, 201, membershipResponse.body);
    const membershipJobs = (membershipResponse.json() as any).jobs;
    assert.equal(membershipJobs.length, 3, "会员内容应创建一个完整交付任务和两个免费流量入口封面推广任务");
    assert.equal(membershipJobs.filter((job: any) => job.channelKind === "membership_full").length, 1);
    assert.equal(membershipJobs.filter((job: any) => job.channelKind === "public_free_preview").length, 2);

    const repeatedMembershipResponse = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${membershipContentId}/start-telegram-publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { channelKinds: ["membership_full"], reason: "重复点击不得重复发片" },
    });
    assert.equal(repeatedMembershipResponse.statusCode, 201, repeatedMembershipResponse.body);
    const repeatedJobs = (repeatedMembershipResponse.json() as any).jobs;
    assert.deepEqual(
      new Set(repeatedJobs.map((job: any) => job.id)),
      new Set(membershipJobs.map((job: any) => job.id)),
      "同一内容重复请求必须复用原任务，而不是再创建一组频道发布任务",
    );
    const storedJobCount = await prisma.telegramPublishJob.count({ where: { contentId: membershipContentId } });
    assert.equal(storedJobCount, 3, "重复请求后数据库只能保留一个私密交付和每个免费入口各一条推广任务");
  } finally {
    await app.close();
    for (const [key, value] of [[mainKey, before[0]], [tutorialKey, before[1]], [announcementKey, before[2]]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("越权3：auditor 不允许发布内容/分类写操作，仅读=200/写=403", async () => {
  const app = await createApp(prisma);
  try {
    const audCookie = await loginAdmin(app, "auditor");

    const listCategories = await app.inject({ method: "GET", url: "/api/admin/categories", headers: { cookie: audCookie } });
    assert.ok(
      listCategories.statusCode === 200 || listCategories.statusCode === 404,
      `auditor reading categories should be 200 (or 404 if not implemented), got ${listCategories.statusCode}`,
    );

    const publishResp = await app.inject({
      method: "POST", url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/publish`,
      headers: { cookie: audCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：审计不允许发布" },
    });
    assert.ok(
      publishResp.statusCode === 403 || publishResp.statusCode === 404,
      `auditor publish content should be 403 (or 404 if not implemented), got ${publishResp.statusCode}: ${publishResp.body}`,
    );
  } finally {
    await app.close();
  }
});

test("分类图标只能绑定已校验完成的上传素材，服务端保存受控公开地址", async () => {
  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const iconAsset = await seedReadyMediaAsset(prisma, {
      id: crypto.randomUUID(),
      kind: "cover_image",
      filename: "category-icon.jpg",
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/categories",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        name: "图标上传分类",
        slug: `icon-upload-${Date.now()}`,
        iconAssetId: iconAsset.id,
        reason: "验证分类图标必须绑定已校验素材",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const categoryId = (created.json() as any).id;
    const categories = await app.inject({ method: "GET", url: "/api/admin/categories", headers: { cookie: editorCookie } });
    assert.equal(categories.statusCode, 200, categories.body);
    const stored = (categories.json() as any).data.find((row: any) => row.id === categoryId);
    assert.equal(stored.iconUrl, iconAsset.storagePublicUrl);

    const preserveExistingIcon = await app.inject({
      method: "PATCH",
      url: `/api/admin/categories/${categoryId}`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { sortOrder: 9, reason: "未上传新图标时必须保留原图标" },
    });
    assert.equal(preserveExistingIcon.statusCode, 200, preserveExistingIcon.body);
    const preservedRow = await prisma.category.findUnique({ where: { id: categoryId } });
    assert.equal(preservedRow?.iconUrl, iconAsset.storagePublicUrl);

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/admin/categories/${categoryId}`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { iconAssetId: crypto.randomUUID(), reason: "非法素材必须拒绝" },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal((rejected.json() as any).error, "category_icon_asset_invalid");
  } finally {
    await app.close();
  }
});

test("越权P2-1：finance 无 order:cancel 权限，取消订单必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const finCookie = await loginAdmin(app, "finance");
    const cancelResp = await app.inject({
      method: "POST", url: "/api/admin/orders/INT-NOTEXIST-001/cancel",
      headers: { cookie: finCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：财务不能取消" },
    });
    assert.ok(
      cancelResp.statusCode === 403 || cancelResp.statusCode === 404,
      `finance cancel order should be 403 (or 404 if not impl), got ${cancelResp.statusCode}`,
    );
  } finally {
    await app.close();
  }
});

test("越权P2-2：operator 无 order:refund 权限，退款订单必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const opCookie = await loginAdmin(app, "operator");
    const refundResp = await app.inject({
      method: "POST", url: "/api/admin/orders/INT-NOTEXIST-001/refund",
      headers: { cookie: opCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：运营不能退款" },
    });
    assert.ok(
      refundResp.statusCode === 403 || refundResp.statusCode === 404,
      `operator refund order should be 403 (or 404 if not impl), got ${refundResp.statusCode}`,
    );
  } finally {
    await app.close();
  }
});

test("越权P2-3：auditor 无 entitlement:resend_invite 权限，补发邀请必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const audCookie = await loginAdmin(app, "auditor");
    const resendResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/not_exist_id/resend-invite",
      headers: { cookie: audCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：审计不能补发邀请" },
    });
    assert.ok(
      resendResp.statusCode === 403 || resendResp.statusCode === 404,
      `auditor resend invite should be 403 (or 404 if not impl), got ${resendResp.statusCode}`,
    );
  } finally {
    await app.close();
  }
});

test("越权P2-4：finance 无 ticket:resolve 权限，关单解决工单必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const finCookie = await loginAdmin(app, "finance");
    const resolveResp = await app.inject({
      method: "POST", url: "/api/admin/tickets/not_exist_ticket/resolve",
      headers: { cookie: finCookie, "Content-Type": "application/json" },
      payload: { reason: "越权测试：财务不能解决工单" },
    });
    assert.ok(
      resolveResp.statusCode === 403 || resolveResp.statusCode === 404,
      `finance resolve ticket should be 403 (or 404 if not impl), got ${resolveResp.statusCode}`,
    );
  } finally {
    await app.close();
  }
});

test("越权P2-5：仅 super_admin 可直授权益；customer_service/auditor/operator 必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const tgid = BigInt(8500000000 + (Date.now() % 100_000_000));
    const user = await prisma.user.create({ data: { telegramUserId: tgid, displayName: `Entitlement grant test ${tgid}` } });

    const audCookie = await loginAdmin(app, "auditor");
    const grantAudResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: audCookie, "Content-Type": "application/json" },
      payload: { userId: user.id, resourceType: "membership_channel", resourceId: TEST_KNOWN_IDS.membershipProductKey, reason: "越权测试：审计不能发", durationDays: 3 },
    });
    assert.equal(
      grantAudResp.statusCode, 403,
      `auditor grant should be strictly 403 (路由已注册，不再允许 404 混入)，实际=${grantAudResp.statusCode} body=${grantAudResp.body}`,
    );

    const opCookie = await loginAdmin(app, "operator");
    const grantOpResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: opCookie, "Content-Type": "application/json" },
      payload: { userId: user.id, resourceType: "membership_channel", resourceId: TEST_KNOWN_IDS.membershipProductKey, reason: "越权测试：运营不能发", durationDays: 3 },
    });
    assert.equal(
      grantOpResp.statusCode, 403,
      `operator grant should be strictly 403 (路由已注册，不再允许 404 混入)，实际=${grantOpResp.statusCode} body=${grantOpResp.body}`,
    );

    const csCookie = await loginAdmin(app, "customerService");
    const grantCsResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: csCookie, "Content-Type": "application/json" },
      payload: { userId: user.id, resourceType: "membership_channel", resourceId: TEST_KNOWN_IDS.membershipProductKey, reason: "permission test: customer service cannot grant", durationDays: 3 },
    });
    assert.equal(
      grantCsResp.statusCode, 403,
      `customer service grant should be strictly 403 (权限收敛：CS 只能补发邀请/查权益，不再允许直授)，实际=${grantCsResp.statusCode} body=${grantCsResp.body}`,
    );

    // ===== 正向：super_admin 必须 201（确保权限收敛未误伤紧急售后唯一执行人） =====
    const saCookie = await loginAdmin(app, "superAdmin");
    const grantSaResp = await app.inject({
      method: "POST", url: "/api/admin/entitlements/grant",
      headers: { cookie: saCookie, "Content-Type": "application/json" },
      payload: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: TEST_KNOWN_IDS.membershipProductKey,
        reason: "P2-5 正向：紧急售后 · 超管直授 3 天会员权益（验证未被误伤）",
        durationDays: 3,
      },
    });
    assert.equal(grantSaResp.statusCode, 201, `super_admin grant MUST succeed 201；实际=${grantSaResp.statusCode} body=${grantSaResp.body}`);
    const saBody = JSON.parse(grantSaResp.body);
    assert.equal(saBody.ok, true, "super_admin grant 返回 ok=true");
    assert.ok(saBody.entitlement?.id, "super_admin grant 返回体应包含 entitlement.id，实际=" + JSON.stringify(saBody));
    assert.equal(saBody.entitlement.userId, user.id, "super_admin grant: 生成的权益 userId 与请求一致");
    assert.equal(saBody.entitlement.resourceType, "membership_channel", "super_admin grant: resourceType 正确");
    assert.equal(saBody.entitlement.resourceId, TEST_KNOWN_IDS.membershipProductKey, "super_admin grant: resourceId 正确");
    assert.equal(saBody.entitlement.status, "active", "super_admin grant: 权益生成即 active，无需等订单");
    const exp = new Date(saBody.entitlement.expiresAt).getTime();
    const minExp = Date.now() + (3 * 86400 - 60) * 1000; // 3 天 - 1 分钟容差
    const maxExp = Date.now() + (3 * 86400 + 60) * 1000; // 3 天 + 1 分钟容差
    assert.ok(exp >= minExp && exp <= maxExp,
      `super_admin grant durationDays=3 预期 expiresAt ≈ now+3d，实际 ${new Date(exp).toISOString()}，范围 ${new Date(minExp).toISOString()} ~ ${new Date(maxExp).toISOString()}`);
    const auditCount = await prisma.adminAuditLog.count({
      where: { action: "admin.entitlement.grant", objectId: saBody.entitlement.id, objectType: "entitlement" },
    });
    assert.equal(auditCount, 1, "super_admin 直授后 adminAuditLog 必须有且仅有 1 条 admin.entitlement.grant 审计记录，实际=" + auditCount);
  } finally {
    await app.close();
  }
});

// =====================================================================
// P3 系列（channel 权限越权 · D2-1 最严：仅 super_admin 能 view/refresh/add/reveal_id）
// =====================================================================
test("越权P3-1：customer_service / auditor / operator / finance 调用 channel:view（GET /admin/channels）必须 403；super_admin=200", async () => {
  const app = await createApp(prisma);
  try {
    const expectations = [
      { role: "customerService", name: "客服" },
      { role: "auditor", name: "审计" },
      { role: "operator", name: "运营" },
      { role: "finance", name: "财务" },
    ] as const;
    for (const t of expectations) {
      const ck = await loginAdmin(app, t.role as any);
      const r = await app.inject({ method: "GET", url: "/api/admin/channels?pageSize=10", headers: { cookie: ck } });
      assert.equal(r.statusCode, 403, `P3-1 ${t.name} view channels MUST=403，实际=${r.statusCode} body=${r.body}`);
    }
    // 正向：super_admin = 200（即使是空列表）
    const saCk = await loginAdmin(app, "superAdmin");
    const r = await app.inject({ method: "GET", url: "/api/admin/channels?pageSize=10", headers: { cookie: saCk } });
    assert.equal(r.statusCode, 200, `P3-1 super_admin view channels MUST=200，实际=${r.statusCode} body=${r.body}`);
  } finally { await app.close(); }
});

test("频道管理列表只显示频道/群组，不把 Bot 私聊误报为未设管理员", async () => {
  const app = await createApp(prisma);
  const previousAesKey = process.env.CRYPTO_CHAT_ID_AES_KEY;
  try {
    // 本测试只创建一条临时的加密频道记录；测试环境旧值可能不是 32 字节，
    // 因此固定为符合 AES-256 要求的专用测试值，并在 finally 还原。
    process.env.CRYPTO_CHAT_ID_AES_KEY = "0123456789abcdef0123456789abcdef";
    const chatId = BigInt(7000000000 + (Date.now() % 100_000_000));
    const hmac = chatIdIndexKey(chatId);
    await prisma.adminManagedChannel.create({
      data: {
        deprecatedChatIdBig: chatId,
        chatIdCiphertextB64: encryptChatIdAesGcm(chatId),
        chatIdHmac: hmac,
        chatType: "private",
        isPrivate: false,
        purpose: "none",
        source: "auto_scan",
        botIsAdmin: false,
      },
    });

    const superCookie = await loginAdmin(app, "superAdmin");
    const r = await app.inject({ method: "GET", url: "/api/admin/channels?pageSize=100", headers: { cookie: superCookie } });
    assert.equal(r.statusCode, 200, r.body);
    const payload = r.json() as any;
    assert.ok(!(payload.items || []).some((item: any) => item.chatIdHmac === hmac || item.type === "private"),
      "Bot 私聊不能出现在频道管理列表中");
  } finally {
    if (previousAesKey === undefined) delete process.env.CRYPTO_CHAT_ID_AES_KEY;
    else process.env.CRYPTO_CHAT_ID_AES_KEY = previousAesKey;
    await app.close();
  }
});

test("越权P3-2：非 super_admin 调 refresh（POST /admin/channels/refresh）必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const ck = await loginAdmin(app, "operator");
    const r = await app.inject({
      method: "POST", url: "/api/admin/channels/refresh",
      headers: { cookie: ck, "Content-Type": "application/json" },
      payload: { reason: "P3-2 op refresh 越权", force: false },
    });
    assert.equal(r.statusCode, 403, `P3-2 operator refresh MUST 403，实际=${r.statusCode} body=${r.body}`);
  } finally { await app.close(); }
});

test("越权P3-3：非 super_admin 调 add（POST /admin/channels）必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const ck = await loginAdmin(app, "auditor");
    const r = await app.inject({
      method: "POST", url: "/api/admin/channels",
      headers: { cookie: ck, "Content-Type": "application/json" },
      payload: { chatId: "-1004360193327", reason: "P3-3 auditor add channel 越权" },
    });
    assert.equal(r.statusCode, 403, `P3-3 auditor add MUST 403，实际=${r.statusCode} body=${r.body}`);
  } finally { await app.close(); }
});

test("越权P3-4：非 super_admin 调 reveal-id（POST /admin/channels/:chatId/reveal-id）必须 403", async () => {
  const app = await createApp(prisma);
  try {
    const ck = await loginAdmin(app, "customerService");
    const r = await app.inject({
      method: "POST", url: "/api/admin/channels/-1004360193327/reveal-id",
      headers: { cookie: ck, "Content-Type": "application/json" },
      payload: { reason: "P3-4 CS 试图看真实频道 ID 越权" },
    });
    assert.equal(r.statusCode, 403, `P3-4 CS reveal-id MUST 403，实际=${r.statusCode} body=${r.body}`);
  } finally { await app.close(); }
});

test("频道登记请求列表绝不回传私密邀请链接明文", async () => {
  const app = await createApp(prisma);
  try {
    const superCookie = await loginAdmin(app, "superAdmin");
    const submitResp = await app.inject({
      method: "POST",
      url: "/api/admin/channels/discovery-requests",
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        channelLink: "https://t.me/+PrivateInviteSecret123",
        purpose: "membership_main",
        reason: "测试私密邀请链接脱敏",
      },
    });
    assert.equal(submitResp.statusCode, 201, submitResp.body);

    const listResp = await app.inject({
      method: "GET",
      url: "/api/admin/channels/discovery-requests",
      headers: { cookie: superCookie },
    });
    assert.equal(listResp.statusCode, 200, listResp.body);
    const items = (listResp.json() as any).items || [];
    const row = items.find((item: any) => item.linkType === "private_invite");
    assert.ok(row, "must contain private invite discovery row");
    assert.equal(row.submittedLink, "私密邀请已提交");
    assert.equal(row.normalizedLink, null);
    assert.ok(!JSON.stringify(row).includes("PrivateInviteSecret123"), "private invite token must never be exposed");
  } finally {
    await app.close();
  }
});

test("public 内容允许绑定完整视频并作为 Web 试看/完整版的唯一真源", async () => {
  const app = await createApp(prisma);
  try {
    const superCookie = await loginAdmin(app, "superAdmin");
    const mediaAsset = await seedReadyVideoAsset(prisma, {
      id: `full-video-public-forbidden-${crypto.randomUUID()}`,
      contentId: TEST_KNOWN_IDS.contentPublic,
      filename: "public-full.mp4",
    });
    const resp = await app.inject({
      method: "PATCH",
      url: `/api/admin/contents/${encodeURIComponent(TEST_KNOWN_IDS.contentPublic)}`,
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        fullVideoAssetId: mediaAsset.id,
        fullVideoAssetIds: [mediaAsset.id],
        reason: "public 绑定完整视频作为唯一源片",
      },
    });
    assert.equal(resp.statusCode, 200, resp.body);
    const refreshed = await prisma.content.findUnique({
      where: { id: TEST_KNOWN_IDS.contentPublic },
      include: { fullVideoSegments: { orderBy: { segmentOrder: "asc" } } },
    });
    assert.equal(refreshed?.fullVideoAssetId, mediaAsset.id);
    assert.deepEqual(refreshed?.fullVideoSegments.map((segment: any) => segment.videoAssetId), [mediaAsset.id]);
  } finally {
    await app.close();
  }
});

test("create 内容时跨内容绑定完整视频必须返回 asset_content_mismatch", async () => {
  const app = await createApp(prisma);
  try {
    const superCookie = await loginAdmin(app, "superAdmin");
    const foreignAsset = await seedReadyVideoAsset(prisma, {
      id: `foreign-create-video-${crypto.randomUUID()}`,
      contentId: TEST_KNOWN_IDS.contentMembership,
      filename: "foreign-create.mp4",
    });
    const beforeCount = await prisma.content.count();
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/contents",
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        title: "跨内容绑定完整视频（创建）",
        accessType: "membership",
        fullVideoAssetId: foreignAsset.id,
        fullVideoAssetIds: [foreignAsset.id],
        reason: "create should reject foreign full video asset",
      },
    });
    assert.equal(resp.statusCode, 409, resp.body);
    assert.equal((resp.json() as any).error, "asset_content_mismatch");
    const afterCount = await prisma.content.count();
    assert.equal(afterCount, beforeCount, "跨内容绑定在创建阶段被拦截后，不应留下新内容脏写");
  } finally {
    await app.close();
  }
});

test("edit 内容时跨内容绑定完整视频必须返回 asset_content_mismatch", async () => {
  const app = await createApp(prisma);
  try {
    const superCookie = await loginAdmin(app, "superAdmin");
    const foreignContentId = crypto.randomUUID();
    await prisma.content.create({
      data: {
        id: foreignContentId,
        title: "foreign membership draft",
        accessType: "membership",
        status: "draft",
      },
    });
    const foreignAsset = await seedReadyVideoAsset(prisma, {
      id: `foreign-edit-video-${crypto.randomUUID()}`,
      contentId: foreignContentId,
      filename: "foreign-edit.mp4",
    });
    const resp = await app.inject({
      method: "PATCH",
      url: `/api/admin/contents/${encodeURIComponent(TEST_KNOWN_IDS.contentMembership)}`,
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        fullVideoAssetId: foreignAsset.id,
        fullVideoAssetIds: [foreignAsset.id],
        reason: "edit should reject foreign full video asset",
      },
    });
    assert.equal(resp.statusCode, 409, resp.body);
    assert.equal((resp.json() as any).error, "asset_content_mismatch");
  } finally {
    await app.close();
  }
});

test("内容包管理：editor 可创建、编辑和下架；auditor 只读，价格以字符串安全返回", async () => {
  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const auditorCookie = await loginAdmin(app, "auditor");

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/packages",
      headers: { cookie: auditorCookie, "Content-Type": "application/json" },
      payload: { title: "不应创建", productTitle: "不应创建", priceMinor: "10", currency: "XTR" },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/packages",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        title: "联调内容包",
        productTitle: "联调内容包权益",
        priceMinor: "150",
        currency: "XTR",
        status: "published",
        productStatus: "active",
        reason: "内容包写操作回归",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const packageId = (created.json() as any).id;
    assert.ok(typeof packageId === "string" && packageId.length > 10);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/admin/packages/${packageId}`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { title: "联调内容包（已下架）", status: "offline", priceMinor: "0", reason: "下架回归" },
    });
    assert.equal(updated.statusCode, 200, updated.body);

    const listed = await app.inject({ method: "GET", url: "/api/admin/packages", headers: { cookie: auditorCookie } });
    assert.equal(listed.statusCode, 200, listed.body);
    const row = ((listed.json() as any).data || []).find((item: any) => item.id === packageId);
    assert.ok(row, "created package must be listable to auditor");
    assert.equal(row.status, "offline");
    assert.equal(row.priceMinor, "0");
    assert.equal(row.currency, "XTR");
    assert.equal(Object.hasOwn(row, "channelId"), false, "package API must never expose raw channel ID");

    const auditActions = await prisma.adminAuditLog.findMany({
      where: { objectType: "content_package", objectId: packageId },
      select: { action: true },
    });
    assert.deepEqual(auditActions.map((item: any) => item.action).sort(), ["package.create", "package.update"]);
  } finally {
    await app.close();
  }
});

test("首页 Banner：五类受控跳转均可保存，私密邀请与支付外链必须拒绝", async () => {
  const app = await createApp(prisma);
  try {
    const superCookie = await loginAdmin(app, "superAdmin");
    const bannerImage = await seedReadyMediaAsset(prisma, {
      id: crypto.randomUUID(),
      kind: "cover_image",
      filename: "banner-approved.jpg",
    });
    const imageLibrary = await app.inject({
      method: "GET",
      url: "/api/admin/banner-image-assets",
      headers: { cookie: superCookie },
    });
    assert.equal(imageLibrary.statusCode, 200, imageLibrary.body);
    const listedImage = ((imageLibrary.json() as any).data || []).find((item: any) => item.id === bannerImage.id);
    assert.equal(listedImage?.imageUrl, `https://example.com/${bannerImage.id}.bin`);
    assert.equal(Object.hasOwn(listedImage || {}, "storageKey"), false, "banner image library must not expose storage keys");
    const cases = [
      { targetType: "content", targetId: TEST_KNOWN_IDS.contentPublic },
      { targetType: "category", targetId: TEST_KNOWN_IDS.categoryFeatured },
      { targetType: "package", targetId: TEST_KNOWN_IDS.contentPackageKey },
      { targetType: "membership" },
      { targetType: "external", externalUrl: "https://t.me/InTune_bdsm" },
    ];
    for (const [index, item] of cases.entries()) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/banners",
        headers: { cookie: superCookie, "Content-Type": "application/json" },
        payload: {
          title: `Banner target ${index}`,
          slot: "home_primary",
          status: "draft",
          actionLabel: "查看详情",
          imageAssetId: bannerImage.id,
          ...item,
        },
      });
      assert.equal(response.statusCode, 201, response.body);
    }

    const unsafe = await app.inject({
      method: "POST",
      url: "/api/admin/banners",
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: {
        title: "unsafe private invite",
        slot: "home_primary",
        status: "draft",
        imageAssetId: bannerImage.id,
        targetType: "external",
        externalUrl: "https://t.me/+privateInviteMustNeverPass",
      },
    });
    assert.equal(unsafe.statusCode, 400, unsafe.body);
    assert.equal((unsafe.json() as any).error, "external_url_invalid");

    const selected = await prisma.banner.findFirst({ where: { title: "Banner target 0" }, select: { imageUrl: true } });
    assert.equal(selected?.imageUrl, `https://example.com/${bannerImage.id}.bin`, "Banner must persist the server-resolved image URL, never a client-supplied URL");
  } finally {
    await app.close();
  }
});

test("用户频道入口优先展示后台登记的免费公开频道，且不泄露频道标识", async () => {
  process.env.CRYPTO_CHAT_ID_AES_KEY = "12345678901234567890123456789012";
  const user = await prisma.user.create({
    data: { telegramUserId: String(8000000000 + (Date.now() % 1000000000)), displayName: "Channel entry test" },
  });
  const app = await createApp(prisma);
  const chatId = BigInt("-1009876543999");
  try {
    app.addHook("preHandler", async (req) => {
      (req as any).userId = user.id;
    });
    const channel = await prisma.adminManagedChannel.create({
      data: {
        chatIdHmac: chatIdIndexKey(chatId),
        chatIdCiphertextB64: encryptChatIdAesGcm(chatId),
        deprecatedChatIdBig: chatId,
        chatType: "channel",
        title: "Public preview test channel",
        username: "intune_public_preview_test",
        publicUrl: "https://t.me/intune_public_preview_test",
        isPrivate: false,
        purpose: "free_preview",
        source: "manual_add",
        botIsAdmin: true,
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/user/channels" });
    assert.equal(response.statusCode, 200, response.body);
    const item = (response.json() as any).items.find((entry: any) => entry.id === `public-managed-${channel.id}`);
    assert.ok(item, "后台登记的免费频道应出现在用户频道入口");
    assert.equal(item.kind, "public");
    assert.equal(item.link, "https://t.me/intune_public_preview_test");
    assert.equal(item.available, true);
    assert.doesNotMatch(response.body, /9876543999|chatIdCiphertext|chatIdHmac/i);
  } finally {
    await app.close();
  }
});

test("channel_post 收件箱入库后只能按 accessType 关联到允许的内容", async () => {
  const app = await createApp(prisma);
  try {
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "test-webhook-secret-token-at-least-32chars";
    process.env.CRYPTO_CHAT_ID_AES_KEY = "12345678901234567890123456789012";
    process.env.TELEGRAM_WEBHOOK_SECRET = webhookSecret;
    const superCookie = await loginAdmin(app, "superAdmin");
    const chatId = BigInt("-1009876543210");
    await prisma.adminManagedChannel.create({
      data: {
        chatIdHmac: chatIdIndexKey(chatId),
        chatIdCiphertextB64: encryptChatIdAesGcm(chatId),
        deprecatedChatIdBig: chatId,
        chatType: "channel",
        title: "Membership Main Test Channel",
        isPrivate: true,
        purpose: "membership_main",
        source: "manual_add",
        botIsAdmin: true,
        botCanPostMessages: true,
        botCanInviteUsers: true,
        botCanRestrictMembers: true,
      },
    });

    const webhookResp = await app.inject({
      method: "POST",
      url: "/api/api/telegram/webhook",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
      payload: {
        update_id: 9911223344,
        channel_post: {
          message_id: 42,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId.toString(), type: "channel", title: "Membership Main Test Channel" },
          video: { file_id: "video-file-id-1", duration: 31, width: 1280, height: 720 },
          caption: "会员完整视频 webhook 入库测试",
        },
      },
    });
    assert.equal(webhookResp.statusCode, 200, webhookResp.body);

    const linkable = await app.inject({
      method: "GET",
      url: `/api/admin/contents/${encodeURIComponent(TEST_KNOWN_IDS.contentMembership)}/linkable-channel-messages`,
      headers: { cookie: superCookie },
    });
    assert.equal(linkable.statusCode, 200, linkable.body);
    const items = (linkable.json() as any).items || [];
    assert.ok(items.length >= 1, "membership content should see at least one unlinked channel message");

    const mismatch = await app.inject({
      method: "GET",
      url: `/api/admin/contents/${encodeURIComponent(TEST_KNOWN_IDS.contentPublic)}/linkable-channel-messages`,
      headers: { cookie: superCookie },
    });
    assert.equal(mismatch.statusCode, 200, mismatch.body);
    assert.equal(((mismatch.json() as any).items || []).length, 0, "public content must not see membership_main messages");

    const selectedId = items[0].id;
    const linkResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${encodeURIComponent(TEST_KNOWN_IDS.contentMembership)}/link-channel-message`,
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: { channelMessageId: selectedId, reason: "测试关联 membership channel_post" },
    });
    assert.equal(linkResp.statusCode, 200, linkResp.body);
    assert.equal((linkResp.json() as any).status, "linked");

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${encodeURIComponent(TEST_KNOWN_IDS.contentMembership)}/link-channel-message`,
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: { channelMessageId: selectedId, reason: "测试重复关联" },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
  } finally {
    await app.close();
  }
});
