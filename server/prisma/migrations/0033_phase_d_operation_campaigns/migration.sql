CREATE TABLE "operation_campaigns" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "code" VARCHAR(64) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
  "summary" VARCHAR(500),
  "starts_at" TIMESTAMPTZ,
  "ends_at" TIMESTAMPTZ,
  "banner_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "traffic_entry_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_by" VARCHAR(64),
  "updated_by" VARCHAR(64),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "operation_campaigns_code_key" ON "operation_campaigns" ("code");
CREATE INDEX "operation_campaigns_status_starts_at_ends_at_idx" ON "operation_campaigns" ("status", "starts_at", "ends_at");
