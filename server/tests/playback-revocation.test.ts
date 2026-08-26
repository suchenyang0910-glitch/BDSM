import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";

import adminRoutes from "../src/routes/admin.js";
import adminUsersAndSupportRoutes from "../src/routes/adminUsersAndSupport.js";
import adminCmsRoutes, { adminPackageRoutes } from "../src/routes/adminCms.js";
import playbackRoutes from "../src/routes/playback.js";
import { loadPlaybackConfig } from "../src/services/playbackConfig.js";
import { processPlaybackRevokeOutboxBatch, queuePlaybackRevoke } from "../src/services/playbackRevocation.js";
import {
  setupTestHarness,
  teardownTestHarness,
  seedTestData,
  TEST_CREDENTIALS,
  TEST_KNOWN_IDS,
} from "./_testHarness.js";

process.env.VIDEO_CDN_SIGNING_KEY ||= "playback-signing-key-with-sufficient-length";

function cookieFromResponse(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const cookies: string[] = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  return cookies.map((c: string) => c.split(";")[0]).join("; ");
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

async function createApp(prisma: any, env: Record<string, string>) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, { secret: "test-session-secret-is-at-least-thirty-two-characters", cookie: { secure: false } });
  app.decorate("prisma", prisma);
  app.decorate("playbackConfig", loadPlaybackConfig({ ...process.env, ...env }) as any);
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
    const { id } = (req.params || {}) as { id: string };
    const sess = req.session as any;
    sess.userId = id;
    return { ok: true };
  });
  await app.register(adminRoutes, { prefix: "/api" });
  await app.register(adminCmsRoutes, { prefix: "/api" });
  await app.register(adminPackageRoutes, { prefix: "/api" });
  await app.register(adminUsersAndSupportRoutes, { prefix: "/api" });
  await app.register(playbackRoutes, { prefix: "/api" });
  return app;
}

async function loginUser(app: any, userId: string) {
  const res = await app.inject({ method: "POST", url: `/__test/login-user/${encodeURIComponent(userId)}` });
  assert.equal(res.statusCode, 200, res.body);
  return cookieFromResponse(res);
}

async function preparePlayableContent(prisma: any, contentId: string) {
  const asset = await prisma.videoAsset.create({
    data: {
      contentId,
      kind: "full_source",
      objectKey: `private/source/${contentId}.mp4`,
      originalFilename: `${contentId}.mp4`,
      mimeType: "video/mp4",
      byteSize: BigInt(1_024_000),
      sha256: "b".repeat(64),
      status: "verified",
      verifiedAt: new Date(),
    },
  });
  await prisma.content.update({
    where: { id: contentId },
    data: {
      fullVideoAssetId: asset.id,
      platformPlaybackEnabled: true,
      status: "published",
    },
  });
  await prisma.transcodeJob.create({
    data: {
      contentId,
      assetId: asset.id,
      status: "ready",
      attemptCount: 1,
      progressPercent: 100,
      queuedAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  await prisma.videoRendition.createMany({
    data: [
      {
        contentId,
        assetId: asset.id,
        kind: "preview",
        status: "ready",
        manifestKey: `hls/${contentId}/${asset.id}/preview/index.m3u8`,
        prefixKey: `hls/${contentId}/${asset.id}/preview`,
        width: 854,
        height: 480,
        bitrateKbps: 900,
        durationSeconds: 45,
        segmentCount: 12,
        byteSize: BigInt(12_345),
        readyAt: new Date(),
      },
      {
        contentId,
        assetId: asset.id,
        kind: "hls_480",
        status: "ready",
        manifestKey: `hls/${contentId}/${asset.id}/hls_480/index.m3u8`,
        prefixKey: `hls/${contentId}/${asset.id}/hls_480`,
        width: 854,
        height: 480,
        bitrateKbps: 1200,
        durationSeconds: 600,
        segmentCount: 80,
        byteSize: BigInt(98_765),
        readyAt: new Date(),
      },
    ],
  });
}

async function findLatestPlaybackRevokeOutbox(
  prismaClient: any,
  where: { userId?: string; contentId?: string; reason?: string },
) {
  const clauses: string[] = [];
  const values: any[] = [];
  let idx = 1;
  if (where.userId) {
    clauses.push(`"user_id" = $${idx++}`);
    values.push(where.userId);
  }
  if (where.contentId) {
    clauses.push(`"content_id" = $${idx++}`);
    values.push(where.contentId);
  }
  if (where.reason) {
    clauses.push(`"reason" = $${idx++}::"PlaybackRevokeReason"`);
    values.push(where.reason);
  }
  const sql = `SELECT * FROM "playback_revoke_outbox"${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY "created_at" DESC LIMIT 1`;
  const rows = await prismaClient.$queryRawUnsafe<any[]>(sql, ...values);
  return rows[0] || null;
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("playback revoke outbox blocks new sessions after refund-style revoke is processed", async () => {
  const app = await createApp(prisma, {
    VIDEO_DELIVERY_MODE: "poc",
    VIDEO_CDN_BASE_URL: "https://video.example.com",
    VIDEO_CDN_SIGNING_MODE: "signed_cookie",
    VIDEO_CDN_SIGNING_KEY: "playback-signing-key-with-sufficient-length",
    PLAYBACK_POC_CONTENT_IDS: TEST_KNOWN_IDS.contentMembership,
    PLAYBACK_POC_USER_IDS: "user-revoke-1",
  });
  const user = await prisma.user.create({
    data: {
      id: "user-revoke-1",
      telegramUserId: BigInt(920000000001),
      displayName: "Playback revoke 1",
      status: "active",
    },
  });
  const userCookie = await loginUser(app, user.id);
  try {
    await preparePlayableContent(prisma, TEST_KNOWN_IDS.contentMembership);
    const entitlement = await prisma.entitlement.create({
      data: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: "membership-main",
        status: "active",
        startsAt: new Date(),
      },
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-session`,
      headers: { cookie: userCookie, "user-agent": "Revocation Device" },
    });
    assert.equal(created.statusCode, 200, created.body);

    await prisma.$transaction(async (tx: any) => {
      await tx.entitlement.update({
        where: { id: entitlement.id },
        data: { status: "revoked" },
      });
      await queuePlaybackRevoke(tx, {
        userId: user.id,
        entitlementId: entitlement.id,
        reason: "refund",
      });
    });
    const processed = await processPlaybackRevokeOutboxBatch(prisma, { limit: 10 });
    assert.equal(processed.processed, 1);

    const session = await prisma.playbackSession.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(session?.revokedAt);

    const blocked = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-session`,
      headers: { cookie: userCookie, "user-agent": "Revocation Device" },
    });
    assert.equal(blocked.statusCode, 200, blocked.body);
    assert.equal((blocked.json() as any).deliveryVariant, "preview");
  } finally {
    await app.close();
  }
});

test("heartbeat fails closed after revoke and session never extends beyond five minutes", async () => {
  const app = await createApp(prisma, {
    VIDEO_DELIVERY_MODE: "poc",
    VIDEO_CDN_BASE_URL: "https://video.example.com",
    VIDEO_CDN_SIGNING_MODE: "edge_token",
    VIDEO_CDN_SIGNING_KEY: "playback-signing-key-with-sufficient-length",
    PLAYBACK_POC_CONTENT_IDS: TEST_KNOWN_IDS.contentPackage,
    PLAYBACK_POC_USER_IDS: "user-revoke-2",
    PLAYBACK_SESSION_TTL_SECONDS: "900",
  });
  const user = await prisma.user.create({
    data: {
      id: "user-revoke-2",
      telegramUserId: BigInt(920000000002),
      displayName: "Playback revoke 2",
      status: "active",
    },
  });
  const userCookie = await loginUser(app, user.id);
  try {
    await preparePlayableContent(prisma, TEST_KNOWN_IDS.contentPackage);
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        resourceType: "package",
        resourceId: TEST_KNOWN_IDS.contentPackageKey,
        status: "active",
        startsAt: new Date(),
      },
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentPackage}/playback-session`,
      headers: { cookie: userCookie, "user-agent": "Five Minute Device" },
    });
    assert.equal(created.statusCode, 200, created.body);
    const body = created.json() as any;

    const sessionBefore = await prisma.playbackSession.findUnique({ where: { id: body.sessionId } });
    assert.ok(sessionBefore);
    const maxTtlMs = new Date(body.expiresAt).getTime() - Date.now();
    assert.ok(maxTtlMs <= 300_000 && maxTtlMs > 0, `ttl should be capped at 5 minutes, got ${maxTtlMs}`);

    await prisma.$transaction(async (tx: any) => {
      await queuePlaybackRevoke(tx, {
        userId: user.id,
        contentId: TEST_KNOWN_IDS.contentPackage,
        reason: "manual_admin",
      });
    });

    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/playback-sessions/${body.sessionId}/heartbeat`,
      headers: { cookie: userCookie, "Content-Type": "application/json" },
      payload: { eventName: "progress", positionSec: 33, durationSec: 600 },
    });
    assert.equal(heartbeat.statusCode, 409, heartbeat.body);
    assert.equal((heartbeat.json() as any).error, "playback_session_inactive");

    const sessionAfter = await prisma.playbackSession.findUnique({ where: { id: body.sessionId } });
    assert.ok(sessionAfter?.revokedAt);
  } finally {
    await app.close();
  }
});

test("super admin can enqueue manual playback revoke for a user", async () => {
  const app = await createApp(prisma, {
    VIDEO_DELIVERY_MODE: "disabled",
  });
  try {
    const superCookie = await loginAdmin(app, "superAdmin");
    const user = await prisma.user.create({
      data: {
        id: "user-revoke-3",
        telegramUserId: BigInt(920000000003),
        displayName: "Playback revoke 3",
        status: "active",
      },
    });
    await prisma.playbackSession.create({
      data: {
        userId: user.id,
        contentId: TEST_KNOWN_IDS.contentMembership,
        status: "active",
        deliveryMode: "poc",
        deviceHash: "hash-1",
        expiresAt: new Date(Date.now() + 120_000),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${user.id}/revoke-playback-sessions`,
      headers: { cookie: superCookie, "Content-Type": "application/json" },
      payload: { reason: "客服确认退款，手动撤销平台播放会话" },
    });
    assert.equal(response.statusCode, 200, response.body);
    const payload = response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.activeSessionCount, 1);

    const outbox = await findLatestPlaybackRevokeOutbox(prisma, { userId: user.id });
    assert.equal(outbox?.reason, "manual_admin");
    assert.equal(outbox?.status, "queued");
  } finally {
    await app.close();
  }
});

test("content unpublish enqueues playback revoke outbox", async () => {
  const app = await createApp(prisma, {
    VIDEO_DELIVERY_MODE: "disabled",
  });
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentMembership}/unpublish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { reason: "统一验收前手动下架，验证受控播放撤权" },
    });
    assert.equal(response.statusCode, 200, response.body);

    const outbox = await findLatestPlaybackRevokeOutbox(prisma, {
      contentId: TEST_KNOWN_IDS.contentMembership,
      reason: "content_unpublished",
    });
    assert.ok(outbox);
    assert.equal(outbox?.status, "queued");
  } finally {
    await app.close();
  }
});
