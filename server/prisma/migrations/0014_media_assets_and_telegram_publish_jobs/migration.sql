-- ============================================================
-- 0014 media_assets + telegram_publish_jobs
-- 阶段：素材上传 + Bot 异步发布任务（P0 S1）
-- 安全规则：
--   · 频道 chatId 绝不明文保存在 telegram_publish_jobs 表中；
--     目标频道仅存 target_free_channel_code（免费白名代码码）
--     或 target_chat_fingerprint（HMAC-SHA-256 脱敏指纹，
--     用于在 AdminManagedChannel 中反查，不可反推原 chatId）。
--   · media_assets.storage_key 与 storage_public_url 不能包含 chatId / Bot Token / 签名凭证。
--   · 任何异常在服务端由 emitSafetyEvent 结构化落审计，前端仅收到 userError 中文提示。
-- ============================================================

CREATE TYPE "MediaAssetKind" AS ENUM ('cover_image', 'preview_video', 'full_video');
CREATE TYPE "MediaAssetStatus" AS ENUM ('initialized', 'uploading', 'ready', 'failed', 'deleted');
CREATE TYPE "MediaAssetStorageBackend" AS ENUM ('s3_compatible', 'local_disk');

CREATE TYPE "TelegramPublishChannelKind" AS ENUM ('public_free_preview', 'membership_full', 'package_full', 'manual_target');
CREATE TYPE "TelegramPublishJobStatus" AS ENUM ('queued', 'processing', 'sent', 'failed', 'retried_exhausted', 'cancelled');

CREATE TABLE "media_assets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" "MediaAssetKind" NOT NULL,
  "status" "MediaAssetStatus" NOT NULL DEFAULT 'initialized',
  "storage_backend" "MediaAssetStorageBackend" NOT NULL DEFAULT 's3_compatible',
  "owner_admin_id" VARCHAR(64),
  "original_filename" VARCHAR(512),
  "mime_type" VARCHAR(128),
  "content_length" BIGINT,
  "checksum_sha256" VARCHAR(64),
  "storage_bucket" VARCHAR(128),
  "storage_region" VARCHAR(64),
  "storage_key" VARCHAR(1024),
  "storage_etag" VARCHAR(128),
  "storage_upload_id" VARCHAR(256),
  "storage_public_url" VARCHAR(1024),
  "duration_seconds" INTEGER,
  "width_pixels" INTEGER,
  "height_pixels" INTEGER,
  "has_watermark" BOOLEAN,
  "last_error_class" VARCHAR(128),
  "last_error_note" VARCHAR(500),
  "note" VARCHAR(500),
  "expires_at" TIMESTAMPTZ,
  "last_verified_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "idx_media_assets_status_created_at" ON "media_assets"("status" ASC, "created_at" DESC);
CREATE INDEX "idx_media_assets_kind_status" ON "media_assets"("kind" ASC, "status" ASC);
CREATE INDEX "idx_media_assets_owner_admin_id_created_at" ON "media_assets"("owner_admin_id" ASC, "created_at" DESC);
CREATE INDEX "idx_media_assets_storage_bucket_storage_key" ON "media_assets"("storage_bucket" ASC, "storage_key" ASC);
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_admin_id_fkey"
  FOREIGN KEY ("owner_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "contents"
  ADD COLUMN "cover_asset_id" VARCHAR(64),
  ADD COLUMN "preview_asset_id" VARCHAR(64),
  ADD COLUMN "full_video_asset_id" VARCHAR(64);

ALTER TABLE "contents" ADD CONSTRAINT "contents_cover_asset_id_fkey"
  FOREIGN KEY ("cover_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "contents" ADD CONSTRAINT "contents_preview_asset_id_fkey"
  FOREIGN KEY ("preview_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "contents" ADD CONSTRAINT "contents_full_video_asset_id_fkey"
  FOREIGN KEY ("full_video_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_contents_cover_asset_id" ON "contents"("cover_asset_id" ASC);
CREATE INDEX "idx_contents_preview_asset_id" ON "contents"("preview_asset_id" ASC);
CREATE INDEX "idx_contents_full_video_asset_id" ON "contents"("full_video_asset_id" ASC);

ALTER TABLE "content_packages"
  ADD COLUMN "cover_asset_id" VARCHAR(64),
  ADD COLUMN "preview_asset_id" VARCHAR(64);

ALTER TABLE "content_packages" ADD CONSTRAINT "content_packages_cover_asset_id_fkey"
  FOREIGN KEY ("cover_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "content_packages" ADD CONSTRAINT "content_packages_preview_asset_id_fkey"
  FOREIGN KEY ("preview_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_content_packages_cover_asset_id" ON "content_packages"("cover_asset_id" ASC);
CREATE INDEX "idx_content_packages_preview_asset_id" ON "content_packages"("preview_asset_id" ASC);

CREATE TABLE "telegram_publish_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "content_id" VARCHAR(64),
  "package_id" VARCHAR(64),
  "admin_id" VARCHAR(64),
  "media_asset_id" VARCHAR(64) NOT NULL,
  "channel_kind" "TelegramPublishChannelKind" NOT NULL,
  "target_free_channel_code" VARCHAR(64),
  "target_chat_fingerprint" VARCHAR(128),
  "target_chat_masked" VARCHAR(32),
  "status" "TelegramPublishJobStatus" NOT NULL DEFAULT 'queued',
  "queue_name" VARCHAR(128) NOT NULL DEFAULT 'telegram-publish-default',
  "bot_key" VARCHAR(64) NOT NULL DEFAULT 'primary',
  "job_token" VARCHAR(64) NOT NULL,
  "telegram_method" VARCHAR(64),
  "telegram_message_id" BIGINT,
  "telegram_file_id" VARCHAR(512),
  "telegram_file_unique_id" VARCHAR(256),
  "caption_text" TEXT,
  "parse_mode" VARCHAR(32),
  "send_options_json" JSONB,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "last_error_class" VARCHAR(128),
  "last_error_note" VARCHAR(500),
  "last_attempted_at" TIMESTAMPTZ,
  "next_retry_at" TIMESTAMPTZ,
  "sent_at" TIMESTAMPTZ,
  "cancelled_at" TIMESTAMPTZ,
  "cancelled_by_admin_id" VARCHAR(64),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "telegram_publish_jobs_job_token_key" ON "telegram_publish_jobs"("job_token" ASC);

CREATE INDEX "idx_telegram_publish_jobs_status_created_at" ON "telegram_publish_jobs"("status" ASC, "created_at" DESC);
CREATE INDEX "idx_telegram_publish_jobs_content_id_created_at" ON "telegram_publish_jobs"("content_id" ASC, "created_at" DESC);
CREATE INDEX "idx_telegram_publish_jobs_package_id_created_at" ON "telegram_publish_jobs"("package_id" ASC, "created_at" DESC);
CREATE INDEX "idx_telegram_publish_jobs_media_asset_id" ON "telegram_publish_jobs"("media_asset_id" ASC);
CREATE INDEX "idx_telegram_publish_jobs_admin_id_created_at" ON "telegram_publish_jobs"("admin_id" ASC, "created_at" DESC);
CREATE INDEX "idx_telegram_publish_jobs_channel_kind_status" ON "telegram_publish_jobs"("channel_kind" ASC, "status" ASC);
CREATE INDEX "idx_telegram_publish_jobs_next_retry_at_status" ON "telegram_publish_jobs"("next_retry_at" ASC, "status" ASC)
  WHERE "status" IN ('queued', 'failed');

ALTER TABLE "telegram_publish_jobs" ADD CONSTRAINT "telegram_publish_jobs_content_id_fkey"
  FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_publish_jobs" ADD CONSTRAINT "telegram_publish_jobs_package_id_fkey"
  FOREIGN KEY ("package_id") REFERENCES "content_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_publish_jobs" ADD CONSTRAINT "telegram_publish_jobs_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "telegram_publish_jobs" ADD CONSTRAINT "telegram_publish_jobs_cancelled_by_admin_id_fkey"
  FOREIGN KEY ("cancelled_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "telegram_publish_jobs" ADD CONSTRAINT "telegram_publish_jobs_media_asset_id_fkey"
  FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 【S1 手动登记兼容】仍保留 contents.telegram_message_id 等旧列，
-- 因为 Contents.tsx Drawer 仍提供旧「人工登记模式」入口作为兜底。
-- 本迁移不删任何旧列；明文 channel_id 列删除由独立 migration 后续执行。
-- 【严格红线】：在 DATABASE_URL_TEST 未配、Caddy 未 deploy、
--   seed-channels-encrypt --dry-run 未跑前，本迁移 0014 不得在任何真实库执行。
-- ============================================================
