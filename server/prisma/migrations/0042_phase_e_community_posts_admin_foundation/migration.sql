CREATE TYPE "CommunityPostStatus" AS ENUM ('pending', 'published', 'hidden', 'removed');
CREATE TYPE "CommunityPostVisibility" AS ENUM ('public');
CREATE TYPE "CommunityPostAssetKind" AS ENUM ('image', 'video');
CREATE TYPE "CommunityPostAssetTranscodeStatus" AS ENUM ('pending', 'processing', 'ready', 'failed');
CREATE TYPE "CommunityPostAssetModerationStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE "community_posts" (
  "id" TEXT NOT NULL,
  "author_id" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "CommunityPostStatus" NOT NULL DEFAULT 'pending',
  "visibility" "CommunityPostVisibility" NOT NULL DEFAULT 'public',
  "media_count" INTEGER NOT NULL DEFAULT 0,
  "reaction_count" INTEGER NOT NULL DEFAULT 0,
  "comment_count" INTEGER NOT NULL DEFAULT 0,
  "report_count" INTEGER NOT NULL DEFAULT 0,
  "is_pinned" BOOLEAN NOT NULL DEFAULT false,
  "pinned_at" TIMESTAMP(3),
  "moderation_reason" VARCHAR(500),
  "published_at" TIMESTAMP(3),
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "community_post_assets" (
  "id" TEXT NOT NULL,
  "post_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "kind" "CommunityPostAssetKind" NOT NULL,
  "original_asset_id" VARCHAR(64),
  "poster_asset_id" VARCHAR(64),
  "object_key" TEXT,
  "poster_object_key" TEXT,
  "aspect_ratio" DOUBLE PRECISION,
  "width" INTEGER,
  "height" INTEGER,
  "duration_seconds" INTEGER,
  "transcode_status" "CommunityPostAssetTranscodeStatus" NOT NULL DEFAULT 'pending',
  "transcode_progress_percent" INTEGER NOT NULL DEFAULT 0,
  "moderation_status" "CommunityPostAssetModerationStatus" NOT NULL DEFAULT 'pending',
  "transcode_queue_name" VARCHAR(64) DEFAULT 'community_transcode',
  "playback_quota_bucket" VARCHAR(64) DEFAULT 'community_video',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "community_post_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "community_post_assets_post_id_ordinal_key" ON "community_post_assets"("post_id", "ordinal");
CREATE INDEX "community_posts_status_published_at_idx" ON "community_posts"("status", "published_at" DESC);
CREATE INDEX "community_posts_author_id_created_at_idx" ON "community_posts"("author_id", "created_at" DESC);
CREATE INDEX "community_posts_status_report_count_idx" ON "community_posts"("status", "report_count" DESC);
CREATE INDEX "community_posts_is_pinned_published_at_idx" ON "community_posts"("is_pinned", "published_at" DESC);
CREATE INDEX "community_post_assets_post_id_moderation_status_transcode_status_idx"
  ON "community_post_assets"("post_id", "moderation_status", "transcode_status");
CREATE INDEX "community_post_assets_kind_moderation_status_transcode_status_idx"
  ON "community_post_assets"("kind", "moderation_status", "transcode_status");

ALTER TABLE "community_posts"
  ADD CONSTRAINT "community_posts_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_post_assets"
  ADD CONSTRAINT "community_post_assets_post_id_fkey"
  FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
