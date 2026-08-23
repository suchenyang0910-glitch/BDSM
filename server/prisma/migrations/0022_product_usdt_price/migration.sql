-- Keep the existing primary product price (normally XTR / Stars) unchanged.
-- USDT is an optional alternate checkout price in 1e-6 USDT minor units.
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "usdt_price_minor" BIGINT;
