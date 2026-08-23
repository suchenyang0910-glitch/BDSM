ALTER TABLE "contents"
  ADD COLUMN "seo_title" VARCHAR(120),
  ADD COLUMN "seo_description" VARCHAR(300),
  ADD COLUMN "seo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "geo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "platform_metadata" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "seo_title" VARCHAR(120),
  "seo_description" VARCHAR(300),
  "seo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "geo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by" TEXT,
  CONSTRAINT "platform_metadata_pkey" PRIMARY KEY ("id")
);

INSERT INTO "platform_metadata" ("id")
VALUES ('default')
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "telegram_publish_jobs"
  ADD COLUMN "telegram_tags_json" JSONB;
