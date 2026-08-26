import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";

import playbackRoutes from "../src/routes/playback.js";
import { loadPlaybackConfig } from "../src/services/playbackConfig.js";
import { createPlaybackDeliverySigner, verifyPlaybackToken } from "../src/services/playbackDelivery.js";
import {
  setupTestHarness,
  teardownTestHarness,
  seedTestData,
  TEST_KNOWN_IDS,
} from "./_testHarness.js";

process.env.VIDEO_CDN_SIGNING_KEY ||= "playback-signing-key-with-sufficient-length";

test("playback delivery token is signed, scoped and expires fail-closed", async () => {
  const key = "playback-signing-key-with-sufficient-length";
  const signer = createPlaybackDeliverySigner({ cdnBaseUrl: "https://video.example.com", signingMode: "signed_cookie", sessionTtlSeconds: 120, signingKey: key });
  const issued = await signer.issue({ sessionId: "session-token-test", contentId: TEST_KNOWN_IDS.contentMembership, variant: "preview", expiresAt: new Date(Date.now() + 60_000) });
  const token = issued.responseHeaders["set-cookie"].split(";")[0].split("=")[1];
  const verified = verifyPlaybackToken({ token, signingKey: key });
  assert.equal(verified?.sessionId, "session-token-test");
  assert.equal(verified?.contentId, TEST_KNOWN_IDS.contentMembership);
  assert.equal(verified?.variant, "preview");
  assert.equal(verifyPlaybackToken({ token: `${token}tampered`, signingKey: key }), null);
  assert.equal(verifyPlaybackToken({ token, signingKey: key, now: new Date(Date.now() + 120_000) }), null);
});

function cookieFromResponse(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const cookies: string[] = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  return cookies.map((c: string) => c.split(";")[0]).join("; ");
}

async function createApp(prisma: any, env: Record<string, string>) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, { secret: "test-session-secret-is-at-least-thirty-two-characters", cookie: { secure: false } });
  app.decorate("prisma", prisma);
  app.decorate("playbackConfig", loadPlaybackConfig({ ...process.env, ...env }) as any);
  app.decorateRequest("userId", null);
  app.decorateRequest("telegramUserId", null);
  app.addHook("preHandler", async (req, _reply) => {
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
    sess.telegramUserId = null;
    return { ok: true };
  });
  await app.register(playbackRoutes, { prefix: "/api" });
  return app;
}

async function loginAsUser(app: any, userId: string): Promise<string> {
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
      sha256: "a".repeat(64),
      status: "verified",
      verifiedAt: new Date(),
    },
  });
  await prisma.content.update({
    where: { id: contentId },
    data: {
      fullVideoAssetId: asset.id,
      platformPlaybackEnabled: true,
      previewEnabled: true,
      previewDurationSeconds: 60,
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
        durationSeconds: 60,
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
  return asset;
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("playback session rejects unauthorized access and disabled mode", async () => {
  const app = await createApp(prisma, {
    VIDEO_DELIVERY_MODE: "disabled",
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-session`,
    });
    assert.equal(res.statusCode, 401, res.body);

    const status = await app.inject({
      method: "GET",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-status`,
    });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal((status.json() as any).errorClass, "video_delivery_disabled");
  } finally {
    await app.close();
  }
});

test("playback session issues preview manifest for unpaid user and full manifest for entitled user", async () => {
  const app = await createApp(prisma, {
    VIDEO_DELIVERY_MODE: "poc",
    VIDEO_CDN_BASE_URL: "https://video.example.com",
    VIDEO_CDN_SIGNING_MODE: "signed_cookie",
    VIDEO_CDN_SIGNING_KEY: "playback-signing-key-with-sufficient-length",
    PLAYBACK_POC_CONTENT_IDS: TEST_KNOWN_IDS.contentMembership,
    PLAYBACK_POC_USER_IDS: "user-playback-ok",
  });
  const user = await prisma.user.create({
    data: {
      id: "user-playback-ok",
      telegramUserId: BigInt(910000000001),
      displayName: "Playback OK",
      status: "active",
    },
  });
  const cookieHeader = await loginAsUser(app, user.id);
  try {
    await preparePlayableContent(prisma, TEST_KNOWN_IDS.contentMembership);
    const previewRes = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-session`,
      headers: {
        cookie: cookieHeader,
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        "accept-language": "zh-CN,zh;q=0.9",
      },
    });
    assert.equal(previewRes.statusCode, 200, previewRes.body);
    const previewBody = previewRes.json() as any;
    assert.equal(previewBody.deliveryVariant, "preview");
    assert.match(previewBody.manifestUrl, /\/playback\/.*\/preview\/index\.m3u8$/);

    await prisma.entitlement.create({
      data: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: "membership-main",
        status: "active",
        startsAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-session`,
      headers: {
        cookie: cookieHeader,
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        "accept-language": "zh-CN,zh;q=0.9",
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.deliveryVariant, "full");
    assert.match(body.manifestUrl, /^https:\/\/video\.example\.com\/playback\/.*\/full\/master\.m3u8$/);
    assert.ok(body.sessionId);
    assert.ok(String(res.headers["set-cookie"] || "").includes("__Secure-intune_playback="));

    const session = await prisma.playbackSession.findUnique({ where: { id: body.sessionId } });
    assert.ok(session);
    assert.equal(session?.userId, user.id);
    assert.equal(session?.contentId, TEST_KNOWN_IDS.contentMembership);
    assert.equal(session?.status, "active");

    const grants = await prisma.playbackGrant.findMany({ where: { playbackSessionId: body.sessionId } });
    assert.equal(grants.length, 2);
    const activeGrant = grants.find((row: any) => row.revokedAt == null);
    assert.ok(activeGrant);
    assert.equal(activeGrant?.scopePath, `/playback/${TEST_KNOWN_IDS.contentMembership}/full/*`);

    const events = await prisma.watchEvent.findMany({
      where: { sessionId: body.sessionId },
      orderBy: { occurredAt: "asc" },
    });
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((row: any) => row.eventName), ["playback_start", "playback_start"]);
    assert.equal(events[0].source, "platform_playback");
  } finally {
    await app.close();
  }
});

test("playback session uses preview for unpaid users and enforces device limit without leaking device detail", async () => {
  const app = await createApp(prisma, {
    VIDEO_DELIVERY_MODE: "poc",
    VIDEO_CDN_BASE_URL: "https://video.example.com",
    VIDEO_CDN_SIGNING_MODE: "signed_cookie",
    VIDEO_CDN_SIGNING_KEY: "playback-signing-key-with-sufficient-length",
    PLAYBACK_POC_CONTENT_IDS: TEST_KNOWN_IDS.contentMembership,
    PLAYBACK_POC_USER_IDS: "user-playback-limit",
    PLAYBACK_MAX_ACTIVE_DEVICES: "2",
  });
  const user = await prisma.user.create({
    data: {
      id: "user-playback-limit",
      telegramUserId: BigInt(910000000002),
      displayName: "Playback Limit",
      status: "active",
    },
  });
  const cookieHeader = await loginAsUser(app, user.id);
  try {
    await preparePlayableContent(prisma, TEST_KNOWN_IDS.contentMembership);

    const noEntitlement = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-session`,
      headers: { cookie: cookieHeader, "user-agent": "Device A" },
    });
    assert.equal(noEntitlement.statusCode, 200, noEntitlement.body);
    assert.equal((noEntitlement.json() as any).deliveryVariant, "preview");

    await prisma.entitlement.create({
      data: {
        userId: user.id,
        resourceType: "membership_channel",
        resourceId: "membership-main",
        status: "active",
        startsAt: new Date(),
      },
    });

    const first = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-session`,
      headers: { cookie: cookieHeader, "user-agent": "Device A" },
    });
    assert.equal(first.statusCode, 200, first.body);

    const second = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-session`,
      headers: { cookie: cookieHeader, "user-agent": "Device B" },
    });
    assert.equal(second.statusCode, 200, second.body);

    const third = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentMembership}/playback-session`,
      headers: { cookie: cookieHeader, "user-agent": "Device C" },
    });
    assert.equal(third.statusCode, 409, third.body);
    const body = third.json() as any;
    assert.equal(body.error, "playback_device_limit");
    assert.equal(Object.keys(body).includes("devices"), false);
  } finally {
    await app.close();
  }
});

test("playback heartbeat renews session and end revokes active grant", async () => {
  const app = await createApp(prisma, {
    VIDEO_DELIVERY_MODE: "poc",
    VIDEO_CDN_BASE_URL: "https://video.example.com",
    VIDEO_CDN_SIGNING_MODE: "edge_token",
    VIDEO_CDN_SIGNING_KEY: "playback-signing-key-with-sufficient-length",
    PLAYBACK_POC_CONTENT_IDS: TEST_KNOWN_IDS.contentPackage,
    PLAYBACK_POC_USER_IDS: "user-playback-heartbeat",
  });
  const user = await prisma.user.create({
    data: {
      id: "user-playback-heartbeat",
      telegramUserId: BigInt(910000000003),
      displayName: "Playback Heartbeat",
      status: "active",
    },
  });
  const cookieHeader = await loginAsUser(app, user.id);
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
      headers: { cookie: cookieHeader, "user-agent": "Package Device" },
    });
    assert.equal(created.statusCode, 200, created.body);
    const createdBody = created.json() as any;

    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/playback-sessions/${createdBody.sessionId}/heartbeat`,
      headers: { cookie: cookieHeader, "Content-Type": "application/json" },
      payload: { eventName: "progress", positionSec: 188, durationSec: 600, quality: "720p" },
    });
    assert.equal(heartbeat.statusCode, 200, heartbeat.body);
    assert.equal((heartbeat.json() as any).completed, false);

    const progress = await prisma.watchProgress.findUnique({
      where: { userId_contentId: { userId: user.id, contentId: TEST_KNOWN_IDS.contentPackage } },
    });
    assert.ok(progress);
    assert.equal(progress?.positionSec, 188);

    const ending = await app.inject({
      method: "POST",
      url: `/api/playback-sessions/${createdBody.sessionId}/end`,
      headers: { cookie: cookieHeader, "Content-Type": "application/json" },
      payload: { eventName: "complete", positionSec: 590, durationSec: 600, quality: "720p" },
    });
    assert.equal(ending.statusCode, 200, ending.body);

    const session = await prisma.playbackSession.findUnique({ where: { id: createdBody.sessionId } });
    assert.equal(session?.status, "expired");

    const activeGrant = await prisma.playbackGrant.findFirst({
      where: { playbackSessionId: createdBody.sessionId, revokedAt: null },
    });
    assert.equal(activeGrant, null);

    const events = await prisma.watchEvent.findMany({
      where: { sessionId: createdBody.sessionId },
      orderBy: { occurredAt: "asc" },
    });
    assert.deepEqual(events.map((row: any) => row.eventName), ["playback_start", "playback_progress", "playback_complete"]);
  } finally {
    await app.close();
  }
});
