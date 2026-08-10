-- Sprint 3 V2: Telegram Stars + USDT-TRC20 双支付数据模型
-- Enums
CREATE TYPE "PaymentMethod" AS ENUM ('telegram_stars', 'usdt_trc20_external', 'manual');
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('detected', 'confirming', 'confirmed', 'rejected', 'refunded');
CREATE TYPE "PaymentAddressStatus" AS ENUM ('available', 'assigned', 'retired');

-- === orders 扩列 ===
-- 保持向后兼容：全部新列均有默认值或可空，以便带数据的 staging/生产可平滑迁移
ALTER TABLE "orders"
  ADD COLUMN "payment_method" "PaymentMethod" NOT NULL DEFAULT 'telegram_stars',
  ADD COLUMN "payment_payload_hmac" VARCHAR(64),
  ADD COLUMN "telegram_user_id_hmac" VARCHAR(64),
  ADD COLUMN "expires_at" TIMESTAMPTZ,
  ADD COLUMN "rejected_at" TIMESTAMPTZ,
  ADD COLUMN "reject_reason" VARCHAR(128),
  ADD COLUMN "refunded_at" TIMESTAMPTZ,
  ADD COLUMN "refund_reason" VARCHAR(1000),
  ADD COLUMN "refund_admin_id" VARCHAR(64),
  ADD COLUMN "usdt_payment_address_id" TEXT;

-- 独立唯一约束（不与已有 provider_order_id 冲突）
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_payload_hmac_key
  ON "orders" ("payment_payload_hmac") WHERE "payment_payload_hmac" IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_payment_method_status_created_at_idx
  ON "orders" ("payment_method", "status", "created_at");
CREATE INDEX IF NOT EXISTS orders_expires_at_status_idx
  ON "orders" ("expires_at", "status");
CREATE INDEX IF NOT EXISTS orders_usdt_payment_address_id_status_idx
  ON "orders" ("usdt_payment_address_id", "status");

-- === payment_addresses（USDT-TRC20 地址池，私钥绝不入库）===
CREATE TABLE "payment_addresses" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "network" VARCHAR(32) NOT NULL DEFAULT 'tron_trc20',
  "address" VARCHAR(64) NOT NULL,
  "address_masked" VARCHAR(16) NOT NULL,
  "status" "PaymentAddressStatus" NOT NULL DEFAULT 'available',
  "assigned_order_id" TEXT,
  "assigned_at" TIMESTAMPTZ,
  "release_at" TIMESTAMPTZ,
  "retired_at" TIMESTAMPTZ,
  "retire_reason" VARCHAR(128),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX payment_addresses_address_key ON "payment_addresses" ("address");
CREATE UNIQUE INDEX payment_addresses_assigned_order_id_key ON "payment_addresses" ("assigned_order_id")
  WHERE "assigned_order_id" IS NOT NULL;
CREATE INDEX payment_addresses_network_status_idx ON "payment_addresses" ("network", "status");
CREATE INDEX payment_addresses_status_release_at_idx ON "payment_addresses" ("status", "release_at");

ALTER TABLE "orders"
  ADD CONSTRAINT orders_usdt_payment_address_id_fkey
    FOREIGN KEY ("usdt_payment_address_id") REFERENCES "payment_addresses"("id")
    ON DELETE SET NULL;

-- === payment_transactions（Stars + USDT 统一交易表，一个订单多笔/退款）===
CREATE TABLE "payment_transactions" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "order_id" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "status" "PaymentTransactionStatus" NOT NULL DEFAULT 'detected',
  "provider_charge_id" VARCHAR(256),
  "network" VARCHAR(32),
  "token_contract" VARCHAR(64),
  "to_address" VARCHAR(64),
  "from_address" VARCHAR(64),
  "amount_minor" BIGINT NOT NULL,
  "currency" VARCHAR(16) NOT NULL DEFAULT 'XTR',
  "confirmations" INTEGER,
  "confirmations_target" INTEGER,
  "raw_event_hash" VARCHAR(64) NOT NULL,
  "telegram_payload_hmac" VARCHAR(64),
  "block_number" BIGINT,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "confirmed_at" TIMESTAMPTZ,
  "rejected_at" TIMESTAMPTZ,
  "reject_reason" VARCHAR(128),
  "refunded_at" TIMESTAMPTZ,
  "refund_reason" VARCHAR(1000),
  "refund_admin_id" VARCHAR(64),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX payment_transactions_provider_charge_id_key
  ON "payment_transactions" ("provider_charge_id") WHERE "provider_charge_id" IS NOT NULL;
CREATE UNIQUE INDEX payment_transactions_raw_event_hash_key
  ON "payment_transactions" ("raw_event_hash");

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT payment_transactions_order_id_fkey
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT;

CREATE INDEX payment_transactions_order_id_created_at_idx ON "payment_transactions" ("order_id", "created_at");
CREATE INDEX payment_transactions_status_created_at_idx ON "payment_transactions" ("status", "created_at");
CREATE INDEX payment_transactions_provider_status_created_at_idx ON "payment_transactions" ("provider", "status", "created_at");
CREATE INDEX payment_transactions_to_address_status_idx ON "payment_transactions" ("to_address", "status");
CREATE INDEX payment_transactions_block_number_idx ON "payment_transactions" ("block_number");
