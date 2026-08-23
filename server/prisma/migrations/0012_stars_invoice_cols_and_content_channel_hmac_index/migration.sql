-- Migration 0012: Fix Stars contract, add invoice link cols, fix content channel unique -> index
-- 1. Add Stars invoice link + via cols to orders (nullable, non-unique; same invoice reused for 30min window per user+product)
ALTER TABLE "orders"
  ADD COLUMN "telegram_stars_invoice_link" VARCHAR(512),
  ADD COLUMN "telegram_stars_invoice_via" VARCHAR(32);

CREATE INDEX "idx_orders_stars_invoice_pending"
  ON "orders" ("user_id", "product_id", "status", "payment_method", "created_at")
  WHERE "payment_method" = 'telegram_stars'::"PaymentMethod"
    AND "status" IN ('pending'::"OrderStatus", 'processing'::"OrderStatus");

-- 2. Content.channelIdHmac: DROP legacy UNIQUE constraint -> plain INDEX
--    Reason: same deliver channel contains MANY videos (membership / package) -- unique on hmac would have caused "同频道第二条视频 409 P2002"
--    Migration safety: IF EXISTS DROP; then CREATE INDEX
DROP INDEX IF EXISTS "idx_content_channel_hmac";
DROP INDEX IF EXISTS "contents_channel_id_hmac_key";

CREATE INDEX "idx_content_channel_hmac"
  ON "contents" ("channel_id_hmac")
  WHERE "channel_id_hmac" IS NOT NULL;
