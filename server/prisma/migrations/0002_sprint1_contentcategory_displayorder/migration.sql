
-- Sprint 1：内容与分类关联的运营排序和操作人。
ALTER TABLE "content_categories"
  ADD COLUMN IF NOT EXISTS "display_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "assigned_by" TEXT;

CREATE INDEX IF NOT EXISTS "content_categories_display_order_idx"
  ON "content_categories"("display_order");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_categories_assigned_by_fkey'
  ) THEN
    ALTER TABLE "content_categories"
      ADD CONSTRAINT "content_categories_assigned_by_fkey"
      FOREIGN KEY ("assigned_by") REFERENCES "admin_users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
