import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarkdown,
  buildValidationSummary,
  probeAnonymousAccess,
} from "../src/scripts/validatePhaseBTranscode.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;
  delete process.env.S3_PUBLIC_BASE_URL;
});

test("Phase B validation summary passes only when storage checks are clean", () => {
  const summary = buildValidationSummary({
    databaseMode: "test",
    envFilesLoaded: [".env.test", ".env"],
    job: {
      id: "job-1",
      contentId: "content-1",
      assetId: "asset-1",
      status: "ready",
      attemptCount: 1,
      progressPercent: 100,
    },
    sourceHeadOk: true,
    anonymousProbe: {
      verdict: "denied",
      statusCode: 403,
      ok: true,
    },
    masterManifest: {
      required: true,
      headOk: true,
    },
    tempPrefix: {
      cleared: true,
      leftoverObjectCount: 0,
    },
    renditions: [
      {
        kind: "preview",
        status: "ready",
        width: 854,
        height: 480,
        bitrateKbps: 900,
        durationSeconds: 45,
        expectedSegmentCount: 2,
        actualSegmentCount: 2,
        segmentCountMatch: true,
        byteSize: "1024",
        listedByteSize: "1024",
        manifestHeadOk: true,
        prefixListOk: true,
        manifestPresentInPrefix: true,
        initFilePresent: true,
        headOk: true,
        readyAt: "2026-08-26T01:00:00.000Z",
      },
    ],
  });

  assert.equal(summary.ok, true);
});

test("Phase B validation summary fails on public probe or leftover temp objects", () => {
  const summary = buildValidationSummary({
    databaseMode: "primary",
    envFilesLoaded: [],
    job: {
      id: "job-2",
      contentId: "content-2",
      assetId: "asset-2",
      status: "ready",
      attemptCount: 2,
      progressPercent: 100,
    },
    sourceHeadOk: true,
    anonymousProbe: {
      verdict: "public",
      statusCode: 200,
      ok: false,
    },
    masterManifest: {
      required: true,
      headOk: true,
    },
    tempPrefix: {
      cleared: false,
      leftoverObjectCount: 3,
    },
    renditions: [
      {
        kind: "hls_720",
        status: "ready",
        width: 1280,
        height: 720,
        bitrateKbps: 2500,
        durationSeconds: 180,
        expectedSegmentCount: 12,
        actualSegmentCount: 11,
        segmentCountMatch: false,
        byteSize: "2048",
        listedByteSize: "2048",
        manifestHeadOk: true,
        prefixListOk: true,
        manifestPresentInPrefix: true,
        initFilePresent: true,
        headOk: false,
        readyAt: "2026-08-26T01:05:00.000Z",
      },
    ],
  });

  assert.equal(summary.ok, false);
});

test("Phase B validation summary fails when anonymous probe is not configured", () => {
  const summary = buildValidationSummary({
    databaseMode: "primary",
    envFilesLoaded: [],
    job: {
      id: "job-4",
      contentId: "content-4",
      assetId: "asset-4",
      status: "ready",
      attemptCount: 1,
      progressPercent: 100,
    },
    sourceHeadOk: true,
    anonymousProbe: {
      verdict: "probe_not_configured",
      statusCode: null,
      ok: false,
    },
    masterManifest: {
      required: true,
      headOk: true,
    },
    tempPrefix: {
      cleared: true,
      leftoverObjectCount: 0,
    },
    renditions: [
      {
        kind: "hls_720",
        status: "ready",
        width: 1280,
        height: 720,
        bitrateKbps: 2500,
        durationSeconds: 180,
        expectedSegmentCount: 12,
        actualSegmentCount: 12,
        segmentCountMatch: true,
        byteSize: "2048",
        listedByteSize: "2048",
        manifestHeadOk: true,
        prefixListOk: true,
        manifestPresentInPrefix: true,
        initFilePresent: true,
        headOk: true,
        readyAt: "2026-08-26T01:05:00.000Z",
      },
    ],
  });

  assert.equal(summary.ok, false);
});

test("Phase B validation markdown stays redacted and reports summary fields", () => {
  const markdown = buildMarkdown(buildValidationSummary({
    databaseMode: "test",
    envFilesLoaded: [".env"],
    job: {
      id: "job-3",
      contentId: "content-3",
      assetId: "asset-3",
      status: "ready",
      attemptCount: 1,
      progressPercent: 100,
    },
    sourceHeadOk: true,
    anonymousProbe: {
      verdict: "denied",
      statusCode: 403,
      ok: true,
    },
    masterManifest: {
      required: false,
      headOk: null,
    },
    tempPrefix: {
      cleared: true,
      leftoverObjectCount: 0,
    },
    renditions: [
      {
        kind: "preview",
        status: "ready",
        width: 854,
        height: 480,
        bitrateKbps: 900,
        durationSeconds: 45,
        expectedSegmentCount: 2,
        actualSegmentCount: 2,
        segmentCountMatch: true,
        byteSize: "1024",
        listedByteSize: "1024",
        manifestHeadOk: true,
        prefixListOk: true,
        manifestPresentInPrefix: true,
        initFilePresent: true,
        headOk: true,
        readyAt: null,
      },
    ],
  }));

  assert.match(markdown, /匿名访问探测：denied\(403\)/);
  assert.doesNotMatch(markdown, /manifestKey|prefixKey|objectKey|https?:\/\//i);
});

test("Phase B anonymous probe treats 403 as denied and 200 as public", async () => {
  process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = "https://example.invalid/private";

  globalThis.fetch = (async () => ({ status: 403, ok: false })) as typeof fetch;
  const denied = await probeAnonymousAccess("hls/content/asset/preview/index.m3u8");
  assert.deepEqual(denied, { verdict: "denied", statusCode: 403, ok: true });

  globalThis.fetch = (async () => ({ status: 200, ok: true })) as typeof fetch;
  const publicProbe = await probeAnonymousAccess("hls/content/asset/preview/index.m3u8");
  assert.deepEqual(publicProbe, { verdict: "public", statusCode: 200, ok: false });
});

test("Phase B anonymous probe fails closed when public probe base is missing", async () => {
  const probe = await probeAnonymousAccess("hls/content/asset/preview/index.m3u8");
  assert.deepEqual(probe, { verdict: "probe_not_configured", statusCode: null, ok: false });
});
