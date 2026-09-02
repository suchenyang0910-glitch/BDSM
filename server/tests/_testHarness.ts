import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let savedOriginalFetch: typeof globalThis.fetch | null = null;
const FAKE_BOT_TOKEN = "1234567890:TESTBOTaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";

export function installMockedTelegramEnvironment(): void {
  process.env.NODE_ENV = "test";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-token-very-long-1234567890";
  process.env.TELEGRAM_INVITE_BOT_WEBHOOK_SECRET = "test-secret-token-very-long-1234567890";
  process.env.TELEGRAM_INVITE_BOT_KEY = "test";
  process.env.TELEGRAM_BOTS = JSON.stringify([
    { key: "test", username: "intune_test_bot", token: FAKE_BOT_TOKEN, active: true },
  ]);
  if (!process.env.TELEGRAM_CHANNEL_MEMBERSHIP) process.env.TELEGRAM_CHANNEL_MEMBERSHIP = "-1000000000001";
  if (!process.env.TELEGRAM_CHANNEL_PACKAGE_FEATURED) process.env.TELEGRAM_CHANNEL_PACKAGE_FEATURED = "-1000000000002";
  if (!process.env.PUBLIC_CHANNEL_URL) process.env.PUBLIC_CHANNEL_URL = "https://t.me/+test_public_channel";
  if (typeof globalThis.fetch !== "undefined" && savedOriginalFetch === null) {
    savedOriginalFetch = globalThis.fetch;
    globalThis.fetch = async function mockedFetch(input: any, init: any): Promise<any> {
      const urlStr = typeof input === "string" ? input : (input as Request)?.url || String(input);
      if (typeof urlStr === "string" && urlStr.includes("api.telegram.org")) {
        const m = urlStr.match(/\/bot[^/]+\/([A-Za-z0-9_]+)/);
        const method = m ? m[1] : "unknown";
        let result: any = { ok: true };
        let status = 200;
        if (method === "createChatInviteLink") {
          result = { ok: true, result: { invite_link: "https://t.me/+mocked_invite_link_" + Math.random().toString(36).slice(2, 10), creates_join_request: false, is_primary: false, is_revoked: false, name: "test invite", expire_date: 0, member_limit: 1 } };
        } else if (method === "banChatMember" || method === "unbanChatMember" || method === "kickChatMember") {
          result = { ok: true, result: true };
        } else if (method === "sendMessage") {
          result = { ok: true, result: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: "private" } } };
        } else if (method === "createInvoiceLink") {
          const nonce = Math.random().toString(36).slice(2, 16);
          result = { ok: true, result: `https://t.me/$test_invoice_link_${nonce}` };
        } else if (method === "sendInvoice") {
          result = { ok: true, result: { message_id: 5000 + Math.floor(Math.random() * 10000), date: Math.floor(Date.now() / 1000), chat: { id: 1, type: "private" } } };
        } else if (method === "answerPreCheckoutQuery") {
          result = { ok: true, result: true };
        } else if (method === "refundStarPayment") {
          result = { ok: true, result: true };
        } else {
          result = { ok: true, result: {} };
        }
        const body = JSON.stringify(result);
        return {
          ok: true,
          status,
          statusText: "OK",
          url: urlStr,
          headers: new Map([["content-type", "application/json"]]),
          json: async () => result,
          text: async () => body,
          arrayBuffer: async () => Buffer.from(body, "utf-8") as any,
          blob: async () => new Blob([body], { type: "application/json" }) as any,
          bodyUsed: false,
          type: "default",
          redirected: false,
          clone: () => { throw new Error("mock fetch clone not implemented"); },
        } as Response;
      }
      if (savedOriginalFetch) return (savedOriginalFetch as any)(input, init);
      throw new Error("mockedFetch: missing real fetch for non-Telegram URL: " + urlStr);
    };
  }
}

export function restoreOriginalFetch(): void {
  if (savedOriginalFetch !== null) {
    globalThis.fetch = savedOriginalFetch;
    savedOriginalFetch = null;
  }
}

const FORBIDDEN_DB_NAME_PATTERNS = [
  /^intune$/i,
  /^paperclip$/i,
  /production/i,
  /^prod/i,
  /staging/i,
  /live/i,
];

const REQUIRED_TEST_NAME_HINT = /test/i;

export interface TestDbGuardResult {
  prisma: PrismaClient;
  dbName: string;
  url: string;
}

export const TEST_CREDENTIALS = Object.freeze({
  superAdmin: { email: "test.superadmin@intune.local", password: "!T3st-SuperAdmin-Pass!X9z" },
  operator: { email: "test.operator@intune.local", password: "!T3st-Operator-Pass!X9z" },
  finance: { email: "test.finance@intune.local", password: "!T3st-Finance-Pass!X9z" },
  customerService: { email: "test.cs@intune.local", password: "!T3st-CS-Pass!X9z" },
  auditor: { email: "test.auditor@intune.local", password: "!T3st-Auditor-Pass!X9z" },
  editor: { email: "test.editor@intune.local", password: "!T3st-Editor-Pass!X9z" },
});

export const TEST_KNOWN_IDS = Object.freeze({
  contentPublic: "topic-00-pub",
  contentPackage: "topic-01",
  contentMembership: "topic-02",
  contentDraft: "topic-03-draft",
  categoryAll: "cat-test-all",
  categoryFeatured: "cat-test-featured",
  packageProductKey: "prod-test-pkg",
  membershipProductKey: "prod-test-mem",
  singleProductKey: "prod-test-single",
  contentPackageKey: "pkg-test-main",
  bannerHomeTop1: "banner-t1",
  bannerHomeTop2: "banner-t2",
});

export function requireTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[test-harness] FATAL: DATABASE_URL_TEST is not set. Tests MUST connect to an isolated test DB, never dev/prod. " +
        "Copy server/.env → server/.env.test and set DATABASE_URL_TEST=postgresql://intune:intune_dev_password@localhost:55432/intune_test?schema=public",
    );
  }
  return url;
}

export function extractDbName(url: string): string {
  try {
    const u = new URL(url.replace(/^postgres(ql)?:\/\//, "postgresql://"));
    return decodeURIComponent(u.pathname.replace(/^\//, "") || "");
  } catch {
    const m = url.match(/\/([^/?]+)(\?|$)/);
    return m ? m[1] : "";
  }
}

export function assertTestDatabaseName(dbName: string): void {
  if (!dbName) {
    throw new Error("[test-harness] FATAL: cannot extract database name from DATABASE_URL_TEST");
  }
  for (const pattern of FORBIDDEN_DB_NAME_PATTERNS) {
    if (pattern.test(dbName)) {
      throw new Error(
        `[test-harness] REFUSING TO CONNECT: test DB name "${dbName}" matches forbidden pattern "${pattern.toString()}". ` +
          "Tests MUST use an isolated test database (e.g. intune_test). Connecting to dev/prod DBs is blocked.",
      );
    }
  }
  if (!REQUIRED_TEST_NAME_HINT.test(dbName)) {
    throw new Error(
      `[test-harness] REFUSING TO CONNECT: test DB name "${dbName}" does not look like a test DB (must contain "test"). ` +
        "Please rename your test database (e.g. intune → intune_test) and update DATABASE_URL_TEST.",
    );
  }
}

const ALL_TABLES_ORDERED = [
  "telegram_channel_messages",
  "interaction_reports",
  "interaction_likes",
  "interaction_comments",
  "community_post_assets",
  "community_posts",
  "playback_revoke_outbox",
  "playback_grants",
  "playback_sessions",
  "watch_progresses",
  "watch_events",
  "transcode_jobs_v2",
  "video_assets",
  "upload_session_parts",
  "upload_sessions",
  "usdt_monitor_cursors",
  "usdt_monitor_runtime_states",
  "analytics_events",
  "analytics_daily_aggregates",
  "user_content_preferences",
  "admin_managed_channels",
  "admin_audit_logs",
  "content_categories",
  "telegram_invites",
  "entitlements",
  "payment_transactions",
  "payment_addresses",
  "orders",
  "contents",
  "content_packages",
  "products",
  "banners",
  "categories",
  "users",
  "admin_users",
  "platform_metadata",
  "telegram_update_logs",
];

export async function ensureMigrationsApplied(prisma: PrismaClient, migrateFolder: string): Promise<{ applied: string[] }> {
  void prisma;
  const testDbName = extractDbName(requireTestDatabaseUrl());
  const prismaDirectory = path.dirname(migrateFolder);
  const schemaPath = path.join(prismaDirectory, "schema.prisma");
  const projectRoot = path.dirname(prismaDirectory);
  const prismaCli = path.join(projectRoot, "node_modules", "prisma", "build", "index.js");
  try {
    const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schemaPath], {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: requireTestDatabaseUrl() },
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0 || result.error) {
      const initialDiagnostic = `${String(result.stdout || "")}\n${String(result.stderr || "")}`
        .split(/\r?\n/)
        .filter((line) => !/(postgres(?:ql)?:\/\/|password|database_url)/i.test(line))
        .slice(-8)
        .join(" | ");
      // A failed migration can only be repaired automatically in the already
      // validated isolated test database. Production never executes this harness.
      const reset = spawnSync(process.execPath, [prismaCli, "migrate", "reset", "--force", "--skip-seed", "--schema", schemaPath], {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: requireTestDatabaseUrl() },
        encoding: "utf8",
        stdio: "pipe",
      });
      if (reset.status !== 0 || reset.error) {
        const resetDiagnostic = `${String(reset.stdout || "")}\n${String(reset.stderr || "")}`
          .split(/\r?\n/)
          .filter((line) => !/(postgres(?:ql)?:\/\/|password|database_url)/i.test(line))
          .slice(-8)
          .join(" | ");
        throw new Error(`prisma_cli_exit_${String(result.status ?? "unknown")}:${initialDiagnostic}; reset_exit_${String(reset.status ?? "unknown")}:${resetDiagnostic}`);
      }
    }
    return { applied: [] };
  } catch (err: any) {
    // 测试库只能由正式 Prisma migration 建表；绝不允许下方任何临时 DDL 兜底掩盖漏迁移。
    const safeMessage = String(err?.message || err?.code || "unknown")
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://***")
      .slice(0, 900);
    throw new Error(`[test-harness] FATAL: prisma migrate deploy failed for isolated test DB name=${testDbName} (${safeMessage})`);
  }
}

export async function ensureManagedChannelsTable(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.adminManagedChannel.count();
  } catch {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "admin_managed_channels" (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        deprecated_chat_id_big BIGINT,
        chat_id_ciphertext_b64 TEXT NOT NULL,
        chat_id_hmac VARCHAR(64) NOT NULL,
        chat_type TEXT NOT NULL,
        title TEXT,
        username TEXT,
        member_count INTEGER,
        avatar_file_id TEXT,
        is_private BOOLEAN NOT NULL DEFAULT true,
        last_event_at TIMESTAMPTZ,
        refreshed_at TIMESTAMPTZ,
        source TEXT NOT NULL DEFAULT 'auto_scan',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS admin_managed_channels_chat_id_hmac_key ON "admin_managed_channels"(chat_id_hmac);`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_amc_source ON "admin_managed_channels"(source);`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_amc_chat_type ON "admin_managed_channels"(chat_type);`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_amc_refreshed_at ON "admin_managed_channels"(refreshed_at);`,
      );
    } catch { /* ignore */ }
  }
}

export async function ensureTelegramChannelMessagesTable(prisma: PrismaClient): Promise<void> {
  try {
    await (prisma as any).telegramChannelMessage.count();
  } catch {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "telegram_channel_messages" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "managed_channel_id" TEXT NOT NULL,
        "message_id" BIGINT NOT NULL,
        "media_kind" VARCHAR(32) NOT NULL,
        "telegram_file_id_cipher" TEXT,
        "preview_file_id_cipher" TEXT,
        "caption_fingerprint" VARCHAR(64),
        "posted_at" TIMESTAMPTZ NOT NULL,
        "association_status" VARCHAR(32) NOT NULL DEFAULT 'unlinked',
        "content_id" TEXT UNIQUE,
        "linked_at" TIMESTAMPTZ,
        "linked_by" TEXT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS telegram_channel_messages_managed_channel_id_message_id_key ON "telegram_channel_messages"("managed_channel_id", "message_id");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS telegram_channel_messages_managed_channel_id_association_status_posted_at_idx ON "telegram_channel_messages"("managed_channel_id", "association_status", "posted_at" DESC);`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS telegram_channel_messages_association_status_posted_at_idx ON "telegram_channel_messages"("association_status", "posted_at" DESC);`,
      );
    } catch { /* ignore */ }
  }
}

export async function ensureAnalyticsPreferenceTables(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnalyticsPlatform') THEN
          CREATE TYPE "AnalyticsPlatform" AS ENUM ('h5', 'telegram_mini_app', 'server', 'unknown');
        END IF;
      END $$;`,
    );
  } catch { /* ignore */ }
  try {
    await prisma.$executeRawUnsafe(
      `DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PreferenceType') THEN
          CREATE TYPE "PreferenceType" AS ENUM ('content_topic', 'content_format', 'discovery_mode', 'notification');
        END IF;
      END $$;`,
    );
  } catch { /* ignore */ }
  try {
    await prisma.$executeRawUnsafe(
      `DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PreferenceSource') THEN
          CREATE TYPE "PreferenceSource" AS ENUM ('guest_onboarding', 'my_preferences', 'first_browse_prompt', 'migration_confirmed');
        END IF;
      END $$;`,
    );
  } catch { /* ignore */ }

  try {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "analytics_events" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "occurred_at" TIMESTAMPTZ NOT NULL,
        "event_name" VARCHAR(64) NOT NULL,
        "user_id" TEXT,
        "anonymous_id_hmac" VARCHAR(64) NOT NULL,
        "user_id_hmac" VARCHAR(64),
        "session_id_hmac" VARCHAR(64) NOT NULL,
        "platform" "AnalyticsPlatform" NOT NULL DEFAULT 'unknown',
        "properties_json" JSONB,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "analytics_daily_aggregates" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "stat_date" DATE NOT NULL,
        "event_name" VARCHAR(64) NOT NULL,
        "platform" "AnalyticsPlatform" NOT NULL DEFAULT 'unknown',
        "group_key" VARCHAR(64),
        "group_value" VARCHAR(128),
        "sample_count" INTEGER NOT NULL DEFAULT 0,
        "unique_sessions" INTEGER NOT NULL DEFAULT 0,
        "unique_anonymous" INTEGER NOT NULL DEFAULT 0,
        "unique_users" INTEGER NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "user_content_preferences" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "user_id" TEXT NOT NULL,
        "category_id" TEXT,
        "preference_type" "PreferenceType" NOT NULL,
        "value_key" VARCHAR(64) NOT NULL,
        "is_enabled" BOOLEAN NOT NULL DEFAULT true,
        "source" "PreferenceSource" NOT NULL DEFAULT 'my_preferences',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
    );
  } catch { /* ignore */ }
}

export async function ensureUsdtMonitorTables(prisma: PrismaClient): Promise<void> {
  try {
    await (prisma as any).usdtMonitorRuntimeState.count();
  } catch {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "usdt_monitor_runtime_states" (
        "worker_name" VARCHAR(64) NOT NULL PRIMARY KEY,
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
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,
    );
  }
  try {
    await (prisma as any).usdtMonitorCursor.count();
  } catch {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "usdt_monitor_cursors" (
        "address_id" TEXT NOT NULL PRIMARY KEY,
        "last_block_timestamp" TIMESTAMPTZ,
        "last_tx_hash_fingerprint" VARCHAR(64),
        "last_success_at" TIMESTAMPTZ,
        "last_error_class" VARCHAR(64),
        "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "usdt_monitor_cursors_address_id_fkey"
          FOREIGN KEY ("address_id") REFERENCES "payment_addresses"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );`,
    );
  }
}

export async function ensureUsdtPaymentTables(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'paymentmethod') THEN
          CREATE TYPE "PaymentMethod" AS ENUM ('telegram_stars', 'usdt_trc20_external', 'manual');
        END IF;
      END $$;`,
    );
  } catch { /* ignore */ }

  try {
    await prisma.paymentAddress.count();
  } catch {
    try {
      await prisma.$executeRawUnsafe(
        `DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'paymentaddressstatus') THEN
            CREATE TYPE "PaymentAddressStatus" AS ENUM ('available', 'assigned', 'retired');
          END IF;
        END $$;`,
      );
    } catch { /* ignore */ }
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "payment_addresses" (
        "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "network" VARCHAR(32) NOT NULL DEFAULT 'tron_trc20',
        "address" VARCHAR(64) NOT NULL,
        "address_masked" VARCHAR(16) NOT NULL,
        "status" "PaymentAddressStatus" NOT NULL DEFAULT 'pending_approval',
        "assigned_order_id" TEXT,
        "assigned_at" TIMESTAMPTZ,
        "release_at" TIMESTAMPTZ,
        "retired_at" TIMESTAMPTZ,
        "retire_reason" VARCHAR(128),
        "created_by" TEXT,
        "approved_by" TEXT,
        "approved_at" TIMESTAMPTZ,
        "activation_ready_at" TIMESTAMPTZ,
        "lifecycle_version" INTEGER NOT NULL DEFAULT 1,
        "integrity_mac" VARCHAR(64),
        "auto_credit_frozen_at" TIMESTAMPTZ,
        "auto_credit_freeze_reason" VARCHAR(128),
        "last_integrity_check_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS payment_addresses_address_key ON "payment_addresses" ("address");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS payment_addresses_assigned_order_id_key ON "payment_addresses" ("assigned_order_id")
         WHERE "assigned_order_id" IS NOT NULL;`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS payment_addresses_network_status_idx ON "payment_addresses" ("network", "status");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS payment_addresses_status_release_at_idx ON "payment_addresses" ("status", "release_at");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS payment_addresses_status_activation_ready_at_idx ON "payment_addresses" ("status", "activation_ready_at");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS payment_addresses_auto_credit_frozen_at_idx ON "payment_addresses" ("auto_credit_frozen_at");`,
      );
    } catch { /* ignore */ }
  }
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TYPE "PaymentAddressStatus" ADD VALUE IF NOT EXISTS 'pending_approval';`,
    );
  } catch { /* ignore */ }
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "payment_addresses"
         ADD COLUMN IF NOT EXISTS "created_by" TEXT,
         ADD COLUMN IF NOT EXISTS "approved_by" TEXT,
         ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS "activation_ready_at" TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS "lifecycle_version" INTEGER NOT NULL DEFAULT 1,
         ADD COLUMN IF NOT EXISTS "integrity_mac" VARCHAR(64),
         ADD COLUMN IF NOT EXISTS "auto_credit_frozen_at" TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS "auto_credit_freeze_reason" VARCHAR(128),
         ADD COLUMN IF NOT EXISTS "last_integrity_check_at" TIMESTAMPTZ;`,
    );
  } catch { /* ignore */ }

  try {
    await prisma.paymentTransaction.count();
  } catch {
    try {
      await prisma.$executeRawUnsafe(
        `DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'paymenttransactionstatus') THEN
            CREATE TYPE "PaymentTransactionStatus" AS ENUM ('detected', 'confirming', 'confirmed', 'rejected', 'refunded');
          END IF;
        END $$;`,
      );
    } catch { /* ignore */ }
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "payment_transactions" (
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
      );`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_provider_charge_id_key
         ON "payment_transactions" ("provider_charge_id") WHERE "provider_charge_id" IS NOT NULL;`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_raw_event_hash_key
         ON "payment_transactions" ("raw_event_hash");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS payment_transactions_order_id_created_at_idx
         ON "payment_transactions" ("order_id", "created_at");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS payment_transactions_status_created_at_idx
         ON "payment_transactions" ("status", "created_at");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS payment_transactions_provider_status_created_at_idx
         ON "payment_transactions" ("provider", "status", "created_at");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS payment_transactions_to_address_status_idx
         ON "payment_transactions" ("to_address", "status");`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS payment_transactions_block_number_idx
         ON "payment_transactions" ("block_number");`,
      );
    } catch { /* ignore */ }
  }
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "payment_transactions"
         ADD COLUMN IF NOT EXISTS "network" VARCHAR(32),
         ADD COLUMN IF NOT EXISTS "token_contract" VARCHAR(64),
         ADD COLUMN IF NOT EXISTS "to_address" VARCHAR(64),
         ADD COLUMN IF NOT EXISTS "from_address" VARCHAR(64),
         ADD COLUMN IF NOT EXISTS "confirmations" INTEGER,
         ADD COLUMN IF NOT EXISTS "confirmations_target" INTEGER,
         ADD COLUMN IF NOT EXISTS "raw_event_hash" VARCHAR(64),
         ADD COLUMN IF NOT EXISTS "telegram_payload_hmac" VARCHAR(64),
         ADD COLUMN IF NOT EXISTS "block_number" BIGINT,
         ADD COLUMN IF NOT EXISTS "received_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS "rejected_at" TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS "reject_reason" VARCHAR(128),
         ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS "refund_reason" VARCHAR(1000),
         ADD COLUMN IF NOT EXISTS "refund_admin_id" VARCHAR(64);`,
    );
  } catch { /* ignore */ }

  try {
    await prisma.$executeRawUnsafe(
      `DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'orders'
        ) THEN
          ALTER TABLE "orders"
            ADD COLUMN IF NOT EXISTS "payment_method" "PaymentMethod" NOT NULL DEFAULT 'telegram_stars',
            ADD COLUMN IF NOT EXISTS "payment_payload_hmac" VARCHAR(64),
            ADD COLUMN IF NOT EXISTS "telegram_user_id_hmac" VARCHAR(64),
            ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS "rejected_at" TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS "reject_reason" VARCHAR(128),
            ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS "refund_reason" VARCHAR(1000),
            ADD COLUMN IF NOT EXISTS "refund_admin_id" VARCHAR(64),
            ADD COLUMN IF NOT EXISTS "usdt_payment_address_id" TEXT;
        END IF;
      END $$;`,
    );
  } catch { /* ignore */ }
  try {
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_payload_hmac_key
       ON "orders" ("payment_payload_hmac") WHERE "payment_payload_hmac" IS NOT NULL;`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS orders_payment_method_status_created_at_idx
       ON "orders" ("payment_method", "status", "created_at");`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS orders_expires_at_status_idx
       ON "orders" ("expires_at", "status");`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS orders_usdt_payment_address_id_status_idx
       ON "orders" ("usdt_payment_address_id", "status");`,
    );
  } catch { /* ignore */ }
}

export async function ensurePlatformMetadataTable(prisma: PrismaClient): Promise<void> {
  try {
    await (prisma as any).platformMetadata.findUnique({ where: { id: "default" } });
  } catch {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "platform_metadata" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "seo_title" VARCHAR(120),
        "seo_description" VARCHAR(300),
        "seo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        "geo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_by" TEXT
      );`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "platform_metadata" ("id") VALUES ('default')
       ON CONFLICT ("id") DO NOTHING;`,
    );
  }
}

export async function ensureWatchProgressTable(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "watch_progresses" (
        "user_id" TEXT NOT NULL,
        "content_id" TEXT NOT NULL,
        "position_sec" INTEGER NOT NULL DEFAULT 0,
        "duration_sec" INTEGER,
        "last_played_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "watch_progresses_pkey" PRIMARY KEY ("user_id", "content_id"),
        CONSTRAINT "watch_progresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "watch_progresses_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "watch_progresses_last_played_at_idx" ON "watch_progresses"("last_played_at");`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "watch_progresses_content_id_last_played_at_idx" ON "watch_progresses"("content_id", "last_played_at");`);
  } catch {
    /* ignore */
  }
}

export async function ensureSeoMetadataColumns(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "contents"
         ADD COLUMN IF NOT EXISTS "seo_title" VARCHAR(120),
         ADD COLUMN IF NOT EXISTS "seo_description" VARCHAR(300),
         ADD COLUMN IF NOT EXISTS "seo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
         ADD COLUMN IF NOT EXISTS "geo_keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];`,
    );
  } catch {
    /* ignore */
  }
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "telegram_publish_jobs"
         ADD COLUMN IF NOT EXISTS "telegram_tags_json" JSONB;`,
    );
  } catch {
    /* ignore */
  }
}

export async function wipeTestDatabase(prisma: PrismaClient): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrateFolder = path.join(__dirname, "..", "prisma", "migrations");
  await ensureMigrationsApplied(prisma, migrateFolder);
  await ensureWatchProgressTable(prisma);
  for (const table of ALL_TABLES_ORDERED) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE;`);
    } catch {
      /* ignore missing tables from partially migrated local test DBs */
    }
  }
}

export async function setupTestHarness(): Promise<TestDbGuardResult> {
  installMockedTelegramEnvironment();
  const url = requireTestDatabaseUrl();
  const dbName = extractDbName(url);
  assertTestDatabaseName(dbName);
  process.env.DATABASE_URL = url;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();
  await wipeTestDatabase(prisma);
  return { prisma, dbName, url };
}

export async function teardownTestHarness(prisma: PrismaClient): Promise<void> {
  try {
    await wipeTestDatabase(prisma);
  } finally {
    try { await prisma.$disconnect(); } catch {}
    restoreOriginalFetch();
  }
}

async function hash(pw: string): Promise<string> {
  return bcrypt.hash(pw, 6);
}

export async function seedTestData(prisma: PrismaClient): Promise<{ seededAt: Date }> {
  const now = new Date();
  const oneMonthLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [superPw, opPw, finPw, csPw, audPw, edPw] = await Promise.all([
    hash(TEST_CREDENTIALS.superAdmin.password),
    hash(TEST_CREDENTIALS.operator.password),
    hash(TEST_CREDENTIALS.finance.password),
    hash(TEST_CREDENTIALS.customerService.password),
    hash(TEST_CREDENTIALS.auditor.password),
    hash(TEST_CREDENTIALS.editor.password),
  ]);

  const [catAll, catFeatured] = await Promise.all([
    prisma.category.upsert({
      where: { id: TEST_KNOWN_IDS.categoryAll },
      update: { name: "全部", slug: "all", sortOrder: 0, status: "active" },
      create: { id: TEST_KNOWN_IDS.categoryAll, name: "全部", slug: "all", sortOrder: 0, status: "active" },
    }),
    prisma.category.upsert({
      where: { id: TEST_KNOWN_IDS.categoryFeatured },
      update: { name: "精选", slug: "featured", sortOrder: 1, status: "active" },
      create: { id: TEST_KNOWN_IDS.categoryFeatured, name: "精选", slug: "featured", sortOrder: 1, status: "active" },
    }),
  ]);

  const [prodSingle, prodPackage, prodMembership] = await Promise.all([
    prisma.product.upsert({
      where: { id: TEST_KNOWN_IDS.singleProductKey },
      update: {
        type: "single",
        title: "单个：公开内容购买",
        priceMinor: BigInt(150_000_000),
        currency: "XTR",
        status: "active",
      },
      create: {
        id: TEST_KNOWN_IDS.singleProductKey,
        type: "single",
        title: "单个：公开内容购买",
        priceMinor: BigInt(150_000_000),
        currency: "XTR",
        status: "active",
      },
    }),
    prisma.product.upsert({
      where: { id: TEST_KNOWN_IDS.packageProductKey },
      update: {
        type: "package",
        title: "入门精选 · 6 集打包",
        priceMinor: BigInt(1200_000_000),
        currency: "XTR",
        status: "active",
      },
      create: {
        id: TEST_KNOWN_IDS.packageProductKey,
        type: "package",
        title: "入门精选 · 6 集打包",
        priceMinor: BigInt(1200_000_000),
        currency: "XTR",
        status: "active",
      },
    }),
    prisma.product.upsert({
      where: { id: TEST_KNOWN_IDS.membershipProductKey },
      update: {
        type: "membership",
        title: "同频会员 · 30 天",
        priceMinor: BigInt(2980_000_000),
        currency: "XTR",
        durationDays: 30,
        status: "active",
      },
      create: {
        id: TEST_KNOWN_IDS.membershipProductKey,
        type: "membership",
        title: "同频会员 · 30 天",
        priceMinor: BigInt(2980_000_000),
        currency: "XTR",
        durationDays: 30,
        status: "active",
      },
    }),
  ]);

  const contentPackage = await prisma.contentPackage.upsert({
    where: { id: TEST_KNOWN_IDS.contentPackageKey },
    update: {
      title: "入门精选合集",
      status: "published",
      productId: prodPackage.id,
    },
    create: {
      id: TEST_KNOWN_IDS.contentPackageKey,
      title: "入门精选合集",
      status: "published",
      productId: prodPackage.id,
    },
  });

  await (prisma as any).platformMetadata.upsert({
    where: { id: "default" },
    update: {
      seoTitle: "同频平台默认 SEO 标题",
      seoDescription: "同频平台默认 SEO 描述",
      seoKeywords: ["默认词", "会员", "内容目录"],
      geoKeywords: ["生成式搜索", "主题词"],
    },
    create: {
      id: "default",
      seoTitle: "同频平台默认 SEO 标题",
      seoDescription: "同频平台默认 SEO 描述",
      seoKeywords: ["默认词", "会员", "内容目录"],
      geoKeywords: ["生成式搜索", "主题词"],
    },
  });

  const [topicPub, topic1, topic2, topicDraft] = await Promise.all([
    prisma.content.upsert({
      where: { id: TEST_KNOWN_IDS.contentPublic },
      update: {
        title: "免费：什么是正念？5 分钟入门",
        accessType: "public",
        status: "published",
        platformPlaybackEnabled: true,
        durationSeconds: 300,
        seoKeywords: ["免费视频", "冥想入门"],
        geoKeywords: ["正念主题"],
        isRecommended: true,
        isNewArrival: true,
        featuredSort: 1,
        tags: ["入门", "免费"],
        thumbnailUrl: null,
        sortOrder: 1,
      },
      create: {
        id: TEST_KNOWN_IDS.contentPublic,
        title: "免费：什么是正念？5 分钟入门",
        accessType: "public",
        status: "published",
        platformPlaybackEnabled: true,
        durationSeconds: 300,
        seoKeywords: ["免费视频", "冥想入门"],
        geoKeywords: ["正念主题"],
        isRecommended: true,
        isNewArrival: true,
        featuredSort: 1,
        tags: ["入门", "免费"],
        thumbnailUrl: null,
        sortOrder: 1,
      },
    }),
    prisma.content.upsert({
      where: { id: TEST_KNOWN_IDS.contentPackage },
      update: {
        title: "呼吸与身体扫描入门",
        accessType: "package",
        status: "published",
        platformPlaybackEnabled: true,
        durationSeconds: 600,
        seoTitle: "打包内容 SEO 标题",
        packageId: contentPackage.id,
        isFeatured: true,
        featuredSort: 2,
        tags: ["冥想", "呼吸"],
        sortOrder: 2,
      },
      create: {
        id: TEST_KNOWN_IDS.contentPackage,
        title: "呼吸与身体扫描入门",
        accessType: "package",
        status: "published",
        platformPlaybackEnabled: true,
        durationSeconds: 600,
        seoTitle: "打包内容 SEO 标题",
        packageId: contentPackage.id,
        isFeatured: true,
        featuredSort: 2,
        tags: ["冥想", "呼吸"],
        sortOrder: 2,
      },
    }),
    prisma.content.upsert({
      where: { id: TEST_KNOWN_IDS.contentMembership },
      update: {
        title: "深度睡眠引导",
        accessType: "membership",
        status: "published",
        platformPlaybackEnabled: true,
        durationSeconds: 1200,
        seoDescription: "会员内容 SEO 描述",
        isRecommended: true,
        featuredSort: 3,
        tags: ["睡眠"],
        sortOrder: 3,
      },
      create: {
        id: TEST_KNOWN_IDS.contentMembership,
        title: "深度睡眠引导",
        accessType: "membership",
        status: "published",
        platformPlaybackEnabled: true,
        durationSeconds: 1200,
        seoDescription: "会员内容 SEO 描述",
        isRecommended: true,
        featuredSort: 3,
        tags: ["睡眠"],
        sortOrder: 3,
      },
    }),
    prisma.content.upsert({
      where: { id: TEST_KNOWN_IDS.contentDraft },
      update: {
        title: "（草稿）职场焦虑缓解",
        accessType: "single",
        status: "draft",
        productId: prodSingle.id,
        durationSeconds: 900,
        sortOrder: 0,
      },
      create: {
        id: TEST_KNOWN_IDS.contentDraft,
        title: "（草稿）职场焦虑缓解",
        accessType: "single",
        status: "draft",
        productId: prodSingle.id,
        durationSeconds: 900,
        sortOrder: 0,
      },
    }),
  ]);

  await Promise.all([
    prisma.contentCategory.createMany({
      data: [
        { contentId: topicPub.id, categoryId: catAll.id },
        { contentId: topicPub.id, categoryId: catFeatured.id },
        { contentId: topic1.id, categoryId: catAll.id },
        { contentId: topic1.id, categoryId: catFeatured.id },
        { contentId: topic2.id, categoryId: catAll.id },
        { contentId: topicDraft.id, categoryId: catAll.id },
      ],
      skipDuplicates: true,
    }),
    prisma.banner.createMany({
      data: [
        {
          id: TEST_KNOWN_IDS.bannerHomeTop1,
          title: "同频会员 8 折试看",
          slot: "home_top",
          imageUrl: "https://example.com/banner-1.jpg",
          actionLabel: "立即加入",
          targetType: "content",
          targetId: topicPub.id,
          sortOrder: 1,
          startsAt: now,
          endsAt: oneMonthLater,
          status: "active",
        },
        {
          id: TEST_KNOWN_IDS.bannerHomeTop2,
          title: "新手 7 天引导",
          slot: "home_top",
          imageUrl: "https://example.com/banner-2.jpg",
          actionLabel: "开启",
          targetType: "category",
          targetId: catFeatured.id,
          sortOrder: 2,
          status: "active",
        },
      ],
      skipDuplicates: true,
    }),
  ]);

  await Promise.all([
    prisma.adminUser.upsert({
      where: { email: TEST_CREDENTIALS.superAdmin.email },
      update: {
        passwordHash: superPw,
        displayName: "测试 · 超级管理员",
        role: "super_admin",
        status: "active",
      },
      create: {
        email: TEST_CREDENTIALS.superAdmin.email,
        passwordHash: superPw,
        displayName: "测试 · 超级管理员",
        role: "super_admin",
        status: "active",
      },
    }),
    prisma.adminUser.upsert({
      where: { email: TEST_CREDENTIALS.operator.email },
      update: {
        passwordHash: opPw,
        displayName: "测试 · 运营",
        role: "operator",
        status: "active",
      },
      create: {
        email: TEST_CREDENTIALS.operator.email,
        passwordHash: opPw,
        displayName: "测试 · 运营",
        role: "operator",
        status: "active",
      },
    }),
    prisma.adminUser.upsert({
      where: { email: TEST_CREDENTIALS.finance.email },
      update: {
        passwordHash: finPw,
        displayName: "测试 · 财务",
        role: "finance",
        status: "active",
      },
      create: {
        email: TEST_CREDENTIALS.finance.email,
        passwordHash: finPw,
        displayName: "测试 · 财务",
        role: "finance",
        status: "active",
      },
    }),
    prisma.adminUser.upsert({
      where: { email: TEST_CREDENTIALS.customerService.email },
      update: {
        passwordHash: csPw,
        displayName: "测试 · 客服",
        role: "customer_service",
        status: "active",
      },
      create: {
        email: TEST_CREDENTIALS.customerService.email,
        passwordHash: csPw,
        displayName: "测试 · 客服",
        role: "customer_service",
        status: "active",
      },
    }),
    prisma.adminUser.upsert({
      where: { email: TEST_CREDENTIALS.auditor.email },
      update: {
        passwordHash: audPw,
        displayName: "测试 · 审计",
        role: "auditor",
        status: "active",
      },
      create: {
        email: TEST_CREDENTIALS.auditor.email,
        passwordHash: audPw,
        displayName: "测试 · 审计",
        role: "auditor",
        status: "active",
      },
    }),
    prisma.adminUser.upsert({
      where: { email: TEST_CREDENTIALS.editor.email },
      update: {
        passwordHash: edPw,
        displayName: "测试 · 内容编辑（可发布）",
        role: "editor",
        status: "active",
      },
      create: {
        email: TEST_CREDENTIALS.editor.email,
        passwordHash: edPw,
        displayName: "测试 · 内容编辑（可发布）",
        role: "editor",
        status: "active",
      },
    }),
  ]);

  return { seededAt: now };
}
