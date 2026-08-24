-- 完整视频允许按 Telegram 单文件上限拆为多个顺序分段。
-- 保留 contents.full_video_asset_id 作为第一段的向后兼容字段。
CREATE TABLE "content_full_video_segments" (
  "id" TEXT NOT NULL,
  "content_id" VARCHAR(64) NOT NULL,
  "media_asset_id" VARCHAR(64) NOT NULL,
  "segment_order" INTEGER NOT NULL,
  "telegram_message_id" BIGINT,
  "telegram_sent_at" TIMESTAMP(3),
  "telegram_chat_fingerprint" VARCHAR(128),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "content_full_video_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_full_video_segments_content_id_fkey"
    FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "content_full_video_segments_media_asset_id_fkey"
    FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "content_full_video_segments_content_id_segment_order_key"
  ON "content_full_video_segments"("content_id", "segment_order");
CREATE UNIQUE INDEX "content_full_video_segments_content_id_media_asset_id_key"
  ON "content_full_video_segments"("content_id", "media_asset_id");
CREATE INDEX "content_full_video_segments_media_asset_id_idx"
  ON "content_full_video_segments"("media_asset_id");

ALTER TABLE "telegram_publish_jobs"
  ADD COLUMN "content_segment_id" VARCHAR(64),
  ADD COLUMN "segment_order" INTEGER;

ALTER TABLE "telegram_publish_jobs"
  ADD CONSTRAINT "telegram_publish_jobs_content_segment_id_fkey"
  FOREIGN KEY ("content_segment_id") REFERENCES "content_full_video_segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "telegram_publish_jobs_content_segment_id_idx"
  ON "telegram_publish_jobs"("content_segment_id");
CREATE INDEX "telegram_publish_jobs_content_id_channel_kind_segment_order_idx"
  ON "telegram_publish_jobs"("content_id", "channel_kind", "segment_order");

-- 历史的单文件内容自动成为第 1 段；不会复制媒体文件。
INSERT INTO "content_full_video_segments" (
  "id", "content_id", "media_asset_id", "segment_order",
  "telegram_message_id", "telegram_sent_at", "telegram_chat_fingerprint",
  "created_at", "updated_at"
)
SELECT
  md5(random()::text || clock_timestamp()::text || c."id"),
  c."id", c."full_video_asset_id", 1,
  c."telegram_message_id", c."telegram_sent_at", c."telegram_chat_fingerprint",
  c."created_at", CURRENT_TIMESTAMP
FROM "contents" c
WHERE c."full_video_asset_id" IS NOT NULL
ON CONFLICT ("content_id", "media_asset_id") DO NOTHING;
