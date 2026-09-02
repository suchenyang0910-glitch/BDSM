import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import { Readable } from "node:stream";
import communityMediaRoutes from "../src/routes/communityMedia.js";
import { getS3Client } from "../src/services/objectStorage.js";
import { processCommunityVideoAsset } from "../src/services/communityMedia.js";
import { seedTestData, setupTestHarness, teardownTestHarness } from "./_testHarness.js";

process.env.OBJECT_STORAGE_ENDPOINT = process.env.OBJECT_STORAGE_ENDPOINT || "https://example-object-storage.local";
process.env.OBJECT_STORAGE_REGION = process.env.OBJECT_STORAGE_REGION || "local";
process.env.OBJECT_STORAGE_BUCKET = process.env.OBJECT_STORAGE_BUCKET || "intune-test-private";
process.env.OBJECT_STORAGE_ACCESS_KEY = process.env.OBJECT_STORAGE_ACCESS_KEY || "test-access";
process.env.OBJECT_STORAGE_SECRET_KEY = process.env.OBJECT_STORAGE_SECRET_KEY || "test-secret";
process.env.COMMUNITY_MEDIA_RUNNER = "mock";

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
  await app.register(communityMediaRoutes, { prefix: "/api" });
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

test("community upload sessions are author-only and server-generated keys stay inside community prefix", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  try {
    const author = await createUser(prisma, "社区作者上传 A");
    const other = await createUser(prisma, "社区路人 A");
    const post = await prisma.communityPost.create({
      data: {
        authorId: author.id,
        body: "待审帖子上传图片",
        status: "pending",
      },
    });
    const otherCookie = await loginUser(app, other.id);
    const authorCookie = await loginUser(app, author.id);

    const forbidden = await app.inject({
      method: "POST",
      url: `/api/community/posts/${encodeURIComponent(post.id)}/assets/upload-session`,
      headers: { cookie: otherCookie, "Content-Type": "application/json" },
      payload: { kind: "image", filename: "cover.jpg", mimeType: "image/jpeg", byteSize: 1024, sha256: "a".repeat(44) },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);

    const resp = await app.inject({
      method: "POST",
      url: `/api/community/posts/${encodeURIComponent(post.id)}/assets/upload-session`,
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: {
        kind: "image",
        filename: "cover.jpg",
        mimeType: "image/jpeg",
        byteSize: 1024,
        sha256: "A".repeat(44),
        objectKey: "hacked/path.jpg",
      },
    });
    assert.equal(resp.statusCode, 200, resp.body);
    const body = resp.json() as any;
    assert.equal(body.uploadMode, "single_part");
    assert.equal(Object.hasOwn(body, "objectKey"), false);

    const session = await (prisma as any).communityUploadSession.findUnique({ where: { id: body.uploadSessionId } });
    assert.ok(session);
    assert.match(String(session.objectKey), new RegExp(`^community/posts/${post.id}/images/.+/source`));
    assert.equal(String(session.objectKey).includes("hacked"), false);
  } finally {
    await app.close();
  }
});

test("community image complete generates thumbnail and controlled reads fail after post hidden", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  const restoreS3 = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "HeadObjectCommand") {
      return {
        ContentLength: 1024,
        ContentType: "image/jpeg",
        Metadata: { uploadsessionid: currentSessionId, sha256: "B".repeat(44) },
      };
    }
    if (name === "GetObjectCommand") {
      return { Body: Readable.from(Buffer.from("mock-source-image")) };
    }
    if (name === "PutObjectCommand") {
      return {};
    }
    return undefined;
  });
  const originalFetch = globalThis.fetch;
  let currentSessionId = "";
  globalThis.fetch = async () => new Response(Buffer.from("thumb-bytes"), { status: 200, headers: { "content-type": "image/jpeg" } });
  try {
    const author = await createUser(prisma, "社区作者图片 B");
    const post = await prisma.communityPost.create({
      data: {
        authorId: author.id,
        body: "待审图片帖子",
        status: "pending",
      },
    });
    const authorCookie = await loginUser(app, author.id);
    const init = await app.inject({
      method: "POST",
      url: `/api/community/posts/${encodeURIComponent(post.id)}/assets/upload-session`,
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: { kind: "image", filename: "photo.jpg", mimeType: "image/jpeg", byteSize: 1024, sha256: "B".repeat(44) },
    });
    assert.equal(init.statusCode, 200, init.body);
    currentSessionId = (init.json() as any).uploadSessionId;

    const complete = await app.inject({
      method: "POST",
      url: `/api/community/upload-sessions/${encodeURIComponent(currentSessionId)}/complete`,
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(complete.statusCode, 200, complete.body);

    const asset = await prisma.communityPostAsset.findFirst({ where: { postId: post.id } });
    assert.ok(asset?.thumbnailObjectKey);
    await prisma.communityPost.update({ where: { id: post.id }, data: { status: "published", publishedAt: new Date() } });
    await prisma.communityPostAsset.update({ where: { id: asset!.id }, data: { moderationStatus: "approved" } });

    const readable = await app.inject({
      method: "GET",
      url: `/api/community/posts/${encodeURIComponent(post.id)}/assets/${encodeURIComponent(asset!.id)}/image`,
    });
    assert.equal(readable.statusCode, 200, readable.body);

    await prisma.communityPost.update({ where: { id: post.id }, data: { status: "hidden" } });
    const hidden = await app.inject({
      method: "GET",
      url: `/api/community/posts/${encodeURIComponent(post.id)}/assets/${encodeURIComponent(asset!.id)}/image`,
    });
    assert.equal(hidden.statusCode, 404, hidden.body);

    const crossPost = await app.inject({
      method: "GET",
      url: `/api/community/posts/${encodeURIComponent("00000000-0000-0000-0000-000000000000")}/assets/${encodeURIComponent(asset!.id)}/image`,
    });
    assert.equal(crossPost.statusCode, 404, crossPost.body);
  } finally {
    globalThis.fetch = originalFetch;
    restoreS3();
    await app.close();
  }
});

test("community video multipart upload is controlled and playback requires published approved ready asset", { concurrency: false }, async () => {
  const app = await createApp(prisma);
  let currentSessionId = "";
  const restoreS3 = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "CreateMultipartUploadCommand") return { UploadId: "community-upload-1" };
    if (name === "ListPartsCommand") return { Parts: [{ PartNumber: 1, ETag: '"etag-1"', Size: 4096 }], IsTruncated: false };
    if (name === "CompleteMultipartUploadCommand") return {};
    if (name === "HeadObjectCommand") {
      return {
        ContentLength: 4096,
        ContentType: "video/mp4",
        Metadata: { uploadsessionid: currentSessionId, sha256: "C".repeat(44) },
      };
    }
    if (name === "GetObjectCommand") return { Body: Readable.from(Buffer.from("mock-video-source")) };
    if (name === "PutObjectCommand") return {};
    return undefined;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("#EXTM3U\nseg-000.ts\n", { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
  try {
    const author = await createUser(prisma, "社区作者视频 C");
    const post = await prisma.communityPost.create({
      data: {
        authorId: author.id,
        body: "待审视频帖子",
        status: "pending",
      },
    });
    const authorCookie = await loginUser(app, author.id);
    const init = await app.inject({
      method: "POST",
      url: `/api/community/posts/${encodeURIComponent(post.id)}/assets/upload-session`,
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: { kind: "video", filename: "clip.mp4", mimeType: "video/mp4", byteSize: 4096, sha256: "C".repeat(44) },
    });
    assert.equal(init.statusCode, 200, init.body);
    const initBody = init.json() as any;
    currentSessionId = initBody.uploadSessionId;
    assert.equal(initBody.uploadMode, "multipart");

    const sign = await app.inject({
      method: "POST",
      url: `/api/community/upload-sessions/${encodeURIComponent(currentSessionId)}/parts/1/sign`,
      headers: { cookie: authorCookie },
    });
    assert.equal(sign.statusCode, 200, sign.body);

    const recordPart = await app.inject({
      method: "POST",
      url: `/api/community/upload-sessions/${encodeURIComponent(currentSessionId)}/parts/1/complete`,
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: { etag: "etag-1", bytes: 4096 },
    });
    assert.equal(recordPart.statusCode, 200, recordPart.body);

    const complete = await app.inject({
      method: "POST",
      url: `/api/community/upload-sessions/${encodeURIComponent(currentSessionId)}/complete`,
      headers: { cookie: authorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(complete.statusCode, 200, complete.body);
    const asset = await prisma.communityPostAsset.findFirst({ where: { postId: post.id } });
    assert.ok(asset);
    assert.equal(asset?.transcodeStatus, "pending");

    const beforeReady = await app.inject({
      method: "GET",
      url: `/api/community/media/${encodeURIComponent(post.id)}/videos/${encodeURIComponent(asset!.id)}/master.m3u8`,
    });
    assert.equal(beforeReady.statusCode, 404, beforeReady.body);

    await processCommunityVideoAsset(prisma as any, asset!.id, {
      runnerMode: "mock",
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      ffmpegTimeoutMs: 1000,
      ffprobeTimeoutMs: 1000,
      tmpDir: "C:/Temp",
    });
    await prisma.communityPost.update({ where: { id: post.id }, data: { status: "published", publishedAt: new Date() } });
    await prisma.communityPostAsset.update({ where: { id: asset!.id }, data: { moderationStatus: "approved" } });

    const manifest = await app.inject({
      method: "GET",
      url: `/api/community/media/${encodeURIComponent(post.id)}/videos/${encodeURIComponent(asset!.id)}/master.m3u8`,
    });
    assert.equal(manifest.statusCode, 200, manifest.body);
    assert.match(manifest.body, new RegExp(`/community/media/${post.id}/videos/${asset!.id}/seg-000\\.ts`));

    const segment = await app.inject({
      method: "GET",
      url: `/api/community/media/${encodeURIComponent(post.id)}/videos/${encodeURIComponent(asset!.id)}/seg-000.ts`,
    });
    assert.equal(segment.statusCode, 200, segment.body);

    await prisma.communityPost.update({ where: { id: post.id }, data: { status: "removed" } });
    const removed = await app.inject({
      method: "GET",
      url: `/api/community/media/${encodeURIComponent(post.id)}/videos/${encodeURIComponent(asset!.id)}/master.m3u8`,
    });
    assert.equal(removed.statusCode, 404, removed.body);
  } finally {
    globalThis.fetch = originalFetch;
    restoreS3();
    await app.close();
  }
});
