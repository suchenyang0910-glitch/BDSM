CREATE TYPE "PlaybackRevokeReason" AS ENUM (
  'refund',
  'entitlement_revoked',
  'entitlement_expired',
  'content_unpublished',
  'user_suspended',
  'manual_admin'
);

CREATE TYPE "PlaybackRevokeOutboxStatus" AS ENUM (
  'queued',
  'processing',
  'applied',
  'failed'
);

CREATE TABLE "playback_revoke_outbox" (
  "id" TEXT NOT NULL,
  "user_id" TEXT,
  "content_id" TEXT,
  "entitlement_id" TEXT,
  "source_order_id" TEXT,
  "requested_by_admin_id" TEXT,
  "reason" "PlaybackRevokeReason" NOT NULL,
  "status" "PlaybackRevokeOutboxStatus" NOT NULL DEFAULT 'queued',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error_class" VARCHAR(64),
  "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ,
  "processed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "playback_revoke_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "playback_revoke_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "playback_revoke_outbox_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "playback_revoke_outbox_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "entitlements"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "playback_revoke_outbox_source_order_id_fkey" FOREIGN KEY ("source_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "playback_revoke_outbox_requested_by_admin_id_fkey" FOREIGN KEY ("requested_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "playback_revoke_outbox_status_available_at_created_at_idx"
  ON "playback_revoke_outbox" ("status", "available_at", "created_at");

CREATE INDEX "playback_revoke_outbox_user_id_status_created_at_idx"
  ON "playback_revoke_outbox" ("user_id", "status", "created_at");

CREATE INDEX "playback_revoke_outbox_content_id_status_created_at_idx"
  ON "playback_revoke_outbox" ("content_id", "status", "created_at");

CREATE INDEX "playback_revoke_outbox_entitlement_id_status_created_at_idx"
  ON "playback_revoke_outbox" ("entitlement_id", "status", "created_at");

CREATE INDEX "playback_revoke_outbox_source_order_id_status_created_at_idx"
  ON "playback_revoke_outbox" ("source_order_id", "status", "created_at");
