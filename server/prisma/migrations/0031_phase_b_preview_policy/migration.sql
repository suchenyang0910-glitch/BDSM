ALTER TABLE "contents"
  ADD COLUMN "preview_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "preview_duration_seconds" INTEGER NOT NULL DEFAULT 60;

UPDATE "contents"
SET "preview_duration_seconds" = 60
WHERE "preview_duration_seconds" NOT IN (30, 60, 90);
