import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import adminRoutes from "../src/routes/admin.js";
import adminCmsRoutes from "../src/routes/adminCms.js";
import { runUploadSessionCleanupSweep } from "../src/services/uploadSessionCleanup.js";
import {
  setupTestHarness,
  teardownTestHarness,
  seedTestData,
  TEST_CREDENTIALS,
  TEST_KNOWN_IDS,
} from "./_testHarness.js";
import { getS3Client, generatePrivateObjectKey } from "../src/services/objectStorage.js";

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

function installS3CommandMock(factory: (command: any) => any) {
  const client = getS3Client() as any;
  const originalSend = client.send.bind(client);
  client.send = async (command: any) => {
    const mocked = await factory(command);
    if (typeof mocked !== "undefined") {
      return mocked;
    }
    return originalSend(command);
  };
  return () => {
    client.send = originalSend;
  };
}

function installHeadObjectMock(factory: (command: any) => any) {
  return installS3CommandMock((command) => {
    if (command?.constructor?.name === "HeadObjectCommand") {
      return factory(command);
    }
    return undefined;
  });
}

process.env.OBJECT_STORAGE_ENDPOINT = process.env.OBJECT_STORAGE_ENDPOINT || "https://example-object-storage.local";
process.env.OBJECT_STORAGE_REGION = process.env.OBJECT_STORAGE_REGION || "local";
process.env.OBJECT_STORAGE_BUCKET = process.env.OBJECT_STORAGE_BUCKET || "intune-test-private";
process.env.OBJECT_STORAGE_ACCESS_KEY = process.env.OBJECT_STORAGE_ACCESS_KEY || "test-access";
process.env.OBJECT_STORAGE_SECRET_KEY = process.env.OBJECT_STORAGE_SECRET_KEY || "test-secret";
const VALID_SHA256_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

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

test("Phase A: legacy single-upload endpoint only allows cover and preview, never full video", async () => {
  const app = await createApp(prisma);
  try {
    const noAuth = await app.inject({
      method: "POST",
      url: "/api/admin/media/init-upload",
      headers: { "Content-Type": "application/json" },
      payload: {
        kind: "cover_image",
        originalFilename: "cover.jpg",
        mimeType: "image/jpeg",
        contentLength: 1024,
      },
    });
    assert.equal(noAuth.statusCode, 401, noAuth.body);

    const csCookie = await loginAdmin(app, "customerService");
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/media/init-upload",
      headers: { cookie: csCookie, "Content-Type": "application/json" },
      payload: {
        kind: "cover_image",
        originalFilename: "cover.jpg",
        mimeType: "image/jpeg",
        contentLength: 1024,
      },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);

    const editorCookie = await loginAdmin(app, "editor");
    const fullVideo = await app.inject({
      method: "POST",
      url: "/api/admin/media/init-upload",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        kind: "full_video",
        originalFilename: "full.mp4",
        mimeType: "video/mp4",
        contentLength: 1024,
        durationSeconds: 60,
      },
    });
    assert.equal(fullVideo.statusCode, 409, fullVideo.body);
    assert.equal((fullVideo.json() as any).error, "multipart_required");

    const coverResp = await app.inject({
      method: "POST",
      url: "/api/admin/media/init-upload",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        kind: "cover_image",
        originalFilename: "cover.jpg",
        mimeType: "image/jpeg",
        contentLength: 1024,
      },
    });
    assert.equal(coverResp.statusCode, 200, coverResp.body);

    const previewResp = await app.inject({
      method: "POST",
      url: "/api/admin/media/init-upload",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        kind: "preview_video",
        originalFilename: "preview.mp4",
        mimeType: "video/mp4",
        contentLength: 1024 * 1024,
        durationSeconds: 60,
      },
    });
    assert.equal(previewResp.statusCode, 200, previewResp.body);
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

test("Phase A: watch progress keeps one row per user and content for resume reads", async () => {
  const user = await prisma.user.create({
    data: {
      telegramUserId: BigInt(900000000001),
      displayName: "Phase A Watch Progress",
      status: "active",
    },
  });
  const userId = user.id;
  const contentId = TEST_KNOWN_IDS.contentMembership;

  await prisma.watchProgress.create({
    data: {
      userId,
      contentId,
      positionSec: 42,
      durationSec: 600,
      lastPlayedAt: new Date("2026-08-25T12:00:00.000Z"),
    },
  });

  await prisma.watchProgress.upsert({
    where: { userId_contentId: { userId, contentId } },
    update: {
      positionSec: 128,
      durationSec: 600,
      lastPlayedAt: new Date("2026-08-25T12:05:00.000Z"),
      completedAt: new Date("2026-08-25T12:09:30.000Z"),
    },
    create: {
      userId,
      contentId,
      positionSec: 128,
      durationSec: 600,
      lastPlayedAt: new Date("2026-08-25T12:05:00.000Z"),
      completedAt: new Date("2026-08-25T12:09:30.000Z"),
    },
  });

  const rows = await prisma.watchProgress.findMany({ where: { userId, contentId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].positionSec, 128);
  assert.equal(rows[0].durationSec, 600);
  assert.ok(rows[0].completedAt instanceof Date);
});

test("Phase A: multipart session syncs uploaded parts and supports pause, resume, and abort", async () => {
  const app = await createApp(prisma);
  let uploadSessionId = "";
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "CreateMultipartUploadCommand") {
      return { UploadId: "upload-xyz" };
    }
    if (name === "ListPartsCommand") {
      return {
        IsTruncated: false,
        Parts: [
          { PartNumber: 1, ETag: "\"etag-part-1\"", Size: 33554432 },
          { PartNumber: 2, ETag: "\"etag-part-2\"", Size: 1234567 },
        ],
      };
    }
    if (name === "AbortMultipartUploadCommand") {
      return {};
    }
    return undefined;
  });
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const initResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/multipart/initiate`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        assetKind: "full_source",
        filename: "full-big.mp4",
        mimeType: "video/mp4",
        byteSize: String(33554432 + 1234567),
        sha256: "f".repeat(64),
      },
    });
    assert.equal(initResp.statusCode, 200, initResp.body);
    uploadSessionId = (initResp.json() as any).uploadSessionId as string;

    const signResp = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/parts/2/sign`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { checksumSha256: VALID_SHA256_BASE64 },
    });
    assert.equal(signResp.statusCode, 200, signResp.body);

    const getResp = await app.inject({
      method: "GET",
      url: `/api/admin/upload-sessions/${uploadSessionId}`,
      headers: { cookie: editorCookie },
    });
    assert.equal(getResp.statusCode, 200, getResp.body);
    const sessionBody = getResp.json() as any;
    assert.equal(sessionBody.session.parts.length, 2);
    assert.equal(sessionBody.session.parts[0].etag, "etag-part-1");
    assert.equal(sessionBody.session.parts[1].etag, "etag-part-2");

    const paused = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/pause`,
      headers: { cookie: editorCookie },
    });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal((paused.json() as any).session.status, "paused");

    const resumed = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/resume`,
      headers: { cookie: editorCookie },
    });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal((resumed.json() as any).session.status, "uploading");

    const aborted = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/abort`,
      headers: { cookie: editorCookie },
    });
    assert.equal(aborted.statusCode, 200, aborted.body);
    assert.equal((aborted.json() as any).session.status, "cancelled");

    const row = await prisma.uploadSession.findUnique({
      where: { id: uploadSessionId },
      include: { parts: { orderBy: { partNumber: "asc" } } },
    });
    assert.equal(row?.parts.length, 2);
    assert.equal(row?.status, "cancelled");
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: multipart part sign rejects malformed checksum format", async () => {
  const app = await createApp(prisma);
  const restore = installS3CommandMock((command) => {
    if (command?.constructor?.name === "CreateMultipartUploadCommand") {
      return { UploadId: "upload-checksum" };
    }
    return undefined;
  });
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const initResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/multipart/initiate`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        assetKind: "full_source",
        filename: "checksum.mp4",
        mimeType: "video/mp4",
        byteSize: 2048,
        sha256: "f".repeat(64),
      },
    });
    assert.equal(initResp.statusCode, 200, initResp.body);
    const uploadSessionId = (initResp.json() as any).uploadSessionId as string;

    const invalid = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/parts/1/sign`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { checksumSha256: "not_base64_checksum" },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: expired multipart sessions are aborted and marked expired by cleanup sweep", async () => {
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "AbortMultipartUploadCommand") {
      return {};
    }
    return undefined;
  });
  try {
    await prisma.uploadSession.create({
      data: {
        id: "11111111-2222-4333-8444-555555555555",
        contentId: TEST_KNOWN_IDS.contentDraft,
        assetKind: "full_source",
        status: "paused",
        objectKey: generatePrivateObjectKey("full_source", TEST_KNOWN_IDS.contentDraft, "11111111-2222-4333-8444-555555555555", "test-expired.mp4"),
        originalFilename: "test-expired.mp4",
        expectedSize: 1024n,
        expectedMime: "video/mp4",
        expectedSha256: "c".repeat(64),
        storageUploadId: "expired-upload-id",
        partSize: 33554432,
        totalParts: 1,
        uploadedBytes: 512n,
        expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        lastActivityAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });

    const sweep = await runUploadSessionCleanupSweep(prisma as any);
    assert.ok(sweep.expired >= 1);
    assert.ok(sweep.aborted >= 1);
    assert.equal(sweep.failed, 0);

    const expired = await prisma.uploadSession.findUnique({
      where: { id: "11111111-2222-4333-8444-555555555555" },
    });
    assert.equal(expired?.status, "expired");
  } finally {
    restore();
  }
});

test("Phase A: multipart complete reports missing parts without finalizing session", async () => {
  const app = await createApp(prisma);
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "CreateMultipartUploadCommand") {
      return { UploadId: "upload-missing-part" };
    }
    if (name === "ListPartsCommand") {
      return {
        IsTruncated: false,
        Parts: [{ PartNumber: 1, ETag: "\"etag-only-one\"", Size: 1024 }],
      };
    }
    return undefined;
  });
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const initResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/multipart/initiate`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "full_source", filename: "missing-part.mp4", mimeType: "video/mp4", byteSize: String(33 * 1024 * 1024), sha256: "f".repeat(64) },
    });
    assert.equal(initResp.statusCode, 200, initResp.body);
    const uploadSessionId = (initResp.json() as any).uploadSessionId as string;

    await prisma.uploadSession.update({
      where: { id: uploadSessionId },
      data: { totalParts: 2 },
    });

    const completeResp = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(completeResp.statusCode, 409, completeResp.body);
    assert.deepEqual((completeResp.json() as any).missingParts, [2]);
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: multipart complete failure from invalid part etag restores session and stays retryable", async () => {
  const app = await createApp(prisma);
  let uploadSessionId = "";
  let completeAttempts = 0;
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "CreateMultipartUploadCommand") {
      return { UploadId: "upload-invalid-etag" };
    }
    if (name === "ListPartsCommand") {
      return {
        IsTruncated: false,
        Parts: [{ PartNumber: 1, ETag: "\"etag-retry\"", Size: 1024 }],
      };
    }
    if (name === "CompleteMultipartUploadCommand") {
      completeAttempts += 1;
      if (completeAttempts === 1) {
        const err: any = new Error("InvalidPart");
        err.name = "InvalidPart";
        throw err;
      }
      return { ETag: "\"final-etag\"" };
    }
    if (name === "HeadObjectCommand") {
      if (completeAttempts === 1) {
        const err: any = new Error("NotFound");
        err.name = "NotFound";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {
        ContentLength: 1024,
        ContentType: "video/mp4",
        Metadata: { uploadsessionid: uploadSessionId, sha256: "f".repeat(64) },
        ETag: "\"etag-retry\"",
      };
    }
    return undefined;
  });
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const initResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/multipart/initiate`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "full_source", filename: "retry.mp4", mimeType: "video/mp4", byteSize: 1024, sha256: "f".repeat(64) },
    });
    assert.equal(initResp.statusCode, 200, initResp.body);
    uploadSessionId = (initResp.json() as any).uploadSessionId as string;

    const first = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(first.statusCode, 503, first.body);
    assert.equal((first.json() as any).error, "object_storage_unavailable");

    const sessionAfterFailure = await prisma.uploadSession.findUnique({ where: { id: uploadSessionId } });
    assert.equal(sessionAfterFailure?.status, "paused");

    const second = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(second.statusCode, 200, second.body);
    const assets = await prisma.videoAsset.findMany({ where: { uploadSessionId } });
    assert.equal(assets.length, 1);
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: multipart complete is idempotent when remote object exists after response loss", async () => {
  const app = await createApp(prisma);
  let uploadSessionId = "";
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "CreateMultipartUploadCommand") {
      return { UploadId: "upload-response-loss" };
    }
    if (name === "ListPartsCommand") {
      return {
        IsTruncated: false,
        Parts: [{ PartNumber: 1, ETag: "\"etag-loss\"", Size: 1024 }],
      };
    }
    if (name === "CompleteMultipartUploadCommand") {
      const err: any = new Error("socket hang up");
      err.name = "NetworkingError";
      throw err;
    }
    if (name === "HeadObjectCommand") {
      return {
        ContentLength: 1024,
        ContentType: "video/mp4",
        Metadata: { uploadsessionid: uploadSessionId, sha256: "f".repeat(64) },
        ETag: "\"etag-loss\"",
      };
    }
    return undefined;
  });
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const initResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/multipart/initiate`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "full_source", filename: "response-loss.mp4", mimeType: "video/mp4", byteSize: 1024, sha256: "f".repeat(64) },
    });
    assert.equal(initResp.statusCode, 200, initResp.body);
    uploadSessionId = (initResp.json() as any).uploadSessionId as string;

    const completeResp = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(completeResp.statusCode, 200, completeResp.body);
    const assets = await prisma.videoAsset.findMany({ where: { uploadSessionId } });
    const jobs = await prisma.transcodeJob.findMany({ where: { assetId: assets[0].id } });
    assert.equal(assets.length, 1);
    assert.equal(jobs.length, 1);
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: multipart complete is concurrency-idempotent and creates one asset, one job, and one audit record", async () => {
  const app = await createApp(prisma);
  let uploadSessionId = "";
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "CreateMultipartUploadCommand") {
      return { UploadId: "upload-concurrent" };
    }
    if (name === "ListPartsCommand") {
      return {
        IsTruncated: false,
        Parts: [{ PartNumber: 1, ETag: "\"etag-ok\"", Size: 1024 }],
      };
    }
    if (name === "CompleteMultipartUploadCommand") {
      return { ETag: "\"final-etag\"" };
    }
    if (name === "HeadObjectCommand") {
      return {
        ContentLength: 1024,
        ContentType: "video/mp4",
        Metadata: { uploadsessionid: uploadSessionId, sha256: "f".repeat(64) },
        ETag: "\"etag-ok\"",
      };
    }
    return undefined;
  });
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const initResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/multipart/initiate`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "full_source", filename: "full.mp4", mimeType: "video/mp4", byteSize: 1024, sha256: "f".repeat(64) },
    });
    assert.equal(initResp.statusCode, 200, initResp.body);
    uploadSessionId = (initResp.json() as any).uploadSessionId as string;

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/admin/upload-sessions/${uploadSessionId}/complete`,
        headers: { cookie: editorCookie, "Content-Type": "application/json" },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: `/api/admin/upload-sessions/${uploadSessionId}/complete`,
        headers: { cookie: editorCookie, "Content-Type": "application/json" },
        payload: {},
      }),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);

    const assets = await prisma.videoAsset.findMany({ where: { uploadSessionId } });
    assert.equal(assets.length, 1);
    const jobs = await prisma.transcodeJob.findMany({ where: { assetId: assets[0].id } });
    assert.equal(jobs.length, 1);
    const audits = await prisma.adminAuditLog.findMany({
      where: {
        action: "vod.multipart.complete",
        objectType: "video_asset",
        objectId: assets[0].id,
      },
    });
    assert.equal(audits.length, 1);
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: repeated multipart complete stays idempotent after first success", async () => {
  const app = await createApp(prisma);
  let uploadSessionId = "";
  let completeCalls = 0;
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "CreateMultipartUploadCommand") {
      return { UploadId: "upload-repeat-complete" };
    }
    if (name === "ListPartsCommand") {
      return {
        IsTruncated: false,
        Parts: [{ PartNumber: 1, ETag: "\"etag-repeat\"", Size: 1024 }],
      };
    }
    if (name === "CompleteMultipartUploadCommand") {
      completeCalls += 1;
      return { ETag: "\"etag-repeat\"" };
    }
    if (name === "HeadObjectCommand") {
      return {
        ContentLength: 1024,
        ContentType: "video/mp4",
        Metadata: { uploadsessionid: uploadSessionId, sha256: "f".repeat(64) },
        ETag: "\"etag-repeat\"",
      };
    }
    return undefined;
  });
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const initResp = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${TEST_KNOWN_IDS.contentDraft}/assets/multipart/initiate`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "full_source", filename: "repeat.mp4", mimeType: "video/mp4", byteSize: 1024, sha256: "f".repeat(64) },
    });
    assert.equal(initResp.statusCode, 200, initResp.body);
    uploadSessionId = (initResp.json() as any).uploadSessionId as string;

    const first = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${uploadSessionId}/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    const assets = await prisma.videoAsset.findMany({ where: { uploadSessionId } });
    const jobs = await prisma.transcodeJob.findMany({ where: { assetId: assets[0].id } });
    assert.equal(assets.length, 1);
    assert.equal(jobs.length, 1);
    assert.equal(completeCalls, 1);
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: multipart full video auto-binds content and publish jobs reference video assets", async () => {
  const app = await createApp(prisma);
  let membershipSessionId = "";
  let packageSessionId = "";
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    if (name === "CreateMultipartUploadCommand") {
      const key = String(command?.input?.Key || "");
      if (key.includes("membership")) return { UploadId: "upload-membership" };
      if (key.includes("package")) return { UploadId: "upload-package" };
      return { UploadId: "upload-generic" };
    }
    if (name === "ListPartsCommand") {
      const uploadId = String(command?.input?.UploadId || "");
      return {
        IsTruncated: false,
        Parts: [{ PartNumber: 1, ETag: uploadId === "upload-membership" ? "\"etag-membership\"" : "\"etag-package\"", Size: 1024 }],
      };
    }
    if (name === "CompleteMultipartUploadCommand") {
      return { ETag: "\"final\"" };
    }
    if (name === "HeadObjectCommand") {
      const key = String(command?.input?.Key || "");
      if (key.includes("membership")) {
        return {
          ContentLength: 1024,
          ContentType: "video/mp4",
          Metadata: { uploadsessionid: membershipSessionId, sha256: "f".repeat(64) },
          ETag: "\"etag-membership\"",
        };
      }
      return {
        ContentLength: 1024,
        ContentType: "video/mp4",
        Metadata: { uploadsessionid: packageSessionId, sha256: "e".repeat(64) },
        ETag: "\"etag-package\"",
      };
    }
    return undefined;
  });
  try {
    const editorCookie = await loginAdmin(app, "editor");
    await prisma.contentPackage.update({
      where: { id: TEST_KNOWN_IDS.contentPackageKey },
      data: { channelId: BigInt(-1002003004005) },
    });

    const membershipCreate = await app.inject({
      method: "POST",
      url: "/api/admin/contents",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        title: "multipart membership draft",
        accessType: "membership",
        reason: "create membership draft for multipart binding",
      },
    });
    assert.equal(membershipCreate.statusCode, 201, membershipCreate.body);
    const membershipContentId = (membershipCreate.json() as any).id as string;

    const packageCreate = await app.inject({
      method: "POST",
      url: "/api/admin/contents",
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {
        title: "multipart package draft",
        accessType: "package",
        packageId: TEST_KNOWN_IDS.contentPackageKey,
        reason: "create package draft for multipart binding",
      },
    });
    assert.equal(packageCreate.statusCode, 201, packageCreate.body);
    const packageContentId = (packageCreate.json() as any).id as string;

    const membershipInit = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${membershipContentId}/assets/multipart/initiate`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "full_source", filename: "membership-full.mp4", mimeType: "video/mp4", byteSize: 1024, sha256: "f".repeat(64) },
    });
    assert.equal(membershipInit.statusCode, 200, membershipInit.body);
    membershipSessionId = (membershipInit.json() as any).uploadSessionId as string;

    const packageInit = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${packageContentId}/assets/multipart/initiate`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { assetKind: "full_source", filename: "package-full.mp4", mimeType: "video/mp4", byteSize: 1024, sha256: "e".repeat(64) },
    });
    assert.equal(packageInit.statusCode, 200, packageInit.body);
    packageSessionId = (packageInit.json() as any).uploadSessionId as string;

    const membershipComplete = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${membershipSessionId}/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(membershipComplete.statusCode, 200, membershipComplete.body);
    const membershipAssetId = (membershipComplete.json() as any).asset.id as string;

    const packageComplete = await app.inject({
      method: "POST",
      url: `/api/admin/upload-sessions/${packageSessionId}/complete`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: {},
    });
    assert.equal(packageComplete.statusCode, 200, packageComplete.body);
    const packageAssetId = (packageComplete.json() as any).asset.id as string;

    const membershipDetail = await app.inject({
      method: "GET",
      url: `/api/admin/contents/${membershipContentId}`,
      headers: { cookie: editorCookie },
    });
    assert.equal(membershipDetail.statusCode, 200, membershipDetail.body);
    const membershipBody = membershipDetail.json() as any;
    assert.equal(membershipBody.fullVideoAssetId, membershipAssetId);
    assert.deepEqual((membershipBody.fullVideoSegments || []).map((segment: any) => segment.videoAssetId), [membershipAssetId]);

    const packageDetail = await app.inject({
      method: "GET",
      url: `/api/admin/contents/${packageContentId}`,
      headers: { cookie: editorCookie },
    });
    assert.equal(packageDetail.statusCode, 200, packageDetail.body);
    const packageBody = packageDetail.json() as any;
    assert.equal(packageBody.fullVideoAssetId, packageAssetId);
    assert.deepEqual((packageBody.fullVideoSegments || []).map((segment: any) => segment.videoAssetId), [packageAssetId]);

    const membershipPublish = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${membershipContentId}/start-telegram-publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { channelKinds: ["membership_full"], reason: "membership publish should reference video asset" },
    });
    assert.equal(membershipPublish.statusCode, 201, membershipPublish.body);
    assert.equal((membershipPublish.json() as any).jobs[0].videoAssetId, membershipAssetId);

    const packagePublish = await app.inject({
      method: "POST",
      url: `/api/admin/contents/${packageContentId}/start-telegram-publish`,
      headers: { cookie: editorCookie, "Content-Type": "application/json" },
      payload: { channelKinds: ["package_full"], reason: "package publish should reference video asset" },
    });
    assert.equal(packagePublish.statusCode, 201, packagePublish.body);
    assert.equal((packagePublish.json() as any).jobs[0].videoAssetId, packageAssetId);

    const storedJobs = await prisma.telegramPublishJob.findMany({
      where: { contentId: { in: [membershipContentId, packageContentId] } },
      orderBy: [{ contentId: "asc" }],
      select: { contentId: true, mediaAssetId: true, videoAssetId: true, channelKind: true },
    });
    const sortByDeliveryKind = (rows: Array<{ contentId: string | null; mediaAssetId: string | null; videoAssetId: string | null; channelKind: string }>) =>
      rows.slice().sort((left, right) => {
        const rank = (channelKind: string) => {
          switch (channelKind) {
            case "membership_full":
              return 1;
            case "package_full":
              return 2;
            default:
              return 9;
          }
        };
        return rank(left.channelKind) - rank(right.channelKind) || String(left.contentId || "").localeCompare(String(right.contentId || ""));
      });
    assert.deepEqual(
      sortByDeliveryKind(storedJobs.map((job) => ({
        contentId: job.contentId,
        mediaAssetId: job.mediaAssetId,
        videoAssetId: job.videoAssetId,
        channelKind: job.channelKind,
      }))),
      sortByDeliveryKind([
        { contentId: membershipContentId, mediaAssetId: null, videoAssetId: membershipAssetId, channelKind: "membership_full" },
        { contentId: packageContentId, mediaAssetId: null, videoAssetId: packageAssetId, channelKind: "package_full" },
      ]),
    );
  } finally {
    restore();
    await app.close();
  }
});

test("Phase A: media list response omits storage keys, bucket names, URLs, and secrets while serializing BigInt safely", async () => {
  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const cover = await prisma.mediaAsset.create({
      data: {
        kind: "cover_image",
        status: "ready",
        originalFilename: "cover.jpg",
        mimeType: "image/jpeg",
        contentLength: 1024n,
        storageBucket: "private-bucket-name",
        storageKey: "covers/internal-key.jpg",
        storagePublicUrl: "https://example.invalid/covers/internal-key.jpg",
        lastVerifiedAt: new Date(),
      },
    });
    await prisma.content.update({
      where: { id: TEST_KNOWN_IDS.contentDraft },
      data: { coverAssetId: cover.id },
    });
    const vodCover = await prisma.videoAsset.create({
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
    const coverItem = body.items.find((item: any) => item.id === cover.id);
    assert.equal(coverItem?.previewPath, `/api/admin/media/${cover.id}/preview`);
    assert.doesNotMatch(JSON.stringify(coverItem), /example\.invalid|internal-key|private-bucket/i);
    const vodCoverItem = body.items.find((item: any) => item.id === vodCover.id);
    assert.equal(vodCoverItem?.source, "vod");
    assert.equal(vodCoverItem?.previewPath, `/api/admin/vod-assets/${vodCover.id}/preview`);
    assert.doesNotMatch(JSON.stringify(vodCoverItem), /test-session|objectKey|private-bucket/i);
    const previewResp = await app.inject({
      method: "GET",
      url: `/api/admin/media/${cover.id}/preview`,
      headers: { cookie: editorCookie },
    });
    assert.equal(previewResp.statusCode, 302, previewResp.body);
    const vodPreviewResp = await app.inject({
      method: "GET",
      url: `/api/admin/vod-assets/${vodCover.id}/preview`,
      headers: { cookie: editorCookie },
    });
    assert.equal(vodPreviewResp.statusCode, 302, vodPreviewResp.body);
  } finally {
    await app.close();
  }
});
