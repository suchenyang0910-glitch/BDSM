ALTER TABLE "articles"
  ADD COLUMN "body_html" TEXT,
  ADD COLUMN "cover_image_url" VARCHAR(500);

UPDATE "articles"
SET "body_html" = '<p>' || replace(replace(replace(replace("body_markdown", '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), E'\n\n', '</p><p>') || '</p>'
WHERE "body_html" IS NULL;
