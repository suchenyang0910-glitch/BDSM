ALTER TABLE "users"
  ADD COLUMN "telegram_first_name" TEXT,
  ADD COLUMN "telegram_last_name" TEXT,
  ADD COLUMN "telegram_language_code" TEXT,
  ADD COLUMN "last_telegram_seen_at" TIMESTAMPTZ;

CREATE INDEX "users_telegram_user_id_last_telegram_seen_at_idx"
  ON "users" ("telegram_user_id", "last_telegram_seen_at");
