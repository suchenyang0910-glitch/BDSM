-- Dedicated historical cover backfill queue.  Jobs only extract a still from
-- an already verified full source; they never enter the HLS transcode queue.
CREATE TYPE "CoverDerivationJobStatus" AS ENUM ('queued', 'processing', 'paused', 'ready', 'failed', 'cancelled');

CREATE TABLE "cover_derivation_jobs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "content_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "status" "CoverDerivationJobStatus" NOT NULL DEFAULT 'queued',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "error_class" VARCHAR(64),
  "worker_id" VARCHAR(64),
  "lease_until" TIMESTAMPTZ,
  "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ,
  "requested_by" VARCHAR(64),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cover_derivation_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cover_derivation_jobs_asset_id_key" ON "cover_derivation_jobs"("asset_id");
CREATE INDEX "cover_derivation_jobs_status_queued_at_idx" ON "cover_derivation_jobs"("status", "queued_at");
CREATE INDEX "cover_derivation_jobs_content_id_status_idx" ON "cover_derivation_jobs"("content_id", "status");
CREATE INDEX "cover_derivation_jobs_status_lease_until_idx" ON "cover_derivation_jobs"("status", "lease_until");
ALTER TABLE "cover_derivation_jobs" ADD CONSTRAINT "cover_derivation_jobs_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cover_derivation_jobs" ADD CONSTRAINT "cover_derivation_jobs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "video_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
