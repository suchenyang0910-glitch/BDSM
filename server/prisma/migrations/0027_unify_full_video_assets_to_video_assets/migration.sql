-- 统一完整视频资产模型：
-- 1) VideoAsset 成为完整视频唯一真源；
-- 2) Content.full_video_asset_id / content_full_video_segments 改为引用 video_assets；
-- 3) telegram_publish_jobs 对完整视频改用 video_asset_id，media_asset_id 仅保留轻媒体；
-- 4) 历史上同一旧 full_video 被多个内容复用时，按 (media_asset_id, content_id) 拆成多条 VideoAsset；
-- 5) 没有内容映射的历史完整视频发布任务保留审计，但不强行补 video_asset_id，避免迁移加外键失败。

CREATE TEMP TABLE "legacy_full_video_asset_map" (
  "media_asset_id" VARCHAR(64) NOT NULL,
  "content_id" VARCHAR(64) NOT NULL,
  "video_asset_id" VARCHAR(64) NOT NULL,
  PRIMARY KEY ("media_asset_id", "content_id"),
  UNIQUE ("video_asset_id")
) ON COMMIT DROP;

INSERT INTO "legacy_full_video_asset_map" (
  "media_asset_id",
  "content_id",
  "video_asset_id"
)
SELECT DISTINCT
  refs."media_asset_id",
  refs."content_id",
  gen_random_uuid()::text
FROM (
  SELECT "full_video_asset_id" AS "media_asset_id", "id" AS "content_id"
  FROM "contents"
  WHERE "full_video_asset_id" IS NOT NULL
  UNION
  SELECT "media_asset_id", "content_id"
  FROM "content_full_video_segments"
  WHERE "media_asset_id" IS NOT NULL
) refs
JOIN "media_assets" ma
  ON ma."id" = refs."media_asset_id"
WHERE ma."kind" = 'full_video';

DROP INDEX IF EXISTS "video_assets_object_key_key";

INSERT INTO "video_assets" (
  "id",
  "content_id",
  "upload_session_id",
  "kind",
  "object_key",
  "original_filename",
  "mime_type",
  "byte_size",
  "sha256",
  "status",
  "error_class",
  "verified_at",
  "deleted_at",
  "created_at",
  "updated_at"
)
SELECT
  map."video_asset_id",
  map."content_id",
  NULL,
  'full_source'::"VideoAssetKind",
  COALESCE(NULLIF(ma."storage_key", ''), 'legacy/full/' || ma."id"),
  ma."original_filename",
  COALESCE(NULLIF(ma."mime_type", ''), 'video/mp4'),
  COALESCE(ma."content_length", 0),
  COALESCE(NULLIF(ma."checksum_sha256", ''), 'legacy-media-asset:' || ma."id"),
  CASE ma."status"
    WHEN 'ready' THEN 'verified'::"VideoAssetStatus"
    WHEN 'failed' THEN 'failed'::"VideoAssetStatus"
    WHEN 'deleted' THEN 'deleted'::"VideoAssetStatus"
    WHEN 'uploading' THEN 'uploaded'::"VideoAssetStatus"
    ELSE 'pending_upload'::"VideoAssetStatus"
  END,
  ma."last_error_class",
  ma."last_verified_at",
  CASE WHEN ma."status" = 'deleted' THEN ma."updated_at" ELSE NULL END,
  ma."created_at",
  ma."updated_at"
FROM "legacy_full_video_asset_map" map
JOIN "media_assets" ma
  ON ma."id" = map."media_asset_id"
ON CONFLICT ("id") DO NOTHING;

CREATE INDEX IF NOT EXISTS "video_assets_object_key_idx"
  ON "video_assets"("object_key");

ALTER TABLE "contents" DROP CONSTRAINT IF EXISTS "contents_full_video_asset_id_fkey";

UPDATE "contents" c
SET "full_video_asset_id" = map."video_asset_id"
FROM "legacy_full_video_asset_map" map
WHERE c."id" = map."content_id"
  AND c."full_video_asset_id" = map."media_asset_id";

UPDATE "contents" c
SET "full_video_asset_id" = NULL
WHERE c."full_video_asset_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "video_assets" va
    WHERE va."id" = c."full_video_asset_id"
  );

ALTER TABLE "contents"
  ADD CONSTRAINT "contents_full_video_asset_id_fkey"
  FOREIGN KEY ("full_video_asset_id") REFERENCES "video_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "telegram_publish_jobs"
  ADD COLUMN "video_asset_id" VARCHAR(64);

UPDATE "telegram_publish_jobs" job
SET "video_asset_id" = map."video_asset_id"
FROM "legacy_full_video_asset_map" map
WHERE job."channel_kind" IN ('membership_full', 'package_full')
  AND job."video_asset_id" IS NULL
  AND job."content_id" = map."content_id"
  AND job."media_asset_id" = map."media_asset_id";

UPDATE "telegram_publish_jobs" job
SET "video_asset_id" = map."video_asset_id"
FROM "content_full_video_segments" seg
JOIN "legacy_full_video_asset_map" map
  ON map."content_id" = seg."content_id"
 AND map."media_asset_id" = seg."media_asset_id"
WHERE job."channel_kind" IN ('membership_full', 'package_full')
  AND job."video_asset_id" IS NULL
  AND job."content_segment_id" = seg."id";

UPDATE "telegram_publish_jobs"
SET
  "status" = CASE
    WHEN "status" IN ('queued', 'processing', 'failed') THEN 'cancelled'::"TelegramPublishJobStatus"
    ELSE "status"
  END,
  "cancelled_at" = CASE
    WHEN "status" IN ('queued', 'processing', 'failed') AND "cancelled_at" IS NULL THEN CURRENT_TIMESTAMP
    ELSE "cancelled_at"
  END,
  "last_error_class" = COALESCE("last_error_class", 'legacy_orphan_full_video_asset'),
  "last_error_note" = COALESCE("last_error_note", 'migration_0027_missing_video_asset_mapping')
WHERE "channel_kind" IN ('membership_full', 'package_full')
  AND "media_asset_id" IS NOT NULL
  AND "video_asset_id" IS NULL;

ALTER TABLE "content_full_video_segments" DROP CONSTRAINT IF EXISTS "content_full_video_segments_media_asset_id_fkey";
DROP INDEX IF EXISTS "content_full_video_segments_content_id_media_asset_id_key";
DROP INDEX IF EXISTS "content_full_video_segments_media_asset_id_idx";

DELETE FROM "content_full_video_segments" seg
WHERE NOT EXISTS (
  SELECT 1
  FROM "legacy_full_video_asset_map" map
  WHERE map."content_id" = seg."content_id"
    AND map."media_asset_id" = seg."media_asset_id"
);

UPDATE "content_full_video_segments" seg
SET "media_asset_id" = map."video_asset_id"
FROM "legacy_full_video_asset_map" map
WHERE seg."content_id" = map."content_id"
  AND seg."media_asset_id" = map."media_asset_id";

ALTER TABLE "content_full_video_segments" RENAME COLUMN "media_asset_id" TO "video_asset_id";
ALTER TABLE "content_full_video_segments"
  ADD CONSTRAINT "content_full_video_segments_video_asset_id_fkey"
  FOREIGN KEY ("video_asset_id") REFERENCES "video_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "content_full_video_segments_content_id_video_asset_id_key"
  ON "content_full_video_segments"("content_id", "video_asset_id");
CREATE INDEX "content_full_video_segments_video_asset_id_idx"
  ON "content_full_video_segments"("video_asset_id");

ALTER TABLE "telegram_publish_jobs" DROP CONSTRAINT IF EXISTS "telegram_publish_jobs_media_asset_id_fkey";
ALTER TABLE "telegram_publish_jobs"
  ALTER COLUMN "media_asset_id" DROP NOT NULL;
ALTER TABLE "telegram_publish_jobs"
  ADD CONSTRAINT "telegram_publish_jobs_media_asset_id_fkey"
  FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_publish_jobs"
  ADD CONSTRAINT "telegram_publish_jobs_video_asset_id_fkey"
  FOREIGN KEY ("video_asset_id") REFERENCES "video_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "telegram_publish_jobs_video_asset_id_idx"
  ON "telegram_publish_jobs"("video_asset_id");
