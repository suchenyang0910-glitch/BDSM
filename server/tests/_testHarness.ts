import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  "telegram_update_logs",
];

export async function ensureMigrationsApplied(prisma: PrismaClient, migrateFolder: string): Promise<{ applied: string[] }> {
  const { PrismaMigrator } = (await import("@prisma/migrate")) as any;
  let migrator: any | null = null;
  try {
    const migratorCls = (PrismaMigrator as any) || ((await import("@prisma/migrate/dist/PrismaMigrator.js")) as any)?.PrismaMigrator;
    migrator = new migratorCls({ migrationsPath: migrateFolder, schemaPath: path.join(migrateFolder, "..", "schema.prisma") });
    const diagnose = await migrator.diagnoseMigrationHistory({ optInToShadowDatabase: true });
    if (diagnose.history?.diagnostic === "databaseIsBehind") {
      const applied = await migrator.applyMigrations();
      return { applied: applied.flat().map(String) };
    }
    return { applied: [] };
  } catch {
    return { applied: [] };
  } finally {
    try { if (migrator?.stop) await migrator.stop(); } catch { /* ignore */ }
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
  try { await ensureMigrationsApplied(prisma, migrateFolder); } catch { /* ignore */ }
  await ensureManagedChannelsTable(prisma);
  await ensureUsdtMonitorTables(prisma);
  await ensurePlatformMetadataTable(prisma);
  await ensureSeoMetadataColumns(prisma);
  for (const table of ALL_TABLES_ORDERED) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE;`);
    } catch (e: any) {
      const code = typeof e?.meta?.code === "string" ? e.meta.code : String(e?.code || "");
      if (code === "42P01" || /relation .* does not exist/i.test(String(e?.message || ""))) {
        continue;
      }
      throw e;
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
    prisma.category.create({ data: { id: TEST_KNOWN_IDS.categoryAll, name: "全部", slug: "all", sortOrder: 0, status: "active" } }),
    prisma.category.create({ data: { id: TEST_KNOWN_IDS.categoryFeatured, name: "精选", slug: "featured", sortOrder: 1, status: "active" } }),
  ]);

  const [prodSingle, prodPackage, prodMembership] = await Promise.all([
    prisma.product.create({
      data: {
        id: TEST_KNOWN_IDS.singleProductKey,
        type: "single",
        title: "单个：公开内容购买",
        priceMinor: BigInt(150_000_000),
        currency: "XTR",
        status: "active",
      },
    }),
    prisma.product.create({
      data: {
        id: TEST_KNOWN_IDS.packageProductKey,
        type: "package",
        title: "入门精选 · 6 集打包",
        priceMinor: BigInt(1200_000_000),
        currency: "XTR",
        status: "active",
      },
    }),
    prisma.product.create({
      data: {
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

  const contentPackage = await prisma.contentPackage.create({
    data: {
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
    prisma.content.create({
      data: {
        id: TEST_KNOWN_IDS.contentPublic,
        title: "免费：什么是正念？5 分钟入门",
        accessType: "public",
        status: "published",
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
    prisma.content.create({
      data: {
        id: TEST_KNOWN_IDS.contentPackage,
        title: "呼吸与身体扫描入门",
        accessType: "package",
        status: "published",
        durationSeconds: 600,
        seoTitle: "打包内容 SEO 标题",
        packageId: contentPackage.id,
        isFeatured: true,
        featuredSort: 2,
        tags: ["冥想", "呼吸"],
        sortOrder: 2,
      },
    }),
    prisma.content.create({
      data: {
        id: TEST_KNOWN_IDS.contentMembership,
        title: "深度睡眠引导",
        accessType: "membership",
        status: "published",
        durationSeconds: 1200,
        seoDescription: "会员内容 SEO 描述",
        isRecommended: true,
        featuredSort: 3,
        tags: ["睡眠"],
        sortOrder: 3,
      },
    }),
    prisma.content.create({
      data: {
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
    }),
  ]);

  await Promise.all([
    prisma.adminUser.create({
      data: {
        email: TEST_CREDENTIALS.superAdmin.email,
        passwordHash: superPw,
        displayName: "测试 · 超级管理员",
        role: "super_admin",
        status: "active",
      },
    }),
    prisma.adminUser.create({
      data: {
        email: TEST_CREDENTIALS.operator.email,
        passwordHash: opPw,
        displayName: "测试 · 运营",
        role: "operator",
        status: "active",
      },
    }),
    prisma.adminUser.create({
      data: {
        email: TEST_CREDENTIALS.finance.email,
        passwordHash: finPw,
        displayName: "测试 · 财务",
        role: "finance",
        status: "active",
      },
    }),
    prisma.adminUser.create({
      data: {
        email: TEST_CREDENTIALS.customerService.email,
        passwordHash: csPw,
        displayName: "测试 · 客服",
        role: "customer_service",
        status: "active",
      },
    }),
    prisma.adminUser.create({
      data: {
        email: TEST_CREDENTIALS.auditor.email,
        passwordHash: audPw,
        displayName: "测试 · 审计",
        role: "auditor",
        status: "active",
      },
    }),
    prisma.adminUser.create({
      data: {
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
