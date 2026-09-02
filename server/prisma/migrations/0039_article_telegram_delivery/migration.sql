CREATE TYPE "ArticleTelegramDeliveryStatus" AS ENUM ('queued', 'processing', 'sent', 'failed');

CREATE TABLE "article_telegram_deliveries" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "article_id" TEXT NOT NULL,
  "managed_channel_id" TEXT NOT NULL,
  "status" "ArticleTelegramDeliveryStatus" NOT NULL DEFAULT 'queued',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "telegram_message_id" BIGINT,
  "last_error_class" VARCHAR(128),
  "last_error_note" VARCHAR(300),
  "last_attempted_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "article_telegram_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_telegram_deliveries_article_id_managed_channel_id_key"
  ON "article_telegram_deliveries"("article_id", "managed_channel_id");
CREATE INDEX "article_telegram_deliveries_status_created_at_idx"
  ON "article_telegram_deliveries"("status", "created_at");

ALTER TABLE "article_telegram_deliveries"
  ADD CONSTRAINT "article_telegram_deliveries_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "article_telegram_deliveries"
  ADD CONSTRAINT "article_telegram_deliveries_managed_channel_id_fkey"
  FOREIGN KEY ("managed_channel_id") REFERENCES "admin_managed_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
