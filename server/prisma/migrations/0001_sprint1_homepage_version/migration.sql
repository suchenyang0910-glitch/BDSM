-- CreateEnum
CREATE TYPE "HomepageVersionStatus" AS ENUM ('draft', 'published', 'archived');

-- AlterEnum (NO-OP: editor 已在 0000_init_sprint1 CREATE TYPE AdminRole 时创建，重复 ADD VALUE 会 42710，跳过)
-- ALTER TYPE "AdminRole" ADD VALUE 'editor';

-- CreateTable
CREATE TABLE "homepage_versions" (
    "id" TEXT NOT NULL,
    "version_label" TEXT,
    "status" "HomepageVersionStatus" NOT NULL DEFAULT 'draft',
    "config" JSONB NOT NULL,
    "published_at" TIMESTAMP(3),
    "published_by" TEXT,
    "note" TEXT,
    "published_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "homepage_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "homepage_versions_status_idx" ON "homepage_versions"("status");

-- AddForeignKey
ALTER TABLE "homepage_versions" ADD CONSTRAINT "homepage_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 部分唯一索引：确保 published 版本唯一（允许多 draft/archived）
CREATE UNIQUE INDEX IF NOT EXISTS homepage_versions_one_published ON "homepage_versions" ("status") WHERE "status" = 'published';

