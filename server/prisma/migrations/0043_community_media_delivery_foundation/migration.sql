ALTER TABLE "community_post_assets"
  ADD COLUMN "upload_session_id" TEXT,
  ADD COLUMN "thumbnail_object_key" TEXT,
  ADD COLUMN "playback_manifest_key" TEXT,
  ADD COLUMN "playback_prefix_key" TEXT;

CREATE TABLE "community_upload_sessions" (
  "id" TEXT NOT NULL,
  "post_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "status" "UploadSessionStatus" NOT NULL DEFAULT 'initiated',
  "object_key" VARCHAR(1024) NOT NULL,
  "original_filename" VARCHAR(512),
  "expected_size" BIGINT NOT NULL,
  "expected_mime" VARCHAR(128) NOT NULL,
  "expected_sha256" VARCHAR(128) NOT NULL,
  "storage_upload_id" VARCHAR(256),
  "part_size" INTEGER,
  "total_parts" INTEGER,
  "uploaded_bytes" BIGINT NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "community_upload_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "community_upload_session_parts" (
  "id" TEXT NOT NULL,
  "upload_session_id" TEXT NOT NULL,
  "part_number" INTEGER NOT NULL,
  "etag" VARCHAR(256) NOT NULL,
  "bytes" BIGINT NOT NULL,
  "checksum" VARCHAR(128),
  "status" "UploadSessionPartStatus" NOT NULL DEFAULT 'uploaded',
  "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "community_upload_session_parts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "community_post_assets_upload_session_id_key" ON "community_post_assets"("upload_session_id");
CREATE UNIQUE INDEX "community_upload_sessions_object_key_key" ON "community_upload_sessions"("object_key");
CREATE UNIQUE INDEX "community_upload_session_parts_upload_session_id_part_number_key"
  ON "community_upload_session_parts"("upload_session_id", "part_number");

CREATE INDEX "community_upload_sessions_post_id_status_created_at_idx"
  ON "community_upload_sessions"("post_id", "status", "created_at" DESC);
CREATE INDEX "community_upload_sessions_asset_id_created_at_idx"
  ON "community_upload_sessions"("asset_id", "created_at" DESC);
CREATE INDEX "community_upload_sessions_created_by_user_id_created_at_idx"
  ON "community_upload_sessions"("created_by_user_id", "created_at" DESC);
CREATE INDEX "community_upload_sessions_expires_at_idx"
  ON "community_upload_sessions"("expires_at");
CREATE INDEX "community_upload_session_parts_upload_session_id_status_part_number_idx"
  ON "community_upload_session_parts"("upload_session_id", "status", "part_number");

ALTER TABLE "community_post_assets"
  ADD CONSTRAINT "community_post_assets_upload_session_id_fkey"
  FOREIGN KEY ("upload_session_id") REFERENCES "community_upload_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "community_upload_sessions"
  ADD CONSTRAINT "community_upload_sessions_post_id_fkey"
  FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_upload_sessions"
  ADD CONSTRAINT "community_upload_sessions_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "community_post_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_upload_sessions"
  ADD CONSTRAINT "community_upload_sessions_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_upload_session_parts"
  ADD CONSTRAINT "community_upload_session_parts_upload_session_id_fkey"
  FOREIGN KEY ("upload_session_id") REFERENCES "community_upload_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
