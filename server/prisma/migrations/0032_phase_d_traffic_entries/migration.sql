CREATE TABLE "traffic_entries" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "code" VARCHAR(64) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "entry_type" VARCHAR(32) NOT NULL,
  "destination_type" VARCHAR(32) NOT NULL,
  "destination_id" VARCHAR(64) NOT NULL,
  "note" VARCHAR(500),
  "created_by" VARCHAR(64),
  "updated_by" VARCHAR(64),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "traffic_entries_code_key" ON "traffic_entries" ("code");
CREATE INDEX "traffic_entries_status_entry_type_idx" ON "traffic_entries" ("status", "entry_type");
CREATE INDEX "traffic_entries_destination_type_destination_id_idx" ON "traffic_entries" ("destination_type", "destination_id");
