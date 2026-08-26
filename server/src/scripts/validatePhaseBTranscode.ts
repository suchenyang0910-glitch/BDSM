import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";

import { getS3Client, headObject, requireObjectStorageEnv } from "../services/objectStorage.js";
import { hasFlagInArgv, loadScriptEnvFiles, readArgFromArgv } from "../utils/scriptEnv.js";

type AnonymousProbeSummary = {
  verdict: "denied" | "public" | "missing_manifest" | "probe_not_configured" | "probe_failed";
  statusCode: number | null;
  ok: boolean;
};

type PrefixInspection = {
  ok: boolean;
  objectCount: number;
  byteSize: string;
  objectNames: string[];
};

type RenditionCheck = {
  kind: string;
  status: string;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  durationSeconds: number | null;
  expectedSegmentCount: number | null;
  actualSegmentCount: number;
  segmentCountMatch: boolean | null;
  byteSize: string | null;
  listedByteSize: string;
  manifestHeadOk: boolean;
  prefixListOk: boolean;
  manifestPresentInPrefix: boolean;
  initFilePresent: boolean;
  headOk: boolean;
  readyAt: string | null;
};

type MasterManifestCheck = {
  required: boolean;
  headOk: boolean | null;
};

type TempPrefixCheck = {
  cleared: boolean | null;
  leftoverObjectCount: number;
};

type PhaseBValidationSummary = {
  ok: boolean;
  generatedAt: string;
  databaseMode: "test" | "primary";
  envFilesLoaded: string[];
  contentId: string;
  assetId: string;
  jobId: string;
  jobStatus: string;
  attemptCount: number;
  progressPercent: number;
  sourceHeadOk: boolean;
  anonymousProbe: AnonymousProbeSummary;
  masterManifest: MasterManifestCheck;
  tempPrefix: TempPrefixCheck;
  renditions: RenditionCheck[];
};

function buildHlsRootPrefix(contentId: string, assetId: string) {
  return `hls/${contentId}/${assetId}`;
}

function buildHlsTempPrefix(contentId: string, assetId: string, jobId: string) {
  return `hls-tmp/${contentId}/${assetId}/${jobId}`;
}

function bigintToString(value: bigint | null | undefined) {
  return value == null ? null : String(value);
}

function sumBigInts(values: bigint[]) {
  return values.reduce((acc, item) => acc + item, 0n);
}

async function listPrefix(prefixKey: string): Promise<PrefixInspection> {
  const env = requireObjectStorageEnv();
  const s3 = getS3Client();
  const objectNames: string[] = [];
  const sizes: bigint[] = [];
  try {
    let continuationToken: string | undefined;
    while (true) {
      const page = await s3.send(new ListObjectsV2Command({
        Bucket: env.bucket,
        Prefix: `${prefixKey}/`,
        ContinuationToken: continuationToken,
      }));
      for (const row of page.Contents || []) {
        if (!row.Key) continue;
        objectNames.push(path.posix.basename(String(row.Key)));
        sizes.push(typeof row.Size === "number" ? BigInt(row.Size) : 0n);
      }
      if (!page.IsTruncated || !page.NextContinuationToken) break;
      continuationToken = page.NextContinuationToken;
    }
    return {
      ok: true,
      objectCount: objectNames.length,
      byteSize: String(sumBigInts(sizes)),
      objectNames,
    };
  } catch {
    return {
      ok: false,
      objectCount: 0,
      byteSize: "0",
      objectNames: [],
    };
  }
}

export async function probeAnonymousAccess(manifestKey: string | null): Promise<AnonymousProbeSummary> {
  if (!manifestKey) {
    return { verdict: "missing_manifest", statusCode: null, ok: false };
  }
  const publicBase = process.env.OBJECT_STORAGE_PUBLIC_BASE_URL || process.env.S3_PUBLIC_BASE_URL;
  if (!publicBase) {
    return { verdict: "probe_not_configured", statusCode: null, ok: false };
  }
  try {
    const base = String(publicBase).replace(/\/+$/, "");
    const res = await fetch(`${base}/${manifestKey}`);
    if ([401, 403, 404].includes(res.status)) {
      return { verdict: "denied", statusCode: res.status, ok: true };
    }
    return {
      verdict: res.ok ? "public" : "probe_failed",
      statusCode: res.status,
      ok: false,
    };
  } catch {
    return { verdict: "probe_failed", statusCode: null, ok: false };
  }
}

async function inspectRendition(bucket: string, rendition: any): Promise<RenditionCheck> {
  const manifestHead = rendition.manifestKey
    ? await headObject(bucket, rendition.manifestKey)
    : { ok: false };
  const prefix = rendition.prefixKey
    ? await listPrefix(rendition.prefixKey)
    : { ok: false, objectCount: 0, byteSize: "0", objectNames: [] };
  const manifestName = rendition.manifestKey ? path.posix.basename(String(rendition.manifestKey)) : null;
  const actualSegmentCount = prefix.objectNames.filter((name) => /\.(m4s|ts)$/i.test(name)).length;
  const manifestPresentInPrefix = !!manifestName && prefix.objectNames.includes(manifestName);
  const initFilePresent = prefix.objectNames.includes("init.mp4");
  const expectedSegmentCount = typeof rendition.segmentCount === "number" ? rendition.segmentCount : null;
  const segmentCountMatch = expectedSegmentCount == null ? null : expectedSegmentCount === actualSegmentCount;
  const headOk = !!manifestHead.ok
    && prefix.ok
    && manifestPresentInPrefix
    && initFilePresent
    && actualSegmentCount > 0
    && (segmentCountMatch !== false);
  return {
    kind: rendition.kind,
    status: rendition.status,
    width: rendition.width ?? null,
    height: rendition.height ?? null,
    bitrateKbps: rendition.bitrateKbps ?? null,
    durationSeconds: rendition.durationSeconds ?? null,
    expectedSegmentCount,
    actualSegmentCount,
    segmentCountMatch,
    byteSize: bigintToString(rendition.byteSize),
    listedByteSize: prefix.byteSize,
    manifestHeadOk: !!manifestHead.ok,
    prefixListOk: prefix.ok,
    manifestPresentInPrefix,
    initFilePresent,
    headOk,
    readyAt: rendition.readyAt ? new Date(rendition.readyAt).toISOString() : null,
  };
}

async function inspectMasterManifest(bucket: string, rootPrefix: string, hasFullRendition: boolean): Promise<MasterManifestCheck> {
  if (!hasFullRendition) {
    return { required: false, headOk: null };
  }
  const result = await headObject(bucket, `${rootPrefix}/master.m3u8`);
  return { required: true, headOk: !!result.ok };
}

async function inspectTempPrefix(prefixKey: string): Promise<TempPrefixCheck> {
  const prefix = await listPrefix(prefixKey);
  if (!prefix.ok) {
    return { cleared: false, leftoverObjectCount: 0 };
  }
  return {
    cleared: prefix.objectCount === 0,
    leftoverObjectCount: prefix.objectCount,
  };
}

export function buildValidationSummary(input: {
  databaseMode: "test" | "primary";
  envFilesLoaded: string[];
  job: { id: string; contentId: string; assetId: string; status: string; attemptCount: number; progressPercent: number };
  sourceHeadOk: boolean;
  anonymousProbe: AnonymousProbeSummary;
  masterManifest: MasterManifestCheck;
  tempPrefix: TempPrefixCheck;
  renditions: RenditionCheck[];
}): PhaseBValidationSummary {
  const renditionsOk = input.renditions.length > 0
    && input.renditions.every((item) => item.status === "ready" && item.headOk);
  const masterManifestOk = input.masterManifest.required ? input.masterManifest.headOk === true : true;
  const tempPrefixOk = input.tempPrefix.cleared !== false;
  const anonymousOk = input.anonymousProbe.ok === true;
  return {
    ok: input.job.status === "ready"
      && input.sourceHeadOk
      && renditionsOk
      && masterManifestOk
      && tempPrefixOk
      && anonymousOk,
    generatedAt: new Date().toISOString(),
    databaseMode: input.databaseMode,
    envFilesLoaded: input.envFilesLoaded,
    contentId: input.job.contentId,
    assetId: input.job.assetId,
    jobId: input.job.id,
    jobStatus: input.job.status,
    attemptCount: input.job.attemptCount,
    progressPercent: input.job.progressPercent,
    sourceHeadOk: input.sourceHeadOk,
    anonymousProbe: input.anonymousProbe,
    masterManifest: input.masterManifest,
    tempPrefix: input.tempPrefix,
    renditions: input.renditions,
  };
}

export function buildMarkdown(summary: PhaseBValidationSummary) {
  const anonymousText = summary.anonymousProbe.statusCode != null
    ? `${summary.anonymousProbe.verdict}(${summary.anonymousProbe.statusCode})`
    : summary.anonymousProbe.verdict;
  const masterText = summary.masterManifest.required
    ? (summary.masterManifest.headOk ? "通过" : "失败")
    : "不适用";
  const tempText = summary.tempPrefix.cleared == null
    ? "未知"
    : summary.tempPrefix.cleared
      ? "通过"
      : `失败(${summary.tempPrefix.leftoverObjectCount})`;
  const lines = [
    "## Phase B 真实验收记录",
    "",
    `- 生成时间：${summary.generatedAt}`,
    `- 数据库：${summary.databaseMode}`,
    `- 加载环境文件：${summary.envFilesLoaded.join(", ") || "无"}`,
    `- 内容：${summary.contentId}`,
    `- 资产：${summary.assetId}`,
    `- 任务：${summary.jobId}`,
    `- 转码状态：${summary.jobStatus}`,
    `- 尝试次数：${summary.attemptCount}`,
    `- 进度：${summary.progressPercent}%`,
    `- 源文件 HEAD：${summary.sourceHeadOk ? "通过" : "失败"}`,
    `- Master Manifest HEAD：${masterText}`,
    `- 临时前缀清理：${tempText}`,
    `- 匿名访问探测：${anonymousText}`,
    "",
    "### 档位",
    "",
    ...summary.renditions.map((item) => `- ${item.kind}: status=${item.status} manifest=${item.manifestHeadOk ? "ok" : "fail"} prefix=${item.prefixListOk ? "ok" : "fail"} segments=${item.expectedSegmentCount ?? "n/a"}/${item.actualSegmentCount} init=${item.initFilePresent ? "ok" : "fail"} size=${item.byteSize ?? "0"}/${item.listedByteSize}`),
  ];
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv) {
  const useTestDb = hasFlagInArgv(argv, "--use-test-db");
  const envFilesLoaded = loadScriptEnvFiles({
    explicitEnvFile: readArgFromArgv(argv, "--env-file"),
    preferTestEnv: useTestDb,
  });
  const dbUrl = useTestDb
    ? (process.env.DATABASE_URL_TEST || process.env.DATABASE_URL)
    : (process.env.DATABASE_URL || process.env.DATABASE_URL_TEST);
  if (!dbUrl) {
    throw new Error("DATABASE_URL_missing");
  }

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await prisma.$connect();
  try {
    const storageEnv = requireObjectStorageEnv();
    const jobId = readArgFromArgv(argv, "--job-id");
    const assetId = readArgFromArgv(argv, "--asset-id");
    const contentId = readArgFromArgv(argv, "--content-id");

    const job = await prisma.transcodeJob.findFirst({
      where: jobId
        ? { id: jobId }
        : assetId
          ? { assetId }
          : contentId
            ? { contentId }
            : {},
      include: {
        asset: true,
      },
      orderBy: [{ queuedAt: "desc" }, { startedAt: "desc" }],
    });
    if (!job) {
      throw new Error("transcode_job_not_found");
    }
    const renditions = await prisma.videoRendition.findMany({
      where: { assetId: job.assetId },
      orderBy: [{ kind: "asc" }],
    });

    const sourceHead = await headObject(storageEnv.bucket, job.asset.objectKey);
    const renditionChecks: RenditionCheck[] = [];
    for (const rendition of renditions) {
      renditionChecks.push(await inspectRendition(storageEnv.bucket, rendition));
    }

    const summary = buildValidationSummary({
      databaseMode: useTestDb ? "test" : "primary",
      envFilesLoaded,
      job,
      sourceHeadOk: !!sourceHead.ok,
      anonymousProbe: await probeAnonymousAccess(renditions[0]?.manifestKey || null),
      masterManifest: await inspectMasterManifest(
        storageEnv.bucket,
        buildHlsRootPrefix(job.contentId, job.assetId),
        renditions.some((item) => item.kind !== "preview" && item.status !== "deleted"),
      ),
      tempPrefix: await inspectTempPrefix(buildHlsTempPrefix(job.contentId, job.assetId, job.id)),
      renditions: renditionChecks,
    });

    const writeJsonPath = readArgFromArgv(argv, "--write-json");
    if (writeJsonPath) {
      fs.mkdirSync(path.dirname(writeJsonPath), { recursive: true });
      fs.writeFileSync(writeJsonPath, JSON.stringify(summary, null, 2));
    }
    const writeMdPath = readArgFromArgv(argv, "--write-md");
    if (writeMdPath) {
      fs.mkdirSync(path.dirname(writeMdPath), { recursive: true });
      fs.writeFileSync(writeMdPath, buildMarkdown(summary), "utf8");
    }
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (entryPath && currentPath === entryPath) {
  void main().catch((error) => {
    console.log(JSON.stringify({
      ok: false,
      // Validation output is often copied into CI/staging tickets. Raw
      // storage/Prisma errors may contain private bucket or DB information.
      error: "validation_failed",
      hint: "Use --env-file or configure OBJECT_STORAGE_* / S3_* before running the Phase B validation.",
    }, null, 2));
    process.exit(1);
  });
}
