CREATE TABLE "usdt_monitor_cursors" (
  "address_id" TEXT NOT NULL,
  "last_block_timestamp" TIMESTAMPTZ,
  "last_tx_hash_fingerprint" VARCHAR(64),
  "last_success_at" TIMESTAMPTZ,
  "last_error_class" VARCHAR(64),
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usdt_monitor_cursors_pkey" PRIMARY KEY ("address_id")
);

CREATE TABLE "usdt_monitor_runtime_states" (
  "worker_name" VARCHAR(64) NOT NULL,
  "last_cycle_at" TIMESTAMPTZ,
  "last_success_at" TIMESTAMPTZ,
  "last_block_number" BIGINT,
  "last_scanned_address_count" INTEGER NOT NULL DEFAULT 0,
  "last_discovered_tx_count" INTEGER NOT NULL DEFAULT 0,
  "last_confirmed_count" INTEGER NOT NULL DEFAULT 0,
  "last_rejected_count" INTEGER NOT NULL DEFAULT 0,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "last_error_class" VARCHAR(64),
  "last_provider_status" VARCHAR(32),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usdt_monitor_runtime_states_pkey" PRIMARY KEY ("worker_name")
);

CREATE INDEX "idx_usdt_monitor_cursors_last_success_at"
  ON "usdt_monitor_cursors"("last_success_at");

CREATE INDEX "idx_usdt_monitor_cursors_failures_updated_at"
  ON "usdt_monitor_cursors"("consecutive_failures", "updated_at");

ALTER TABLE "usdt_monitor_cursors"
  ADD CONSTRAINT "usdt_monitor_cursors_address_id_fkey"
  FOREIGN KEY ("address_id") REFERENCES "payment_addresses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
