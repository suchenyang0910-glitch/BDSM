import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import watchProgressRoutes from "../src/routes/watchProgress.js";
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
  return cookies.map((c: string) => c.split(";")[0]).join("; ");
}

async function createApp(prisma: any) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, { secret: "test-session-secret-is-at-least-thirty-two-characters", cookie: { secure: false } });
  app.decorate("prisma", prisma);
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
  await app.register(watchProgressRoutes, { prefix: "/api" });
  return app;
}

async function loginAsUser(app: any, userId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/__test/login-user/${encodeURIComponent(userId)}` });
  assert.equal(res.statusCode, 200, res.body);
  return cookieFromResponse(res);
}

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("watch progress routes reject unauthorized reads and writes", async () => {
  const app = await createApp(prisma);
  try {
    const read = await app.inject({ method: "GET", url: "/api/user/watch-progress/history?page=1&pageSize=10" });
    assert.equal(read.statusCode, 401, read.body);

    const write = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentPublic}/watch-progress`,
      headers: { "Content-Type": "application/json" },
      payload: { eventName: "start", positionSec: 0, durationSec: 300 },
    });
    assert.equal(write.statusCode, 401, write.body);
  } finally {
    await app.close();
  }
});

test("watch progress history reads from WatchProgress and orders by lastPlayedAt desc", async () => {
  const app = await createApp(prisma);
  const user = await prisma.user.create({
    data: {
      telegramUserId: BigInt(900000000011),
      displayName: "Watch Progress Reader",
      status: "active",
    },
  });
  const cookieHeader = await loginAsUser(app, user.id);
  try {
    const coverAsset = await prisma.videoAsset.create({
      data: {
        contentId: TEST_KNOWN_IDS.contentMembership,
        kind: "cover",
        objectKey: `covers/${TEST_KNOWN_IDS.contentMembership}/watch-progress-cover.jpg`,
        mimeType: "image/jpeg",
        byteSize: 1024n,
        sha256: "b".repeat(64),
        status: "verified",
        verifiedAt: new Date(),
      },
    });
    await prisma.watchProgress.createMany({
      data: [
        {
          userId: user.id,
          contentId: TEST_KNOWN_IDS.contentPublic,
          positionSec: 45,
          durationSec: 300,
          lastPlayedAt: new Date("2026-08-25T12:01:00.000Z"),
        },
        {
          userId: user.id,
          contentId: TEST_KNOWN_IDS.contentMembership,
          positionSec: 210,
          durationSec: 1200,
          lastPlayedAt: new Date("2026-08-25T12:05:00.000Z"),
        },
      ],
    });
    await prisma.watchEvent.createMany({
      data: [
        {
          userId: user.id,
          contentId: TEST_KNOWN_IDS.contentPublic,
          eventName: "watch_start",
          occurredAt: new Date("2026-08-25T12:20:00.000Z"),
          positionSec: 5,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/user/watch-progress/history?page=1&pageSize=10",
      headers: { cookie: cookieHeader },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.equal(body.items.length, 2);
    assert.equal(body.recent.contentId, TEST_KNOWN_IDS.contentMembership);
    assert.equal(body.items[0].contentId, TEST_KNOWN_IDS.contentMembership);
    assert.equal(body.items[0].resumePositionSec, 210);
    assert.equal(body.items[0].progressPercent, 18);
    assert.match(
      body.items[0].coverUrl,
      new RegExp(`^/api/contents/${TEST_KNOWN_IDS.contentMembership}/cover\\?v=${coverAsset.id}$`),
      "观看记录封面必须携带素材版本，避免复用过期的受控图片跳转",
    );
  } finally {
    await app.close();
  }
});

test("watch progress write upserts and resets next resume to 0 when near ending", async () => {
  const app = await createApp(prisma);
  const user = await prisma.user.create({
    data: {
      telegramUserId: BigInt(900000000012),
      displayName: "Watch Progress Writer",
      status: "active",
    },
  });
  const cookieHeader = await loginAsUser(app, user.id);
  try {
    const first = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentPublic}/watch-progress`,
      headers: { cookie: cookieHeader, "Content-Type": "application/json" },
      payload: { eventName: "progress", positionSec: 120, durationSec: 300, quality: "720p" },
    });
    assert.equal(first.statusCode, 200, first.body);
    const firstBody = first.json() as any;
    assert.equal(firstBody.item.resumePositionSec, 120);
    assert.equal(firstBody.item.isFinished, false);

    const finished = await app.inject({
      method: "POST",
      url: `/api/contents/${TEST_KNOWN_IDS.contentPublic}/watch-progress`,
      headers: { cookie: cookieHeader, "Content-Type": "application/json" },
      payload: { eventName: "pause", positionSec: 286, durationSec: 300, quality: "720p" },
    });
    assert.equal(finished.statusCode, 200, finished.body);
    const finishedBody = finished.json() as any;
    assert.equal(finishedBody.item.resumePositionSec, 0);
    assert.equal(finishedBody.item.isFinished, true);

    const stored = await prisma.watchProgress.findUnique({
      where: { userId_contentId: { userId: user.id, contentId: TEST_KNOWN_IDS.contentPublic } },
    });
    assert.ok(stored);
    assert.equal(stored?.positionSec, 286);
    assert.ok(stored?.completedAt instanceof Date);

    const events = await prisma.watchEvent.findMany({
      where: { userId: user.id, contentId: TEST_KNOWN_IDS.contentPublic },
      orderBy: { occurredAt: "asc" },
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].eventName, "watch_progress");
    assert.equal(events[1].eventName, "watch_pause");
  } finally {
    await app.close();
  }
});

test("watch progress supports deleting a single record and clearing all history", async () => {
  const app = await createApp(prisma);
  const user = await prisma.user.create({
    data: {
      telegramUserId: BigInt(900000000013),
      displayName: "Watch Progress Cleaner",
      status: "active",
    },
  });
  const cookieHeader = await loginAsUser(app, user.id);
  try {
    await prisma.watchProgress.createMany({
      data: [
        {
          userId: user.id,
          contentId: TEST_KNOWN_IDS.contentPublic,
          positionSec: 12,
          durationSec: 300,
          lastPlayedAt: new Date("2026-08-25T12:00:00.000Z"),
        },
        {
          userId: user.id,
          contentId: TEST_KNOWN_IDS.contentMembership,
          positionSec: 34,
          durationSec: 1200,
          lastPlayedAt: new Date("2026-08-25T12:01:00.000Z"),
        },
      ],
    });

    const deleteOne = await app.inject({
      method: "DELETE",
      url: `/api/user/watch-progress/${TEST_KNOWN_IDS.contentPublic}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(deleteOne.statusCode, 200, deleteOne.body);

    let count = await prisma.watchProgress.count({ where: { userId: user.id } });
    assert.equal(count, 1);

    const clearAll = await app.inject({
      method: "POST",
      url: "/api/user/watch-progress/clear",
      headers: { cookie: cookieHeader },
    });
    assert.equal(clearAll.statusCode, 200, clearAll.body);
    count = await prisma.watchProgress.count({ where: { userId: user.id } });
    assert.equal(count, 0);
  } finally {
    await app.close();
  }
});
