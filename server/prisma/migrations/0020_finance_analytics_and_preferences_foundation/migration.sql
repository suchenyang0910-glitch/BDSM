DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnalyticsPlatform') THEN
    CREATE TYPE "AnalyticsPlatform" AS ENUM ('h5', 'telegram_mini_app', 'server', 'unknown');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PreferenceType') THEN
    CREATE TYPE "PreferenceType" AS ENUM ('content_topic', 'content_format', 'discovery_mode', 'notification');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PreferenceSource') THEN
    CREATE TYPE "PreferenceSource" AS ENUM ('guest_onboarding', 'my_preferences', 'first_browse_prompt', 'migration_confirmed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "analytics_events" (
  "id" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "event_name" VARCHAR(64) NOT NULL,
  "user_id" TEXT,
  "anonymous_id_hmac" VARCHAR(64) NOT NULL,
  "user_id_hmac" VARCHAR(64),
  "session_id_hmac" VARCHAR(64) NOT NULL,
  "platform" "AnalyticsPlatform" NOT NULL DEFAULT 'unknown',
  "properties_json" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "analytics_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "analytics_daily_aggregates" (
  "id" TEXT NOT NULL,
  "stat_date" DATE NOT NULL,
  "event_name" VARCHAR(64) NOT NULL,
  "platform" "AnalyticsPlatform" NOT NULL DEFAULT 'unknown',
  "group_key" VARCHAR(64),
  "group_value" VARCHAR(128),
  "sample_count" INTEGER NOT NULL DEFAULT 0,
  "unique_sessions" INTEGER NOT NULL DEFAULT 0,
  "unique_anonymous" INTEGER NOT NULL DEFAULT 0,
  "unique_users" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "analytics_daily_aggregates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "user_content_preferences" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "category_id" TEXT,
  "preference_type" "PreferenceType" NOT NULL,
  "value_key" VARCHAR(64) NOT NULL,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "source" "PreferenceSource" NOT NULL DEFAULT 'my_preferences',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_content_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_content_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_content_preferences_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "categories"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "analytics_events_event_name_occurred_at_idx"
  ON "analytics_events"("event_name", "occurred_at");
CREATE INDEX IF NOT EXISTS "analytics_events_platform_event_name_occurred_at_idx"
  ON "analytics_events"("platform", "event_name", "occurred_at");
CREATE INDEX IF NOT EXISTS "analytics_events_session_id_hmac_occurred_at_idx"
  ON "analytics_events"("session_id_hmac", "occurred_at");
CREATE INDEX IF NOT EXISTS "analytics_events_anonymous_id_hmac_occurred_at_idx"
  ON "analytics_events"("anonymous_id_hmac", "occurred_at");
CREATE INDEX IF NOT EXISTS "analytics_events_user_id_occurred_at_idx"
  ON "analytics_events"("user_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "analytics_daily_aggregates_stat_date_event_name_idx"
  ON "analytics_daily_aggregates"("stat_date", "event_name");
CREATE INDEX IF NOT EXISTS "analytics_daily_aggregates_platform_stat_date_idx"
  ON "analytics_daily_aggregates"("platform", "stat_date");
CREATE INDEX IF NOT EXISTS "analytics_daily_aggregates_group_key_group_value_stat_date_idx"
  ON "analytics_daily_aggregates"("group_key", "group_value", "stat_date");

CREATE UNIQUE INDEX IF NOT EXISTS "user_content_preferences_user_id_preference_type_value_key_category_id_key"
  ON "user_content_preferences"("user_id", "preference_type", "value_key", COALESCE("category_id", ''));
CREATE INDEX IF NOT EXISTS "user_content_preferences_user_id_preference_type_is_enabled_idx"
  ON "user_content_preferences"("user_id", "preference_type", "is_enabled");
CREATE INDEX IF NOT EXISTS "user_content_preferences_category_id_preference_type_idx"
  ON "user_content_preferences"("category_id", "preference_type");
