-- Fix: banners.action_label DEFAULT utf8 (was encoded incorrectly in 0000)
ALTER TABLE "banners" ALTER COLUMN "action_label" SET DEFAULT '查看';

-- Fix: content_categories missing index on category_id (was only PK+displayOrder in 0000/0002)
CREATE INDEX IF NOT EXISTS "content_categories_category_id_idx" ON "content_categories"("category_id");
