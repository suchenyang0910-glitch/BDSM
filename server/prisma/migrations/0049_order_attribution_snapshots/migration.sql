-- Immutable, order-time attribution.  Existing orders intentionally receive
-- no rows: reports must show them as unknown instead of guessing a channel.
CREATE TABLE "order_attributions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "order_id" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "traffic_entry_id" TEXT,
  "traffic_entry_code" VARCHAR(64),
  "traffic_entry_type" VARCHAR(32),
  "destination_type" VARCHAR(32),
  "destination_id" VARCHAR(64),
  "campaign_id" TEXT,
  "campaign_code" VARCHAR(64),
  "client_type" VARCHAR(32) NOT NULL,
  "identity_type" VARCHAR(32) NOT NULL,
  "rule_version" VARCHAR(64) NOT NULL,
  "source_captured_at" TIMESTAMPTZ,
  "captured_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_attributions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_attributions_order_id_key" ON "order_attributions"("order_id");
CREATE INDEX "order_attributions_traffic_entry_code_captured_at_idx" ON "order_attributions"("traffic_entry_code", "captured_at");
CREATE INDEX "order_attributions_campaign_id_captured_at_idx" ON "order_attributions"("campaign_id", "captured_at");
ALTER TABLE "order_attributions"
  ADD CONSTRAINT "order_attributions_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
