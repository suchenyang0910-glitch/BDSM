ALTER TABLE "transcode_jobs_v2"
  ADD COLUMN IF NOT EXISTS "output_profile" VARCHAR(16) NOT NULL DEFAULT 'standard';
