-- 统一完整视频资产模型：
-- 1) VideoAsset 成为完整视频唯一真源；
-- 2) Content.full_video_asset_id / content_full_video_segments 改为引用 video_assets；
-- 3) telegram_publish_jobs 对完整视频改用 video_asset_id，media_asset_id 仅保留轻媒体。

-- 把历史 MediaAsset.full_video 映射到 VideoAsset，复用原 UUID，避免内容与分段引用失联。
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
  ma."id",
  ref."content_id",
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
FROM "media_assets" ma
JOIN (
  SELECT DISTINCT "full_video_asset_id" AS "media_asset_id", "id" AS "content_id"
  FROM "contents"
  WHERE "full_video_asset_id" IS NOT NULL
  UNION
  SELECT DISTINCT "media_asset_id", "content_id"
  FROM "content_full_video_segments"
) ref
  ON ref."media_asset_id" = ma."id"
WHERE ma."kind" = 'full_video'
  AND NOT EXISTS (
    SELECT 1 FROM "video_assets" va WHERE va."id" = ma."id"
  );

ALTER TABLE "contents" DROP CONSTRAINT IF EXISTS "contents_full_video_asset_id_fkey";
ALTER TABLE "contents"
  ADD CONSTRAINT "contents_full_video_asset_id_fkey"
  FOREIGN KEY ("full_video_asset_id") REFERENCES "video_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "content_full_video_segments" DROP CONSTRAINT IF EXISTS "content_full_video_segments_media_asset_id_fkey";
DROP INDEX IF EXISTS "content_full_video_segments_content_id_media_asset_id_key";
DROP INDEX IF EXISTS "content_full_video_segments_media_asset_id_idx";
ALTER TABLE "content_full_video_segments" RENAME COLUMN "media_asset_id" TO "video_asset_id";
ALTER TABLE "content_full_video_segments"
  ADD CONSTRAINT "content_full_video_segments_video_asset_id_fkey"
  FOREIGN KEY ("video_asset_id") REFERENCES "video_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "content_full_video_segments_content_id_video_asset_id_key"
  ON "content_full_video_segments"("content_id", "video_asset_id");
CREATE INDEX "content_full_video_segments_video_asset_id_idx"
  ON "content_full_video_segments"("video_asset_id");

ALTER TABLE "telegram_publish_jobs"
  ADD COLUMN "video_asset_id" VARCHAR(64);

UPDATE "telegram_publish_jobs"
SET "video_asset_id" = "media_asset_id"
WHERE "channel_kind" IN ('membership_full', 'package_full')
  AND "video_asset_id" IS NULL
  AND "media_asset_id" IS NOT NULL;

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
