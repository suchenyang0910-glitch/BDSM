CREATE TYPE "InteractionTargetType" AS ENUM ('video_content', 'article', 'circle_post');
CREATE TYPE "InteractionSubjectKind" AS ENUM ('target', 'comment');
CREATE TYPE "InteractionCommentStatus" AS ENUM ('pending', 'approved', 'hidden', 'rejected', 'deleted');
CREATE TYPE "InteractionReportStatus" AS ENUM ('open', 'reviewing', 'actioned', 'dismissed');

CREATE TABLE "interaction_comments" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "target_type" "InteractionTargetType" NOT NULL,
  "target_id" VARCHAR(64) NOT NULL,
  "user_id" TEXT NOT NULL,
  "parent_id" TEXT,
  "root_id" TEXT,
  "body" VARCHAR(500) NOT NULL,
  "like_count" INTEGER NOT NULL DEFAULT 0,
  "reply_count" INTEGER NOT NULL DEFAULT 0,
  "status" "InteractionCommentStatus" NOT NULL DEFAULT 'approved',
  "moderation_reason" VARCHAR(500),
  "moderated_by" TEXT,
  "moderated_at" TIMESTAMP(3),
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interaction_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "interaction_likes" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "subject_kind" "InteractionSubjectKind" NOT NULL,
  "subject_key" VARCHAR(160) NOT NULL,
  "target_type" "InteractionTargetType" NOT NULL,
  "target_id" VARCHAR(64) NOT NULL,
  "user_id" TEXT NOT NULL,
  "comment_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interaction_likes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "interaction_reports" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "target_type" "InteractionTargetType" NOT NULL,
  "target_id" VARCHAR(64) NOT NULL,
  "reporter_user_id" TEXT NOT NULL,
  "comment_id" TEXT,
  "reason_code" VARCHAR(32) NOT NULL,
  "detail_text" VARCHAR(500),
  "status" "InteractionReportStatus" NOT NULL DEFAULT 'open',
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "resolution_note" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interaction_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "interaction_comments_target_type_target_id_status_created_at_idx"
  ON "interaction_comments"("target_type", "target_id", "status", "created_at");
CREATE INDEX "interaction_comments_target_type_target_id_parent_id_created_at_idx"
  ON "interaction_comments"("target_type", "target_id", "parent_id", "created_at");
CREATE INDEX "interaction_comments_user_id_created_at_idx"
  ON "interaction_comments"("user_id", "created_at");
CREATE INDEX "interaction_comments_root_id_created_at_idx"
  ON "interaction_comments"("root_id", "created_at");

CREATE UNIQUE INDEX "interaction_likes_user_id_subject_key_key"
  ON "interaction_likes"("user_id", "subject_key");
CREATE INDEX "interaction_likes_target_type_target_id_created_at_idx"
  ON "interaction_likes"("target_type", "target_id", "created_at");
CREATE INDEX "interaction_likes_comment_id_created_at_idx"
  ON "interaction_likes"("comment_id", "created_at");

CREATE INDEX "interaction_reports_target_type_target_id_status_created_at_idx"
  ON "interaction_reports"("target_type", "target_id", "status", "created_at");
CREATE INDEX "interaction_reports_reporter_user_id_created_at_idx"
  ON "interaction_reports"("reporter_user_id", "created_at");
CREATE INDEX "interaction_reports_comment_id_created_at_idx"
  ON "interaction_reports"("comment_id", "created_at");
CREATE UNIQUE INDEX "interaction_reports_open_dedupe_idx"
  ON "interaction_reports"("reporter_user_id", "target_type", "target_id", COALESCE("comment_id", ''))
  WHERE "status" IN ('open', 'reviewing');

ALTER TABLE "interaction_comments"
  ADD CONSTRAINT "interaction_comments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interaction_comments"
  ADD CONSTRAINT "interaction_comments_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "interaction_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interaction_comments"
  ADD CONSTRAINT "interaction_comments_root_id_fkey"
  FOREIGN KEY ("root_id") REFERENCES "interaction_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interaction_comments"
  ADD CONSTRAINT "interaction_comments_moderated_by_fkey"
  FOREIGN KEY ("moderated_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "interaction_likes"
  ADD CONSTRAINT "interaction_likes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interaction_likes"
  ADD CONSTRAINT "interaction_likes_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "interaction_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "interaction_reports"
  ADD CONSTRAINT "interaction_reports_reporter_user_id_fkey"
  FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interaction_reports"
  ADD CONSTRAINT "interaction_reports_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "interaction_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interaction_reports"
  ADD CONSTRAINT "interaction_reports_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
