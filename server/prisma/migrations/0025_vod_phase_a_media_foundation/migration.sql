CREATE TYPE "VideoAssetKind" AS ENUM ('cover', 'preview_source', 'full_source');
CREATE TYPE "VideoAssetStatus" AS ENUM ('pending_upload', 'uploaded', 'verified', 'failed', 'deleted');
CREATE TYPE "TranscodeJobStatus" AS ENUM ('queued', 'processing', 'ready', 'failed', 'cancelled');

CREATE TABLE "upload_sessions" (
  "id" TEXT NOT NULL,
  "content_id" TEXT NOT NULL,
  "asset_kind" "VideoAssetKind" NOT NULL,
  "object_key" VARCHAR(1024) NOT NULL,
  "original_filename" VARCHAR(512),
  "expected_size" BIGINT NOT NULL,
  "expected_mime" VARCHAR(128) NOT NULL,
  "expected_sha256" VARCHAR(128) NOT NULL,
  "storage_upload_id" VARCHAR(256),
  "expires_at" TIMESTAMPTZ NOT NULL,
  "completed_at" TIMESTAMPTZ,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "upload_sessions_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "upload_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "video_assets" (
  "id" TEXT NOT NULL,
  "content_id" TEXT NOT NULL,
  "upload_session_id" TEXT,
  "kind" "VideoAssetKind" NOT NULL,
  "object_key" VARCHAR(1024) NOT NULL,
  "original_filename" VARCHAR(512),
  "mime_type" VARCHAR(128) NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "sha256" VARCHAR(128) NOT NULL,
  "status" "VideoAssetStatus" NOT NULL DEFAULT 'pending_upload',
  "error_class" VARCHAR(64),
  "verified_at" TIMESTAMPTZ,
  "deleted_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "video_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "video_assets_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "video_assets_upload_session_id_fkey" FOREIGN KEY ("upload_session_id") REFERENCES "upload_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "video_assets"
  ADD CONSTRAINT "video_assets_upload_session_id_key" UNIQUE ("upload_session_id");

CREATE TABLE "transcode_jobs_v2" (
  "id" TEXT NOT NULL,
  "content_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "status" "TranscodeJobStatus" NOT NULL DEFAULT 'queued',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "error_class" VARCHAR(64),
  "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  CONSTRAINT "transcode_jobs_v2_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transcode_jobs_v2_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "transcode_jobs_v2_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "video_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "transcode_jobs_v2"
  ADD CONSTRAINT "transcode_jobs_v2_asset_id_key" UNIQUE ("asset_id");

CREATE TABLE "watch_events" (
  "id" TEXT NOT NULL,
  "user_id" TEXT,
  "content_id" TEXT NOT NULL,
  "event_name" VARCHAR(64) NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "position_sec" INTEGER,
  "quality" VARCHAR(32),
  CONSTRAINT "watch_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "watch_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "watch_events_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "watch_progresses" (
  "user_id" TEXT NOT NULL,
  "content_id" TEXT NOT NULL,
  "position_sec" INTEGER NOT NULL DEFAULT 0,
  "duration_sec" INTEGER,
  "last_played_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "watch_progresses_pkey" PRIMARY KEY ("user_id", "content_id"),
  CONSTRAINT "watch_progresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "watch_progresses_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "video_assets_object_key_key" ON "video_assets"("object_key");
CREATE INDEX "video_assets_content_id_kind_created_at_idx" ON "video_assets"("content_id", "kind", "created_at");
CREATE INDEX "video_assets_content_id_status_idx" ON "video_assets"("content_id", "status");
CREATE INDEX "video_assets_status_created_at_idx" ON "video_assets"("status", "created_at");

CREATE UNIQUE INDEX "upload_sessions_object_key_key" ON "upload_sessions"("object_key");
CREATE INDEX "upload_sessions_content_id_asset_kind_created_at_idx" ON "upload_sessions"("content_id", "asset_kind", "created_at");
CREATE INDEX "upload_sessions_expires_at_idx" ON "upload_sessions"("expires_at");
CREATE INDEX "upload_sessions_created_by_created_at_idx" ON "upload_sessions"("created_by", "created_at");

CREATE INDEX "transcode_jobs_v2_content_id_status_queued_at_idx" ON "transcode_jobs_v2"("content_id", "status", "queued_at");
CREATE INDEX "transcode_jobs_v2_status_queued_at_idx" ON "transcode_jobs_v2"("status", "queued_at");

CREATE INDEX "watch_events_content_id_event_name_occurred_at_idx" ON "watch_events"("content_id", "event_name", "occurred_at");
CREATE INDEX "watch_events_user_id_occurred_at_idx" ON "watch_events"("user_id", "occurred_at");
CREATE INDEX "watch_events_occurred_at_idx" ON "watch_events"("occurred_at");
CREATE INDEX "watch_progresses_last_played_at_idx" ON "watch_progresses"("last_played_at");
CREATE INDEX "watch_progresses_content_id_last_played_at_idx" ON "watch_progresses"("content_id", "last_played_at");
