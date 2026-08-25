import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import adminRoutes from "../src/routes/admin.js";
import adminCmsRoutes from "../src/routes/adminCms.js";
import {
  setupTestHarness,
  teardownTestHarness,
  seedTestData,
  TEST_CREDENTIALS,
  TEST_KNOWN_IDS,
} from "./_testHarness.js";
import { getS3Client } from "../src/services/objectStorage.js";

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
  await app.register(adminCmsRoutes, { prefix: "/api" });
  return app;
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

function installHeadObjectMock(factory: (command: any) => any) {
  const client = getS3Client() as any;
  const originalSend = client.send.bind(client);
  client.send = async (command: any) => {
    if (command?.constructor?.name === "HeadObjectCommand") {
      return factory(command);
    }
    return originalSend(command);
  };
  return () => {
    client.send = originalSend;
  };
}

process.env.OBJECT_STORAGE_ENDPOINT = process.env.OBJECT_STORAGE_ENDPOINT || "https://example-object-storage.local";
process.env.OBJECT_STORAGE_REGION = process.env.OBJECT_STORAGE_REGION || "local";
process.env.OBJECT_STORAGE_BUCKET = process.env.OBJECT_STORAGE_BUCKET || "intune-test-private";
process.env.OBJECT_STORAGE_ACCESS_KEY = process.env.OBJECT_STORAGE_ACCESS_KEY || "test-access";
process.env.OBJECT_STORAGE_SECRET_KEY = process.env.OBJECT_STORAGE_SECRET_KEY || "test-secret";

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("Phase A: upload-session unauthorized and forbidden requests are rejected", async () => {
  const app = await createApp(prisma);
  try {
    const noAuth = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/upload-session`,
      headers: { "Content-Type": "application/json" },
      payload: { assetKind: "cover", filename: "cover.jpg", mimeType: "image/jpeg", byteSize: 1024, sha256: "a".repeat(64) },
    });
    assert.equal(noAuth.statusCode, 401, noAuth.body);

    const csCookie = await loginAdmin(app, "customerService");
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/upload-session`,
      headers: { cookie: csCookie, "Content-Type": "application/json" },
      payload: { assetKind: "cover", filename: "cover.jpg", mimeType: "image/jpeg", byteSize: 1024, sha256: "a".repeat(64) },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
  } finally {
    await app.close();
  }
});

test("Phase A: upload-session rejects invalid MIME, oversize, and missing content", async () => {
  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");

    const invalidMime = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/upload-session`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "cover", filename: "cover.mp4", mimeType: "video/mp4", byteSize: 1024, sha256: "a".repeat(64) },
    });
    assert.equal(invalidMime.statusCode, 400, invalidMime.body);

    const oversized = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/upload-session`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "preview_source", filename: "preview.mp4", mimeType: "video/mp4", byteSize: String(2n * 1024n * 1024n * 1024n), sha256: "b".repeat(64) },
    });
    assert.equal(oversized.statusCode, 400, oversized.body);

    const missing = await app.inject({
      method: "POST",
      url: "/api/admin/contents/00000000-0000-0000-0000-000000000000/assets/upload-session",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "cover", filename: "cover.jpg", mimeType: "image/jpeg", byteSize: 1024, sha256: "c".repeat(64) },
    });
    assert.equal(missing.statusCode, 404, missing.body);
  } finally {
    await app.close();
  }
});

test("Phase A: complete rejects expired and cross-content upload sessions", async () => {
  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const createResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/upload-session`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "cover", filename: "cover.jpg", mimeType: "image/jpeg", byteSize: 1024, sha256: "d".repeat(64) },
    });
    assert.equal(createResp.statusCode, 200, createResp.body);
    const uploadSessionId = (createResp.json() as any).uploadSessionId as string;

    const crossContent = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentPublic}/assets/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { uploadSessionId },
    });
    assert.equal(crossContent.statusCode, 409, crossContent.body);

    await prisma.uploadSession.update({
      where: { id: uploadSessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const expired = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { uploadSessionId },
    });
    assert.equal(expired.statusCode, 409, expired.body);
  } finally {
    await app.close();
  }
});

test("Phase A: complete rejects metadata mismatch and leaves no asset or transcode job dirty write", async () => {
  const app = await createApp(prisma);
  const restore = installHeadObjectMock(() => ({
    ContentLength: 2048,
    ContentType: "video/mp4",
    Metadata: { uploadsessionid: "wrong-session", sha256: "e".repeat(64) },
    ChecksumSHA256: "e".repeat(64),
    ETag: "\"etag-mismatch\"",
  }));
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const createResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/upload-session`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "preview_source", filename: "preview.mp4", mimeType: "video/mp4", byteSize: 1024, sha256: "e".repeat(64) },
    });
    assert.equal(createResp.statusCode, 200, createResp.body);
    const uploadSessionId = (createResp.json() as any).uploadSessionId as string;

    const completeResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { uploadSessionId, proof: { etag: "etag-mismatch" } },
    });
    assert.equal(completeResp.statusCode, 409, completeResp.body);

    const assetCount = await prisma.videoAsset.count({ where: { uploadSessionId } });
    const jobCount = await prisma.transcodeJob.count({
      where: { contentId: TEST_KNOWN_IDS.contentDraft },
    });
    assert.equal(assetCount, 0);
    assert.equal(jobCount, 0);
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: repeated complete is idempotent and creates at most one asset and one transcode job", async () => {
  const app = await createApp(prisma);
  let uploadSessionId = "";
  const restore = installHeadObjectMock(() => ({
    ContentLength: 1024,
    ContentType: "video/mp4",
    Metadata: { uploadsessionid: uploadSessionId, sha256: "f".repeat(64) },
    ChecksumSHA256: "f".repeat(64),
    ETag: "\"etag-ok\"",
  }));
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const createResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/upload-session`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "full_source", filename: "full.mp4", mimeType: "video/mp4", byteSize: 1024, sha256: "f".repeat(64) },
    });
    assert.equal(createResp.statusCode, 200, createResp.body);
    uploadSessionId = (createResp.json() as any).uploadSessionId as string;

    const first = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { uploadSessionId, proof: { etag: "etag-ok" } },
    });
    assert.equal(first.statusCode, 200, first.body);

    const second = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { uploadSessionId, proof: { etag: "etag-ok" } },
    });
    assert.equal(second.statusCode, 200, second.body);

    const assets = await prisma.videoAsset.findMany({ where: { uploadSessionId } });
    assert.equal(assets.length, 1);
    const jobs = await prisma.transcodeJob.findMany({ where: { assetId: assets[0].id } });
    assert.equal(jobs.length, 1);
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: media list response omits storage keys, bucket names, URLs, and secrets while serializing BigInt safely", async () => {
  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    await prisma.videoAsset.create({
      data: {
        contentId: TEST_KNOWN_IDS.contentDraft,
        kind: "cover",
        objectKey: "covers/topic-03-draft/test-session/cover.jpg",
        originalFilename: "cover-super-long-file-name-for-sanitization-preview.jpg",
        mimeType: "image/jpeg",
        byteSize: 9876543210n,
        sha256: "1".repeat(64),
        status: "verified",
        verifiedAt: new Date(),
      },
    });
    const mediaResp = await app.inject({
      method: "GET",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/media`,
      headers: { cookie: editorCookie },
    });
    assert.equal(mediaResp.statusCode, 200, mediaResp.body);
    assert.doesNotMatch(mediaResp.body, /objectKey|storageKey|bucket|access|secret|https?:\/\//i);
    const body = mediaResp.json() as any;
    assert.ok(Array.isArray(body.items));
    assert.equal(typeof body.items[0].byteSize, "string");
  } finally {
    await app.close();
  }
});
