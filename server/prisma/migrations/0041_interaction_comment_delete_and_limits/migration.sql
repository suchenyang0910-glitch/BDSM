ALTER TABLE "interaction_comments"
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

ALTER TABLE "interaction_comments"
  ALTER COLUMN "body" TYPE VARCHAR(500);

DROP INDEX IF EXISTS "interaction_reports_open_dedupe_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "interaction_reports_open_dedupe_idx"
  ON "interaction_reports"("reporter_user_id", "target_type", "target_id", COALESCE("comment_id", ''))
  WHERE "status" IN ('open', 'reviewing');
