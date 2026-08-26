import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";

import adminRoutes from "../src/routes/admin.js";
import adminCmsRoutes from "../src/routes/adminCms.js";
import {
  claimNextTranscodeJob,
  createFfmpegTranscodeRunner,
  defaultMockTranscodeRunner,
  inspectLocalRendition,
  processClaimedTranscodeJob,
  requeueExpiredTranscodeJobs,
  type TranscodeRunner,
  type TranscodeWorkerConfig,
} from "../src/services/transcodeWorker.js";
import { getS3Client } from "../src/services/objectStorage.js";
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

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

process.env.OBJECT_STORAGE_ENDPOINT = process.env.OBJECT_STORAGE_ENDPOINT || "https://example-object-storage.local";
process.env.OBJECT_STORAGE_REGION = process.env.OBJECT_STORAGE_REGION || "local";
process.env.OBJECT_STORAGE_BUCKET = process.env.OBJECT_STORAGE_BUCKET || "intune-test-private";
process.env.OBJECT_STORAGE_ACCESS_KEY = process.env.OBJECT_STORAGE_ACCESS_KEY || "test-access";
process.env.OBJECT_STORAGE_SECRET_KEY = process.env.OBJECT_STORAGE_SECRET_KEY || "test-secret";

test.after(async () => {
  await teardownTestHarness(prisma);
});

test.afterEach(async () => {
  const assets = await prisma.videoAsset.findMany({
    where: {
      contentId: TEST_KNOWN_IDS.contentDraft,
      originalFilename: "source.mp4",
    },
    select: { id: true },
  });
  const assetIds = assets.map((item) => item.id);
  if (assetIds.length === 0) return;
  await prisma.videoRendition.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.transcodeJob.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.videoAsset.deleteMany({ where: { id: { in: assetIds } } });
});

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

function phaseBWorkerConfig(): TranscodeWorkerConfig {
  return {
    enabled: true,
    workerId: "worker-test",
    concurrency: 1,
    pollIntervalMs: 1000,
    leaseSeconds: 1800,
    maxAttempts: 3,
    previewSeconds: 60,
    tmpDir: "e:\\BDSM\\server\\tmp-test-transcode",
    ffprobePath: "ffprobe",
    ffmpegPath: "ffmpeg",
    ffprobeTimeoutMs: 60_000,
    ffmpegTimeoutMs: 60_000,
    runnerMode: "mock",
  };
}

function sortKinds(items: string[]) {
  return items.slice().sort((left, right) => left.localeCompare(right));
}

function hasExecutable(command: string) {
  try {
    const result = spawnSync(command, ["-version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function seedTranscodeJob(input?: Partial<{ contentId: string; assetId: string; status: string; attemptCount: number; leaseUntil: Date | null }>) {
  const asset = await prisma.videoAsset.create({
    data: {
      id: input?.assetId || randomUUID(),
      contentId: input?.contentId || TEST_KNOWN_IDS.contentDraft,
      kind: "full_source",
      objectKey: `originals/${TEST_KNOWN_IDS.contentDraft}/${randomUUID()}/source.mp4`,
      originalFilename: "source.mp4",
      mimeType: "video/mp4",
      byteSize: BigInt(1024),
      sha256: `sha-${randomUUID()}`,
      status: "verified",
      verifiedAt: new Date(),
    },
  });
  const job = await prisma.transcodeJob.create({
    data: {
      contentId: asset.contentId,
      assetId: asset.id,
      status: (input?.status as any) || "queued",
      attemptCount: input?.attemptCount ?? 0,
      leaseUntil: input?.leaseUntil ?? null,
    },
  });
  return { asset, job };
}

test("Phase B: two workers racing the same queued job only let one claim it", async () => {
  const { job } = await seedTranscodeJob();
  const [first, second] = await Promise.all([
    claimNextTranscodeJob(prisma, { workerId: "worker-a", leaseSeconds: 1800 }),
    claimNextTranscodeJob(prisma, { workerId: "worker-b", leaseSeconds: 1800 }),
  ]);
  const claimed = [first, second].filter(Boolean);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.id, job.id);
  const stored = await prisma.transcodeJob.findUnique({ where: { id: job.id } });
  assert.equal(stored?.status, "processing");
  assert.ok(stored?.workerId === "worker-a" || stored?.workerId === "worker-b");
});

test("Phase B: expired processing jobs requeue before exhaustion and fail after max attempts", async () => {
  const expiredQueued = await seedTranscodeJob({
    status: "processing",
    attemptCount: 1,
    leaseUntil: new Date(Date.now() - 60_000),
  });
  const exhausted = await seedTranscodeJob({
    status: "processing",
    attemptCount: 3,
    leaseUntil: new Date(Date.now() - 60_000),
  });

  const result = await requeueExpiredTranscodeJobs(prisma, { maxAttempts: 3 });
  assert.equal(result.requeued, 1);
  assert.equal(result.failed, 1);

  const refreshedQueued = await prisma.transcodeJob.findUnique({ where: { id: expiredQueued.job.id } });
  const refreshedFailed = await prisma.transcodeJob.findUnique({ where: { id: exhausted.job.id } });
  assert.equal(refreshedQueued?.status, "queued");
  assert.equal(refreshedFailed?.status, "failed");
  assert.equal(refreshedFailed?.errorClass, "worker_exhausted");
});

test("Phase B: admin retry and cancel endpoints keep responses sanitized", async () => {
  const { asset, job } = await seedTranscodeJob({ status: "failed", attemptCount: 3 });
  await prisma.videoRendition.create({
    data: {
      contentId: asset.contentId,
      assetId: asset.id,
      kind: "hls_720",
      status: "failed",
      manifestKey: "hls/private/master.m3u8",
      prefixKey: "hls/private",
      errorClass: "ffmpeg_failed",
      byteSize: BigInt(4096),
    },
  });

  const app = await createApp(prisma);
  try {
    const editorCookie = await loginAdmin(app, "editor");
    const retryResp = await app.inject({
      method: "POST",
      url: `/api/admin/transcode-jobs/${job.id}/retry`,
      headers: { cookie: editorCookie },
    });
    assert.equal(retryResp.statusCode, 200, retryResp.body);
    assert.doesNotMatch(retryResp.body, /manifestKey|prefixKey|objectKey|bucket|https?:\/\//i);
    const retried = await prisma.transcodeJob.findUnique({ where: { id: job.id } });
    assert.equal(retried?.status, "queued");

    await prisma.transcodeJob.update({
      where: { id: job.id },
      data: { status: "processing", workerId: "worker-a", leaseUntil: new Date(Date.now() + 60_000), progressPercent: 25 },
    });
    const cancelResp = await app.inject({
      method: "POST",
      url: `/api/admin/transcode-jobs/${job.id}/cancel`,
      headers: { cookie: editorCookie },
    });
    assert.equal(cancelResp.statusCode, 200, cancelResp.body);
    assert.doesNotMatch(cancelResp.body, /manifestKey|prefixKey|objectKey|bucket|https?:\/\//i);
    const cancelled = await prisma.transcodeJob.findUnique({ where: { id: job.id } });
    assert.equal(cancelled?.status, "cancelled");
  } finally {
    await app.close();
  }
});

test("Phase B: processing a claimed job stores ready private HLS renditions and cleans temp prefix", async () => {
  const store = new Map<string, Buffer>();
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    const key = String(command?.input?.Key || "");
    if (name === "GetObjectCommand") {
      return { Body: Readable.from([Buffer.from("source-video-data")]) };
    }
    if (name === "PutObjectCommand") {
      const body = Buffer.isBuffer(command?.input?.Body) ? command.input.Body : Buffer.from(command?.input?.Body || "");
      store.set(key, body);
      return { ETag: "\"ok\"" };
    }
    if (name === "HeadObjectCommand") {
      if (key.startsWith("originals/")) {
        return { ContentLength: 1024, ContentType: "video/mp4", ETag: "\"source\"" };
      }
      if (store.has(key)) {
        return { ContentLength: store.get(key)!.length, ContentType: key.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "application/octet-stream", ETag: "\"stored\"" };
      }
      const err: any = new Error("NotFound");
      err.name = "NotFound";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    if (name === "ListObjectsV2Command") {
      const prefix = String(command?.input?.Prefix || "");
      const keys = Array.from(store.keys()).filter((item) => item.startsWith(prefix));
      return { IsTruncated: false, Contents: keys.map((item) => ({ Key: item })) };
    }
    if (name === "DeleteObjectsCommand") {
      for (const item of command?.input?.Delete?.Objects || []) {
        if (item?.Key) store.delete(String(item.Key));
      }
      return {};
    }
    return undefined;
  });
  try {
    const { job } = await seedTranscodeJob();
    const claimed = await claimNextTranscodeJob(prisma, { workerId: "worker-test", leaseSeconds: 1800 });
    assert.ok(claimed);
    const result = await processClaimedTranscodeJob(prisma, {
      job: claimed!,
      cfg: phaseBWorkerConfig(),
      runner: defaultMockTranscodeRunner(),
    });
    assert.equal(result.ok, true);
    const storedJob = await prisma.transcodeJob.findUnique({ where: { id: job.id } });
    assert.equal(storedJob?.status, "ready");
    const renditions = await prisma.videoRendition.findMany({ where: { assetId: claimed!.assetId }, orderBy: [{ kind: "asc" }] });
    assert.deepEqual(sortKinds(renditions.map((item) => item.kind)), sortKinds(["hls_1080", "hls_480", "hls_720", "preview"]));
    assert.ok(Array.from(store.keys()).some((item) => item.endsWith("/master.m3u8")));
    assert.equal(Array.from(store.keys()).some((item) => item.startsWith("hls-tmp/")), false);
  } finally {
    restore();
  }
});

test("Phase B: low-resolution sources keep only preview and lowest full rendition without upscaling", async () => {
  const store = new Map<string, Buffer>();
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    const key = String(command?.input?.Key || "");
    if (name === "GetObjectCommand") return { Body: Readable.from([Buffer.from("source-video-data")]) };
    if (name === "PutObjectCommand") {
      store.set(key, Buffer.from(command?.input?.Body || ""));
      return { ETag: "\"ok\"" };
    }
    if (name === "HeadObjectCommand") {
      if (key.startsWith("originals/")) return { ContentLength: 1024, ContentType: "video/mp4", ETag: "\"source\"" };
      if (store.has(key)) return { ContentLength: store.get(key)!.length, ContentType: "application/octet-stream", ETag: "\"stored\"" };
      const err: any = new Error("NotFound");
      err.name = "NotFound";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    if (name === "ListObjectsV2Command") {
      const prefix = String(command?.input?.Prefix || "");
      return { IsTruncated: false, Contents: Array.from(store.keys()).filter((item) => item.startsWith(prefix)).map((item) => ({ Key: item })) };
    }
    if (name === "DeleteObjectsCommand") {
      for (const item of command?.input?.Delete?.Objects || []) {
        if (item?.Key) store.delete(String(item.Key));
      }
      return {};
    }
    return undefined;
  });
  const lowResRunner: TranscodeRunner = {
    async probe() {
      return { durationSeconds: 90, width: 640, height: 360, hasAudio: false };
    },
    async render(input) {
      const previewDir = `${input.workDir}\\preview`;
      const fullDir = `${input.workDir}\\hls_480`;
      await import("node:fs/promises").then((m) => Promise.all([
        m.mkdir(previewDir, { recursive: true }),
        m.mkdir(fullDir, { recursive: true }),
      ]));
      await import("node:fs/promises").then((m) => Promise.all([
        m.writeFile(`${previewDir}\\index.m3u8`, "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.0,\nsegment_000.m4s\n"),
        m.writeFile(`${previewDir}\\init.mp4`, "init"),
        m.writeFile(`${previewDir}\\segment_000.m4s`, "seg"),
        m.writeFile(`${fullDir}\\index.m3u8`, "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.0,\nsegment_000.m4s\n"),
        m.writeFile(`${fullDir}\\init.mp4`, "init"),
        m.writeFile(`${fullDir}\\segment_000.m4s`, "seg"),
      ]));
      return {
        probe: { durationSeconds: 90, width: 640, height: 360, hasAudio: false },
        renditions: [
          { kind: "preview", width: 640, height: 360, bitrateKbps: 600, durationSeconds: 60, manifestPath: `${previewDir}\\index.m3u8`, prefixPath: previewDir, segmentCount: 1 },
          { kind: "hls_480", width: 640, height: 360, bitrateKbps: 900, durationSeconds: 90, manifestPath: `${fullDir}\\index.m3u8`, prefixPath: fullDir, segmentCount: 1 },
        ],
        masterManifestPath: null,
      };
    },
  };
  try {
    const { job } = await seedTranscodeJob();
    const claimed = await claimNextTranscodeJob(prisma, { workerId: "worker-test", leaseSeconds: 1800 });
    assert.ok(claimed);
    const result = await processClaimedTranscodeJob(prisma, {
      job: claimed!,
      cfg: phaseBWorkerConfig(),
      runner: lowResRunner,
    });
    assert.equal(result.ok, true);
    const renditions = await prisma.videoRendition.findMany({ where: { assetId: claimed!.assetId }, orderBy: [{ kind: "asc" }] });
    assert.deepEqual(sortKinds(renditions.map((item) => item.kind)), sortKinds(["hls_480", "preview"]));
    assert.equal(renditions.find((item) => item.kind === "hls_480")?.height, 360);
    assert.equal(renditions.find((item) => item.kind === "hls_480")?.width, 640);
    const storedJob = await prisma.transcodeJob.findUnique({ where: { id: job.id } });
    assert.equal(storedJob?.status, "ready");
  } finally {
    restore();
  }
});

test("Phase B: preview-disabled content only produces full HLS renditions", async () => {
  const store = new Map<string, Buffer>();
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    const key = String(command?.input?.Key || "");
    if (name === "GetObjectCommand") return { Body: Readable.from([Buffer.from("source-video-data")]) };
    if (name === "PutObjectCommand") {
      store.set(key, Buffer.from(command?.input?.Body || ""));
      return { ETag: "\"ok\"" };
    }
    if (name === "HeadObjectCommand") {
      if (key.startsWith("originals/")) return { ContentLength: 1024, ContentType: "video/mp4", ETag: "\"source\"" };
      if (store.has(key)) return { ContentLength: store.get(key)!.length, ContentType: "application/octet-stream", ETag: "\"stored\"" };
      const err: any = new Error("NotFound");
      err.name = "NotFound";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    if (name === "ListObjectsV2Command") {
      const prefix = String(command?.input?.Prefix || "");
      return { IsTruncated: false, Contents: Array.from(store.keys()).filter((item) => item.startsWith(prefix)).map((item) => ({ Key: item })) };
    }
    if (name === "DeleteObjectsCommand") {
      for (const item of command?.input?.Delete?.Objects || []) {
        if (item?.Key) store.delete(String(item.Key));
      }
      return {};
    }
    return undefined;
  });
  try {
    const { job, asset } = await seedTranscodeJob();
    await prisma.content.update({
      where: { id: asset.contentId },
      data: {
        previewEnabled: false,
        previewDurationSeconds: 90,
      },
    });
    const claimed = await claimNextTranscodeJob(prisma, { workerId: "worker-test", leaseSeconds: 1800 });
    assert.ok(claimed);
    const result = await processClaimedTranscodeJob(prisma, {
      job: claimed!,
      cfg: phaseBWorkerConfig(),
      runner: defaultMockTranscodeRunner(),
    });
    assert.equal(result.ok, true);
    const content = await prisma.content.findUnique({ where: { id: claimed!.contentId }, select: { durationSeconds: true } });
    assert.equal(content?.durationSeconds, 120, "source probe duration must be visible to user-facing content cards");
    const renditions = await prisma.videoRendition.findMany({ where: { assetId: claimed!.assetId }, orderBy: [{ kind: "asc" }] });
    assert.deepEqual(sortKinds(renditions.map((item) => item.kind)), sortKinds(["hls_1080", "hls_480", "hls_720"]));
    assert.equal(Array.from(store.keys()).some((item) => item.includes("/preview/")), false);
  } finally {
    restore();
  }
});

test("Phase B: output upload failure requeues job and leaves no temp or final HLS leftovers", async () => {
  const store = new Map<string, Buffer>();
  const restore = installS3CommandMock((command) => {
    const name = command?.constructor?.name;
    const key = String(command?.input?.Key || "");
    if (name === "GetObjectCommand") return { Body: Readable.from([Buffer.from("source-video-data")]) };
    if (name === "PutObjectCommand") {
      if (key.startsWith("hls/") && key.includes("/hls_720/")) {
        throw new Error("simulated_upload_failure");
      }
      store.set(key, Buffer.from(command?.input?.Body || ""));
      return { ETag: "\"ok\"" };
    }
    if (name === "HeadObjectCommand") {
      if (key.startsWith("originals/")) return { ContentLength: 1024, ContentType: "video/mp4", ETag: "\"source\"" };
      if (store.has(key)) return { ContentLength: store.get(key)!.length, ContentType: "application/octet-stream", ETag: "\"stored\"" };
      const err: any = new Error("NotFound");
      err.name = "NotFound";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    if (name === "ListObjectsV2Command") {
      const prefix = String(command?.input?.Prefix || "");
      return { IsTruncated: false, Contents: Array.from(store.keys()).filter((item) => item.startsWith(prefix)).map((item) => ({ Key: item })) };
    }
    if (name === "DeleteObjectsCommand") {
      for (const item of command?.input?.Delete?.Objects || []) {
        if (item?.Key) store.delete(String(item.Key));
      }
      return {};
    }
    return undefined;
  });
  try {
    const { job } = await seedTranscodeJob();
    const claimed = await claimNextTranscodeJob(prisma, { workerId: "worker-test", leaseSeconds: 1800 });
    assert.ok(claimed);
    const result = await processClaimedTranscodeJob(prisma, {
      job: claimed!,
      cfg: phaseBWorkerConfig(),
      runner: defaultMockTranscodeRunner(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "output_upload_failed");
    const storedJob = await prisma.transcodeJob.findUnique({ where: { id: job.id } });
    assert.equal(storedJob?.status, "queued");
    assert.equal(Array.from(store.keys()).some((item) => item.startsWith("hls/")), false);
    assert.equal(Array.from(store.keys()).some((item) => item.startsWith("hls-tmp/")), false);
  } finally {
    restore();
  }
});

test("Phase B: real FFmpeg writes init.mp4 beside each HLS manifest", { skip: !hasExecutable("ffmpeg") || !hasExecutable("ffprobe") }, async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "intune-real-ffmpeg-"));
  const sourcePath = path.join(workDir, "source.mp4");
  try {
    const sourceBuild = spawnSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      sourcePath,
    ], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(sourceBuild.status, 0, sourceBuild.stderr || sourceBuild.stdout);

    const runner = createFfmpegTranscodeRunner({
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      ffprobeTimeoutMs: 60_000,
      ffmpegTimeoutMs: 120_000,
    });
    const rendered = await runner.render({
      inputPath: sourcePath,
      workDir,
      previewSeconds: 2,
      timeoutMs: 120_000,
    });

    assert.ok(rendered.renditions.length > 0);
    for (const rendition of rendered.renditions) {
      const initPath = path.join(rendition.prefixPath, "init.mp4");
      const manifestText = await readFile(rendition.manifestPath, "utf8");
      const initStats = await stat(initPath);
      assert.ok(initStats.isFile());
      assert.match(manifestText, /URI="init\.mp4"/);
      const inspected = await inspectLocalRendition(rendition);
      assert.ok(inspected.segmentCount > 0);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
