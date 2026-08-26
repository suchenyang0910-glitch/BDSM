CREATE TYPE "PlaybackSessionStatus" AS ENUM ('active', 'revoked', 'expired');
CREATE TYPE "PlaybackDeliveryMode" AS ENUM ('poc', 'enabled');

ALTER TABLE "contents"
  ADD COLUMN "platform_playback_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "watch_events"
  ADD COLUMN "session_id" TEXT,
  ADD COLUMN "source" VARCHAR(32),
  ADD COLUMN "error_class" VARCHAR(64);

CREATE TABLE "playback_sessions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "content_id" TEXT NOT NULL,
  "entitlement_id" TEXT,
  "status" "PlaybackSessionStatus" NOT NULL DEFAULT 'active',
  "delivery_mode" "PlaybackDeliveryMode" NOT NULL,
  "device_hash" VARCHAR(128) NOT NULL,
  "entitlement_version" INTEGER NOT NULL DEFAULT 1,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ,
  "last_heartbeat_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "playback_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "playback_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "playback_sessions_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "playback_sessions_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "entitlements"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "playback_grants" (
  "id" TEXT NOT NULL,
  "playback_session_id" TEXT NOT NULL,
  "content_id" TEXT NOT NULL,
  "token_fingerprint" VARCHAR(128) NOT NULL,
  "scope_path" VARCHAR(512) NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "playback_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "playback_grants_playback_session_id_fkey" FOREIGN KEY ("playback_session_id") REFERENCES "playback_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "playback_grants_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "playback_grants_token_fingerprint_key"
  ON "playback_grants" ("token_fingerprint");

CREATE INDEX "playback_sessions_user_id_status_expires_at_idx"
  ON "playback_sessions" ("user_id", "status", "expires_at");

CREATE INDEX "playback_sessions_content_id_status_idx"
  ON "playback_sessions" ("content_id", "status");

CREATE INDEX "playback_sessions_entitlement_id_status_idx"
  ON "playback_sessions" ("entitlement_id", "status");

CREATE INDEX "playback_sessions_device_hash_status_expires_at_idx"
  ON "playback_sessions" ("device_hash", "status", "expires_at");

CREATE INDEX "playback_sessions_status_expires_at_idx"
  ON "playback_sessions" ("status", "expires_at");

CREATE INDEX "playback_grants_playback_session_id_expires_at_idx"
  ON "playback_grants" ("playback_session_id", "expires_at");

CREATE INDEX "playback_grants_content_id_expires_at_idx"
  ON "playback_grants" ("content_id", "expires_at");

CREATE INDEX "playback_grants_revoked_at_expires_at_idx"
  ON "playback_grants" ("revoked_at", "expires_at");

CREATE INDEX "watch_events_session_id_occurred_at_idx"
  ON "watch_events" ("session_id", "occurred_at");

ALTER TABLE "watch_events"
  ADD CONSTRAINT "watch_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "playback_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
