import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

import { requireTestDatabaseUrl, extractDbName, assertTestDatabaseName } from "./_testHarness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");
const PRISMA_DIR = path.join(SERVER_ROOT, "prisma");
const CURRENT_SCHEMA_PATH = path.join(PRISMA_DIR, "schema.prisma");
const PRISMA_CLI_PATH = path.join(SERVER_ROOT, "node_modules", "prisma", "build", "index.js");
const CUTOFF_MIGRATION = "0027_unify_full_video_assets_to_video_assets";

function runPrismaCommand(schemaPath: string, args: string[], databaseUrl: string): void {
  const result = spawnSync(process.execPath, [PRISMA_CLI_PATH, ...args, "--schema", schemaPath], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_TEST: databaseUrl },
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status === 0 && !result.error) return;
  const diagnostic = `${String(result.stdout || "")}\n${String(result.stderr || "")}`
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !/(postgres(?:ql)?:\/\/|password|database_url)/i.test(line))
    .slice(-20)
    .join(" | ");
  throw new Error(`prisma ${args.join(" ")} failed: ${diagnostic}`);
}

function prepareLegacyPrismaDir(tempRoot: string): string {
  const tempPrismaDir = path.join(tempRoot, "prisma");
  const tempMigrationsDir = path.join(tempPrismaDir, "migrations");
  fs.mkdirSync(tempMigrationsDir, { recursive: true });
  fs.copyFileSync(path.join(PRISMA_DIR, "schema.prisma"), path.join(tempPrismaDir, "schema.prisma"));
  fs.copyFileSync(path.join(PRISMA_DIR, "migrations", "migration_lock.toml"), path.join(tempMigrationsDir, "migration_lock.toml"));
  for (const entry of fs.readdirSync(path.join(PRISMA_DIR, "migrations"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name >= CUTOFF_MIGRATION) continue;
    fs.cpSync(
      path.join(PRISMA_DIR, "migrations", entry.name),
      path.join(tempMigrationsDir, entry.name),
      { recursive: true },
    );
  }
  return path.join(tempPrismaDir, "schema.prisma");
}

async function seedLegacyData(prisma: PrismaClient, input: {
  sharedMediaAssetId: string;
  orphanMediaAssetId: string;
  membershipContentId: string;
  packageContentId: string;
  orphanJobId: string;
}) {
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "media_assets" (
      "id", "kind", "status", "original_filename", "mime_type", "content_length",
      "checksum_sha256", "storage_bucket", "storage_region", "storage_key", "created_at", "updated_at"
    ) VALUES
      (
        '${input.sharedMediaAssetId}',
        'full_video',
        'ready',
        'shared-legacy.mp4',
        'video/mp4',
        2048,
        'legacy-shared-sha256',
        'legacy-private-bucket',
        'local',
        'legacy/shared/video.mp4',
        '${now}'::timestamptz,
        '${now}'::timestamptz
      ),
      (
        '${input.orphanMediaAssetId}',
        'full_video',
        'ready',
        'orphan-legacy.mp4',
        'video/mp4',
        1024,
        'legacy-orphan-sha256',
        'legacy-private-bucket',
        'local',
        'legacy/orphan/video.mp4',
        '${now}'::timestamptz,
        '${now}'::timestamptz
      );
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "contents" (
      "id", "title", "access_type", "status", "sort_order",
      "full_video_asset_id", "created_at", "updated_at"
    ) VALUES
      (
        '${input.membershipContentId}',
        'legacy membership full video',
        'membership',
        'draft',
        0,
        '${input.sharedMediaAssetId}',
        '${now}'::timestamptz,
        '${now}'::timestamptz
      ),
      (
        '${input.packageContentId}',
        'legacy package full video',
        'package',
        'draft',
        1,
        '${input.sharedMediaAssetId}',
        '${now}'::timestamptz,
        '${now}'::timestamptz
      );
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "content_full_video_segments" (
      "id", "content_id", "media_asset_id", "segment_order", "created_at", "updated_at"
    ) VALUES
      (
        '11111111-1111-4111-8111-111111111111',
        '${input.membershipContentId}',
        '${input.sharedMediaAssetId}',
        1,
        '${now}'::timestamp,
        '${now}'::timestamp
      ),
      (
        '22222222-2222-4222-8222-222222222222',
        '${input.packageContentId}',
        '${input.sharedMediaAssetId}',
        1,
        '${now}'::timestamp,
        '${now}'::timestamp
      );
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "telegram_publish_jobs" (
      "id", "media_asset_id", "channel_kind", "status", "job_token", "created_at", "updated_at"
    ) VALUES (
      '${input.orphanJobId}',
      '${input.orphanMediaAssetId}',
      'membership_full',
      'queued',
      'legacy-orphan-job-token-0027',
      '${now}'::timestamptz,
      '${now}'::timestamptz
    );
  `);
}

test("migration 0027 rehearses shared legacy full video and orphan publish job upgrade", async () => {
  const databaseUrl = requireTestDatabaseUrl();
  const dbName = extractDbName(databaseUrl);
  assertTestDatabaseName(dbName);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "intune-migration-0027-"));
  const legacySchemaPath = prepareLegacyPrismaDir(tempRoot);
  const sharedMediaAssetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const orphanMediaAssetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const membershipContentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const packageContentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const orphanJobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  try {
    runPrismaCommand(legacySchemaPath, ["migrate", "reset", "--force", "--skip-seed"], databaseUrl);

    const legacyPrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await legacyPrisma.$connect();
    try {
      await seedLegacyData(legacyPrisma, {
        sharedMediaAssetId,
        orphanMediaAssetId,
        membershipContentId,
        packageContentId,
        orphanJobId,
      });
    } finally {
      await legacyPrisma.$disconnect();
    }

    runPrismaCommand(CURRENT_SCHEMA_PATH, ["migrate", "deploy"], databaseUrl);

    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();
    try {
      const migratedAssets = await prisma.$queryRawUnsafe<Array<{ id: string; contentId: string; objectKey: string }>>(`
        SELECT
          "id"::text AS "id",
          "content_id"::text AS "contentId",
          "object_key"::text AS "objectKey"
        FROM "video_assets"
        WHERE "original_filename" = 'shared-legacy.mp4'
        ORDER BY "content_id" ASC
      `);
      assert.equal(migratedAssets.length, 2, "共享旧视频必须拆出两条 VideoAsset");
      assert.notEqual(migratedAssets[0].id, migratedAssets[1].id, "共享旧视频映射后的 VideoAsset ID 必须不同");
      assert.equal(migratedAssets[0].objectKey, migratedAssets[1].objectKey, "共享旧视频应继续指向同一物理对象 key");

      const contentBindings = await prisma.$queryRawUnsafe<Array<{ contentId: string; fullVideoAssetId: string | null }>>(`
        SELECT
          "id"::text AS "contentId",
          "full_video_asset_id"::text AS "fullVideoAssetId"
        FROM "contents"
        WHERE "id" IN ('${membershipContentId}', '${packageContentId}')
        ORDER BY "id" ASC
      `);
      const assetByContentId = new Map(migratedAssets.map((row) => [row.contentId, row.id]));
      assert.deepEqual(
        contentBindings.map((row) => ({ contentId: row.contentId, fullVideoAssetId: row.fullVideoAssetId })),
        [
          { contentId: membershipContentId, fullVideoAssetId: assetByContentId.get(membershipContentId) || null },
          { contentId: packageContentId, fullVideoAssetId: assetByContentId.get(packageContentId) || null },
        ].sort((left, right) => left.contentId.localeCompare(right.contentId)),
      );

      const segmentBindings = await prisma.$queryRawUnsafe<Array<{ contentId: string; videoAssetId: string }>>(`
        SELECT
          "content_id"::text AS "contentId",
          "video_asset_id"::text AS "videoAssetId"
        FROM "content_full_video_segments"
        WHERE "content_id" IN ('${membershipContentId}', '${packageContentId}')
        ORDER BY "content_id" ASC, "segment_order" ASC
      `);
      assert.deepEqual(
        segmentBindings,
        [
          { contentId: membershipContentId, videoAssetId: assetByContentId.get(membershipContentId)! },
          { contentId: packageContentId, videoAssetId: assetByContentId.get(packageContentId)! },
        ].sort((left, right) => left.contentId.localeCompare(right.contentId)),
      );

      const orphanJobRows = await prisma.$queryRawUnsafe<Array<{
        status: string;
        mediaAssetId: string | null;
        videoAssetId: string | null;
        lastErrorClass: string | null;
        lastErrorNote: string | null;
      }>>(`
        SELECT
          "status"::text AS "status",
          "media_asset_id"::text AS "mediaAssetId",
          "video_asset_id"::text AS "videoAssetId",
          "last_error_class"::text AS "lastErrorClass",
          "last_error_note"::text AS "lastErrorNote"
        FROM "telegram_publish_jobs"
        WHERE "id" = '${orphanJobId}'
      `);
      assert.equal(orphanJobRows.length, 1, "孤立旧发布任务必须保留审计记录");
      assert.equal(orphanJobRows[0].mediaAssetId, orphanMediaAssetId);
      assert.equal(orphanJobRows[0].videoAssetId, null, "孤立旧发布任务不应伪造 video_asset_id");
      assert.equal(orphanJobRows[0].status, "cancelled", "无法映射到 VideoAsset 的旧完整视频任务应在迁移期主动取消");
      assert.equal(orphanJobRows[0].lastErrorClass, "legacy_orphan_full_video_asset");
      assert.equal(orphanJobRows[0].lastErrorNote, "migration_0027_missing_video_asset_mapping");
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    try {
      runPrismaCommand(CURRENT_SCHEMA_PATH, ["migrate", "reset", "--force", "--skip-seed"], databaseUrl);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});
