CREATE TYPE "EntitlementRemovalStatus" AS ENUM (
  'none',
  'grace_period',
  'removed',
  'removal_failed',
  'renewed_during_grace'
);

CREATE TYPE "ChannelDiscoveryLinkType" AS ENUM (
  'public_username',
  'private_invite',
  'unknown'
);

CREATE TYPE "ChannelDiscoveryStatus" AS ENUM (
  'pending_public_check',
  'awaiting_bot_admin',
  'discovered',
  'bound',
  'conflict',
  'failed'
);

CREATE TYPE "ManagedChannelPurpose" AS ENUM (
  'none',
  'free_preview',
  'membership_main',
  'package_channel'
);

ALTER TABLE "entitlements"
  ADD COLUMN "grace_ends_at" TIMESTAMPTZ,
  ADD COLUMN "expiry_reminder_at" TIMESTAMPTZ,
  ADD COLUMN "pre_grace_reminder_at" TIMESTAMPTZ,
  ADD COLUMN "expiry_reminder_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "removal_status" "EntitlementRemovalStatus" NOT NULL DEFAULT 'none',
  ADD COLUMN "removal_attempted_at" TIMESTAMPTZ,
  ADD COLUMN "removed_at" TIMESTAMPTZ,
  ADD COLUMN "last_removal_error_code" VARCHAR(128);

CREATE INDEX "entitlements_grace_ends_at_removal_status_idx"
  ON "entitlements" ("grace_ends_at", "removal_status");

CREATE INDEX "entitlements_resource_type_resource_id_user_id_removal_status_idx"
  ON "entitlements" ("resource_type", "resource_id", "user_id", "removal_status");

ALTER TABLE "admin_managed_channels"
  ADD COLUMN "purpose" "ManagedChannelPurpose" NOT NULL DEFAULT 'none',
  ADD COLUMN "package_id" TEXT,
  ADD COLUMN "public_url" TEXT,
  ADD COLUMN "bot_is_admin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bot_can_post_messages" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bot_can_invite_users" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bot_can_restrict_members" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "last_discovery_update_type" VARCHAR(64),
  ADD COLUMN "discovery_error_code" VARCHAR(128);

CREATE INDEX "admin_managed_channels_purpose_idx"
  ON "admin_managed_channels" ("purpose");

CREATE UNIQUE INDEX "admin_managed_channels_package_id_key"
  ON "admin_managed_channels" ("package_id")
  WHERE "package_id" IS NOT NULL;

ALTER TABLE "admin_managed_channels"
  ADD CONSTRAINT "admin_managed_channels_package_id_fkey"
  FOREIGN KEY ("package_id") REFERENCES "content_packages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "admin_channel_discovery_requests" (
  "id" TEXT NOT NULL,
  "submitted_link" TEXT NOT NULL,
  "normalized_link" TEXT,
  "link_type" "ChannelDiscoveryLinkType" NOT NULL,
  "status" "ChannelDiscoveryStatus" NOT NULL DEFAULT 'awaiting_bot_admin',
  "requested_purpose" "ManagedChannelPurpose" NOT NULL DEFAULT 'none',
  "package_id" TEXT,
  "resolved_channel_id" TEXT,
  "submitted_by_admin_id" TEXT,
  "waiting_since" TIMESTAMPTZ,
  "discovered_at" TIMESTAMPTZ,
  "bound_at" TIMESTAMPTZ,
  "last_error_code" VARCHAR(128),
  "last_error_note" VARCHAR(500),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_channel_discovery_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_channel_discovery_requests_status_created_at_idx"
  ON "admin_channel_discovery_requests" ("status", "created_at");

CREATE INDEX "admin_channel_discovery_requests_link_type_status_idx"
  ON "admin_channel_discovery_requests" ("link_type", "status");

CREATE INDEX "admin_channel_discovery_requests_requested_purpose_package_id_idx"
  ON "admin_channel_discovery_requests" ("requested_purpose", "package_id");

CREATE INDEX "admin_channel_discovery_requests_resolved_channel_id_idx"
  ON "admin_channel_discovery_requests" ("resolved_channel_id");

ALTER TABLE "admin_channel_discovery_requests"
  ADD CONSTRAINT "admin_channel_discovery_requests_package_id_fkey"
  FOREIGN KEY ("package_id") REFERENCES "content_packages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "admin_channel_discovery_requests"
  ADD CONSTRAINT "admin_channel_discovery_requests_resolved_channel_id_fkey"
  FOREIGN KEY ("resolved_channel_id") REFERENCES "admin_managed_channels"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "admin_channel_discovery_requests"
  ADD CONSTRAINT "admin_channel_discovery_requests_submitted_by_admin_id_fkey"
  FOREIGN KEY ("submitted_by_admin_id") REFERENCES "admin_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
