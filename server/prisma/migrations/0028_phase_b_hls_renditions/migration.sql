CREATE TYPE "VideoRenditionKind" AS ENUM ('preview', 'hls_1080', 'hls_720', 'hls_480');
CREATE TYPE "VideoRenditionStatus" AS ENUM ('pending', 'processing', 'ready', 'failed', 'deleted');

ALTER TABLE "transcode_jobs_v2"
  ADD COLUMN "worker_id" VARCHAR(64),
  ADD COLUMN "lease_until" TIMESTAMPTZ,
  ADD COLUMN "last_heartbeat_at" TIMESTAMPTZ,
  ADD COLUMN "progress_percent" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "video_renditions" (
  "id" TEXT NOT NULL,
  "content_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "kind" "VideoRenditionKind" NOT NULL,
  "status" "VideoRenditionStatus" NOT NULL DEFAULT 'pending',
  "manifest_key" VARCHAR(1024),
  "prefix_key" VARCHAR(1024),
  "width" INTEGER,
  "height" INTEGER,
  "bitrate_kbps" INTEGER,
  "duration_seconds" INTEGER,
  "segment_count" INTEGER,
  "byte_size" BIGINT,
  "error_class" VARCHAR(64),
  "ready_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "video_renditions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "video_renditions_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "video_renditions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "video_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "video_renditions_asset_id_kind_key"
  ON "video_renditions"("asset_id", "kind");

CREATE INDEX "video_renditions_content_id_status_updated_at_idx"
  ON "video_renditions"("content_id", "status", "updated_at");

CREATE INDEX "video_renditions_asset_id_status_updated_at_idx"
  ON "video_renditions"("asset_id", "status", "updated_at");

CREATE INDEX "video_renditions_status_updated_at_idx"
  ON "video_renditions"("status", "updated_at");

CREATE INDEX "transcode_jobs_v2_status_lease_until_idx"
  ON "transcode_jobs_v2"("status", "lease_until");

CREATE INDEX "transcode_jobs_v2_worker_id_status_idx"
  ON "transcode_jobs_v2"("worker_id", "status");
