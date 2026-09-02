import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";

import adminInteractionRoutes from "../routes/adminInteractions.js";
import communityMediaRoutes from "../routes/communityMedia.js";
import { loadCommunityMediaConfig, processNextCommunityVideoAsset } from "../services/communityMedia.js";
import { getS3Client, requireObjectStorageEnv } from "../services/objectStorage.js";
import { loadScriptEnvFiles } from "../utils/scriptEnv.js";

type HarnessModule = {
  setupTestHarness: () => Promise<{ prisma: any }>;
  seedTestData: (prisma: any) => Promise<void>;
  teardownTestHarness: (prisma: any) => Promise<void>;
};

type AcceptanceSummary = {
  ok: boolean;
  generatedAt: string;
  envFilesLoaded: string[];
  image: {
    thumbnailStatus: number;
    anonymousSourceDenied: boolean;
    anonymousThumbDenied: boolean;
    hiddenStatus: number;
    crossPostStatus: number;
  };
  video: {
    manifestStatus: number;
    segmentStatus: number;
    anonymousManifestDenied: boolean;
    anonymousSegmentDenied: boolean;
    hiddenStatus: number;
    crossPostStatus: number;
    foreignSignStatus: number;
  };
  bucketPolicy: {
    verified: boolean;
    publicBaseUrl: string;
  };
};

function ensureExecutable(bin: string) {
  const result = spawnSync(bin, ["-version"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`missing_executable:${bin}`);
  }
}

function sha256Base64(input: Buffer) {
  return createHash("sha256").update(input).digest("base64");
}

function cookieFromResponse(res: { headers: Record<string, unknown> }) {
  const raw = res.headers["set-cookie"];
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return items.map((item) => item.split(";")[0]).join("; ");
}

async function loadHarnessModule(): Promise<HarnessModule> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const harnessPath = path.resolve(scriptDir, "../../tests/_testHarness.ts");
  return import(pathToFileURL(harnessPath).href) as Promise<HarnessModule>;
}

async function createApp(prisma: any) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(session, {
    secret: "isolated-community-media-acceptance-session-secret-123456",
    cookie: { secure: false, sameSite: "lax" },
  });
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
  app.post("/__test/login-admin/:role", async (req) => {
    const role = String((req.params as any).role || "");
    const admin = await prisma.adminUser.findFirst({ where: { role }, select: { id: true, email: true, role: true } });
    if (!admin) throw new Error(`missing_admin_role:${role}`);
    (req.session as any).admin = { adminId: admin.id, email: admin.email, role: admin.role };
    return { ok: true };
  });
  await app.register(communityMediaRoutes, { prefix: "/api" });
  await app.register(adminInteractionRoutes, { prefix: "/api" });
  return app;
}

async function createUser(prisma: any, displayName: string) {
  return prisma.user.create({
    data: {
      displayName,
      status: "active",
      telegramUserId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 100_000)),
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

async function grantCommunityVideoCreator(prisma: any, userId: string, adminId: string) {
  return (prisma as any).communityVideoCreatorGrant.upsert({
    where: { userId },
    update: {
      active: true,
      reason: "isolated acceptance grant",
      grantedByAdminId: adminId,
      revokedByAdminId: null,
      revokedAt: null,
    },
    create: {
      userId,
      active: true,
      reason: "isolated acceptance grant",
      grantedByAdminId: adminId,
    },
  });
}

async function uploadViaPresignedUrl(url: string, body: Buffer, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: "PUT",
    headers,
    body: new Uint8Array(body),
  });
  if (!response.ok) {
    throw new Error(`presigned_upload_failed:${response.status}:${await response.text()}`);
  }
  return response;
}

async function buildSampleVideo() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "community-media-acceptance-"));
  const videoPath = path.join(workDir, "sample.mp4");
  const built = spawnSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=720x1280:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=48000",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    videoPath,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const bytes = await readFile(videoPath);
  return { workDir, videoPath, bytes };
}

async function buildSampleImage() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "community-image-acceptance-"));
  const imagePath = path.join(workDir, "sample.png");
  const built = spawnSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=#7c3aed:s=64x64",
    "-frames:v",
    "1",
    imagePath,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const bytes = await readFile(imagePath);
  return { workDir, imagePath, bytes };
}

async function probeAnonymous(publicBaseUrl: string, objectKey: string) {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/${objectKey}`);
  return response.status === 401 || response.status === 403 || response.status === 404;
}

async function cleanupPrefix(prefix: string) {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  let continuationToken: string | undefined;
  for (;;) {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: env.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const row of page.Contents || []) {
      if (!row.Key) continue;
      await s3.send(new DeleteObjectCommand({ Bucket: env.bucket, Key: row.Key }));
    }
    if (!page.IsTruncated || !page.NextContinuationToken) break;
    continuationToken = page.NextContinuationToken;
  }
}

export async function main(argv = process.argv) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(scriptDir, "../..");
  const envFilesLoaded = loadScriptEnvFiles({ cwd: serverRoot, preferTestEnv: true });
  if (!process.env.DATABASE_URL_TEST && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL_TEST_missing");
  }
  ensureExecutable("ffmpeg");
  ensureExecutable("ffprobe");

  process.env.NODE_ENV = "test";
  process.env.COMMUNITY_ENABLED = "true";
  process.env.COMMUNITY_POSTING_ENABLED = "true";
  process.env.COMMUNITY_VIDEO_UPLOAD_ENABLED = "true";
  process.env.COMMUNITY_MEDIA_RUNNER = "ffmpeg";

  const publicBaseUrl = String(process.env.OBJECT_STORAGE_PUBLIC_BASE_URL || process.env.S3_PUBLIC_BASE_URL || "").trim();
  if (!publicBaseUrl) {
    throw new Error("OBJECT_STORAGE_PUBLIC_BASE_URL_missing");
  }
  requireObjectStorageEnv();

  const harnessModule = await loadHarnessModule();
  const harness = await harnessModule.setupTestHarness();
  const prisma = harness.prisma;
  await harnessModule.seedTestData(prisma);

  let sampleVideoWorkDir = "";
  let sampleImageWorkDir = "";
  const prefixesToCleanup = new Set<string>();
  const mediaCfg = loadCommunityMediaConfig(process.env);
  try {
    const app = await createApp(prisma);
    try {
      const admin = await prisma.adminUser.findFirst({ where: { role: "super_admin" }, select: { id: true } });
      if (!admin) throw new Error("missing_super_admin");
      const adminCookie = await loginAdmin(app, "super_admin");

      const imageAuthor = await createUser(prisma, "隔离验收图片作者");
      const imageCookie = await loginUser(app, imageAuthor.id);
      const imagePost = await prisma.communityPost.create({
        data: { authorId: imageAuthor.id, body: "图片帖子", status: "pending" },
      });
      prefixesToCleanup.add(`community/posts/${imagePost.id}/`);
      prefixesToCleanup.add(`community/hls/${imagePost.id}/`);

      const builtImage = await buildSampleImage();
      sampleImageWorkDir = builtImage.workDir;
      const imageBytes = builtImage.bytes;
      const imageSha256 = sha256Base64(imageBytes);
      const imageInit = await app.inject({
        method: "POST",
        url: `/api/community/posts/${encodeURIComponent(imagePost.id)}/assets/upload-session`,
        headers: { cookie: imageCookie, "Content-Type": "application/json" },
        payload: { kind: "image", filename: "accept.png", mimeType: "image/png", byteSize: imageBytes.length, sha256: imageSha256 },
      });
      assert.equal(imageInit.statusCode, 200, imageInit.body);
      const imageInitBody = imageInit.json() as any;
      await uploadViaPresignedUrl(imageInitBody.uploadUrl, imageBytes, imageInitBody.expectedHttpHeaders || {});
      const imageComplete = await app.inject({
        method: "POST",
        url: `/api/community/upload-sessions/${encodeURIComponent(imageInitBody.uploadSessionId)}/complete`,
        headers: { cookie: imageCookie, "Content-Type": "application/json" },
        payload: {},
      });
      assert.equal(imageComplete.statusCode, 200, imageComplete.body);
      const imageAsset = await prisma.communityPostAsset.findFirstOrThrow({ where: { postId: imagePost.id } });
      await prisma.communityPostAsset.update({ where: { id: imageAsset.id }, data: { moderationStatus: "approved" } });
      await prisma.communityPost.update({ where: { id: imagePost.id }, data: { status: "published", publishedAt: new Date() } });

      const imageThumb = await app.inject({
        method: "GET",
        url: `/api/community/posts/${encodeURIComponent(imagePost.id)}/assets/${encodeURIComponent(imageAsset.id)}/image`,
      });
      const imageCrossPost = await app.inject({
        method: "GET",
        url: `/api/community/posts/${encodeURIComponent(randomUUID())}/assets/${encodeURIComponent(imageAsset.id)}/image`,
      });
      const anonymousImageSourceDenied = await probeAnonymous(publicBaseUrl, String(imageAsset.objectKey));
      const anonymousImageThumbDenied = await probeAnonymous(publicBaseUrl, String(imageAsset.thumbnailObjectKey));

      const videoAuthor = await createUser(prisma, "隔离验收视频作者");
      const foreignUser = await createUser(prisma, "隔离验收路人");
      await grantCommunityVideoCreator(prisma, videoAuthor.id, admin.id);
      const videoCookie = await loginUser(app, videoAuthor.id);
      const foreignCookie = await loginUser(app, foreignUser.id);
      const videoPost = await prisma.communityPost.create({
        data: { authorId: videoAuthor.id, body: "视频帖子", status: "pending" },
      });
      prefixesToCleanup.add(`community/posts/${videoPost.id}/`);
      prefixesToCleanup.add(`community/hls/${videoPost.id}/`);

      const builtVideo = await buildSampleVideo();
      sampleVideoWorkDir = builtVideo.workDir;
      const videoBytes = builtVideo.bytes;
      const videoSha256 = sha256Base64(videoBytes);
      const videoInit = await app.inject({
        method: "POST",
        url: `/api/community/posts/${encodeURIComponent(videoPost.id)}/assets/upload-session`,
        headers: { cookie: videoCookie, "Content-Type": "application/json" },
        payload: { kind: "video", filename: "accept.mp4", mimeType: "video/mp4", byteSize: videoBytes.length, sha256: videoSha256 },
      });
      assert.equal(videoInit.statusCode, 200, videoInit.body);
      const videoInitBody = videoInit.json() as any;

      const foreignSign = await app.inject({
        method: "POST",
        url: `/api/community/upload-sessions/${encodeURIComponent(videoInitBody.uploadSessionId)}/parts/1/sign`,
        headers: { cookie: foreignCookie },
      });

      const signResp = await app.inject({
        method: "POST",
        url: `/api/community/upload-sessions/${encodeURIComponent(videoInitBody.uploadSessionId)}/parts/1/sign`,
        headers: { cookie: videoCookie },
      });
      assert.equal(signResp.statusCode, 200, signResp.body);
      const signBody = signResp.json() as any;
      const uploadPartResp = await uploadViaPresignedUrl(signBody.uploadUrl, videoBytes, signBody.expectedHttpHeaders || {});
      const etag = String(uploadPartResp.headers.get("etag") || "").replace(/^"|"$/g, "");
      assert.ok(etag, "multipart upload must return ETag");
      const partComplete = await app.inject({
        method: "POST",
        url: `/api/community/upload-sessions/${encodeURIComponent(videoInitBody.uploadSessionId)}/parts/1/complete`,
        headers: { cookie: videoCookie, "Content-Type": "application/json" },
        payload: { etag, bytes: videoBytes.length },
      });
      assert.equal(partComplete.statusCode, 200, partComplete.body);
      const videoComplete = await app.inject({
        method: "POST",
        url: `/api/community/upload-sessions/${encodeURIComponent(videoInitBody.uploadSessionId)}/complete`,
        headers: { cookie: videoCookie, "Content-Type": "application/json" },
        payload: {},
      });
      assert.equal(videoComplete.statusCode, 200, videoComplete.body);

      const processedAssetId = await processNextCommunityVideoAsset(prisma as any, mediaCfg);
      assert.ok(processedAssetId, "community transcode worker should process queued asset");
      const videoAsset = await prisma.communityPostAsset.findFirstOrThrow({ where: { postId: videoPost.id } });
      await prisma.communityPostAsset.update({ where: { id: videoAsset.id }, data: { moderationStatus: "approved" } });
      await prisma.communityPost.update({ where: { id: videoPost.id }, data: { status: "published", publishedAt: new Date() } });

      const manifest = await app.inject({
        method: "GET",
        url: `/api/community/media/${encodeURIComponent(videoPost.id)}/videos/${encodeURIComponent(videoAsset.id)}/master.m3u8`,
      });
      assert.equal(manifest.statusCode, 200, manifest.body);
      const manifestBody = String(manifest.body || "");
      assert.match(manifestBody, new RegExp(`/community/media/${videoPost.id}/videos/${videoAsset.id}/`));
      const segmentPath = manifestBody.split(/\r?\n/).find((line) => line.includes(`/community/media/${videoPost.id}/videos/${videoAsset.id}/`) && line.endsWith(".ts"));
      assert.ok(segmentPath, "manifest must rewrite to gateway segment path");
      const segment = await app.inject({
        method: "GET",
        url: segmentPath!,
      });
      assert.equal(segment.statusCode, 200, segment.body);
      const manifestObjectKey = String(videoAsset.playbackManifestKey);
      const segmentObjectKey = `${String(videoAsset.playbackPrefixKey)}/${path.posix.basename(String(segmentPath).split("?")[0])}`;
      const anonymousManifestDenied = await probeAnonymous(publicBaseUrl, manifestObjectKey);
      const anonymousSegmentDenied = await probeAnonymous(publicBaseUrl, segmentObjectKey);

      const crossPostManifest = await app.inject({
        method: "GET",
        url: `/api/community/media/${encodeURIComponent(randomUUID())}/videos/${encodeURIComponent(videoAsset.id)}/master.m3u8`,
      });

      const hidePost = await app.inject({
        method: "POST",
        url: `/api/admin/community/posts/${encodeURIComponent(videoPost.id)}/moderate`,
        headers: { cookie: adminCookie, "Content-Type": "application/json" },
        payload: { status: "hidden", reason: "isolated acceptance hide" },
      });
      assert.equal(hidePost.statusCode, 200, hidePost.body);
      const hiddenManifest = await app.inject({
        method: "GET",
        url: `/api/community/media/${encodeURIComponent(videoPost.id)}/videos/${encodeURIComponent(videoAsset.id)}/master.m3u8`,
      });
      await prisma.communityPost.update({ where: { id: imagePost.id }, data: { status: "hidden" } });
      const hiddenImage = await app.inject({
        method: "GET",
        url: `/api/community/posts/${encodeURIComponent(imagePost.id)}/assets/${encodeURIComponent(imageAsset.id)}/image`,
      });

      const summary: AcceptanceSummary = {
        ok: true,
        generatedAt: new Date().toISOString(),
        envFilesLoaded,
        image: {
          thumbnailStatus: imageThumb.statusCode,
          anonymousSourceDenied: anonymousImageSourceDenied,
          anonymousThumbDenied: anonymousImageThumbDenied,
          hiddenStatus: hiddenImage.statusCode,
          crossPostStatus: imageCrossPost.statusCode,
        },
        video: {
          manifestStatus: manifest.statusCode,
          segmentStatus: segment.statusCode,
          anonymousManifestDenied,
          anonymousSegmentDenied,
          hiddenStatus: hiddenManifest.statusCode,
          crossPostStatus: crossPostManifest.statusCode,
          foreignSignStatus: foreignSign.statusCode,
        },
        bucketPolicy: {
          verified: anonymousImageSourceDenied && anonymousImageThumbDenied && anonymousManifestDenied && anonymousSegmentDenied,
          publicBaseUrl,
        },
      };

      assert.equal(summary.image.thumbnailStatus, 200);
      assert.equal(summary.image.hiddenStatus, 404);
      assert.equal(summary.image.crossPostStatus, 404);
      assert.equal(summary.video.manifestStatus, 200);
      assert.equal(summary.video.segmentStatus, 200);
      assert.equal(summary.video.hiddenStatus, 404);
      assert.equal(summary.video.crossPostStatus, 404);
      assert.equal(summary.video.foreignSignStatus, 403);
      assert.equal(summary.bucketPolicy.verified, true);
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    } finally {
      await app.close();
    }
  } finally {
    if (sampleImageWorkDir) {
      await rm(sampleImageWorkDir, { recursive: true, force: true }).catch(() => {});
    }
    if (sampleVideoWorkDir) {
      await rm(sampleVideoWorkDir, { recursive: true, force: true }).catch(() => {});
    }
    for (const prefix of prefixesToCleanup) {
      await cleanupPrefix(prefix).catch(() => {});
    }
    await harnessModule.teardownTestHarness(prisma);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: any) => {
    console.log(JSON.stringify({
      ok: false,
      error: "community_media_acceptance_failed",
      hint: String(error?.message || error || "unknown"),
    }, null, 2));
    process.exit(1);
  });
}
