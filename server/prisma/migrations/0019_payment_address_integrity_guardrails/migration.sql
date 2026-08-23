ALTER TYPE "PaymentAddressStatus" ADD VALUE IF NOT EXISTS 'pending_approval';

ALTER TABLE "payment_addresses"
  ADD COLUMN IF NOT EXISTS "created_by" TEXT,
  ADD COLUMN IF NOT EXISTS "approved_by" TEXT,
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "activation_ready_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "lifecycle_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "integrity_mac" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "auto_credit_frozen_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "auto_credit_freeze_reason" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "last_integrity_check_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "payment_addresses_status_activation_ready_at_idx"
  ON "payment_addresses"("status", "activation_ready_at");

CREATE INDEX IF NOT EXISTS "payment_addresses_auto_credit_frozen_at_idx"
  ON "payment_addresses"("auto_credit_frozen_at");
