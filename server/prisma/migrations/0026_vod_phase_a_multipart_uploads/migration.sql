CREATE TYPE "UploadSessionStatus" AS ENUM ('initiated', 'uploading', 'paused', 'completing', 'completed', 'cancelled', 'expired', 'failed');
CREATE TYPE "UploadSessionPartStatus" AS ENUM ('uploaded');

ALTER TABLE "upload_sessions"
  ADD COLUMN "status" "UploadSessionStatus" NOT NULL DEFAULT 'initiated',
  ADD COLUMN "part_size" INTEGER,
  ADD COLUMN "total_parts" INTEGER,
  ADD COLUMN "uploaded_bytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "upload_sessions"
SET "status" = CASE
  WHEN "completed_at" IS NOT NULL THEN 'completed'::"UploadSessionStatus"
  ELSE 'initiated'::"UploadSessionStatus"
END;

CREATE TABLE "upload_session_parts" (
  "id" TEXT NOT NULL,
  "upload_session_id" TEXT NOT NULL,
  "part_number" INTEGER NOT NULL,
  "etag" VARCHAR(256) NOT NULL,
  "bytes" BIGINT NOT NULL,
  "checksum" VARCHAR(128),
  "status" "UploadSessionPartStatus" NOT NULL DEFAULT 'uploaded',
  "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "upload_session_parts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "upload_session_parts_upload_session_id_fkey" FOREIGN KEY ("upload_session_id") REFERENCES "upload_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "upload_session_parts_upload_session_id_part_number_key"
  ON "upload_session_parts"("upload_session_id", "part_number");
CREATE INDEX "upload_session_parts_upload_session_id_status_part_number_idx"
  ON "upload_session_parts"("upload_session_id", "status", "part_number");
CREATE INDEX "upload_sessions_content_id_status_asset_kind_created_at_idx"
  ON "upload_sessions"("content_id", "status", "asset_kind", "created_at");
