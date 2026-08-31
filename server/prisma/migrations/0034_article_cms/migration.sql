CREATE TYPE "ArticleStatus" AS ENUM ('draft', 'published', 'archived');

CREATE TABLE "articles" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "slug" VARCHAR(160) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "body_markdown" TEXT NOT NULL,
  "source_name" VARCHAR(120),
  "source_url" VARCHAR(500),
  "topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "seo_title" VARCHAR(160),
  "seo_description" VARCHAR(300),
  "seo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "geo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "ArticleStatus" NOT NULL DEFAULT 'draft',
  "published_at" TIMESTAMPTZ,
  "created_by" VARCHAR(64),
  "updated_by" VARCHAR(64),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "articles_slug_key" ON "articles" ("slug");
CREATE INDEX "articles_status_published_at_idx" ON "articles" ("status", "published_at");
