/**
 * prisma/seed-channels-encrypt.ts
 * -------------------------------------------------------------------
 * 【0009 迁移期手动回填脚本】
 *
 * 目标：
 *   - 把 ContentPackage / Content 表中旧的 BigInt 明文 `channel_id` 列
 *     回填到加密列 channel_id_ciphertext + channel_id_hmac
 *   - 同时验证「加密 → 解密」往返等于原值
 *   - 打印报告（总数、成功、跳过、失败），失败不做任何 UPDATE（Fail-Closed）
 *
 * 要求：
 *   - 只在服务端本机 `.env` 配好 CRYPTO_CHAT_ID_AES_KEY (32bytes hex) + CRYPTO_HMAC_SECRET (>=32bytes) 后执行
 *   - NODE_ENV=staging 或 production；默认 DATABASE_URL，支持 DATABASE_URL 覆盖
 *   - --dry-run 只报告，不写 DB（推荐首次跑 --dry-run）
 *   - 执行命令（从 server/ 根）：
 *       node --import tsx prisma/seed-channels-encrypt.ts --dry-run
 *       # 确认报告 OK 后：
 *       node --import tsx prisma/seed-channels-encrypt.ts
 * -------------------------------------------------------------------
 * 【注意】本脚本仅完成「明文 → 密文 + HMAC」的回填阶段；
 *   - 成功执行后仍处于「兼容迁移中」，明文 channel_id 列尚未删除；
 *   - 严禁在此时对外声称「已完成加密存储」；
 *   - 下一阶段需完成：验证密文读取无回归 → 执行独立 DROP COLUMN 迁移 → 再次验证。
 * -------------------------------------------------------------------
 * 【冻结约束】绝对禁止修改 utils/crypto.ts；本脚本只调用 channelCrypto 的加密/索引函数
 */

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encryptContentPackageChannelId,
  indexContentPackageChannelId,
  encryptContentChannelId,
  indexContentChannelId,
  decryptContentPackageChannelId,
  decryptContentChannelId,
} from "../src/services/channelCrypto.js";
import { emitSafetyEvent } from "../src/utils/structuredError.js";

const prisma = new PrismaClient();

function ensureEnvLoaded() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // 对本脚本而言，server/.env 应是明确来源，优先于外部污染的同名变量。
    process.env[key] = value;
  }
}

function ensureDatabaseUrlFromServerEnv() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL missing after loading server/.env");
  }
}

function bootstrapEnv() {
  try {
    ensureEnvLoaded();
    ensureDatabaseUrlFromServerEnv();
  } catch {
    // 脚本允许由外部显式注入环境变量；缺文件时保持 Fail-Closed 到后续校验。
  }
}

type ReportEntry = { id: string; kind: "package" | "content"; plain: bigint | null; encrypted: boolean };

async function rowCount(table: string): Promise<number> {
  const r = await (prisma as any).$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT COUNT(*)::bigint AS c FROM "${table}"`,
  );
  return Number(r[0].c || 0n);
}

async function main() {
  bootstrapEnv();
  const dryRun = process.argv.includes("--dry-run");
  console.log(`[seed-channels-encrypt] DATABASE_URL host=${new URL(process.env.DATABASE_URL || "unknown:///").host}`);
  console.log(`[seed-channels-encrypt] mode=${dryRun ? "DRY-RUN (只读)" : "WRITE (会 UPDATE)"}`);
  if (!process.env.CRYPTO_CHAT_ID_AES_KEY || !process.env.CRYPTO_HMAC_SECRET) {
    console.error("[seed-channels-encrypt] ABORT：CRYPTO_CHAT_ID_AES_KEY 或 CRYPTO_HMAC_SECRET 未配置（Fail-Closed，绝不回退明文）。");
    process.exit(1);
  }

  const totalPkg = await rowCount("content_packages");
  const totalContent = await rowCount("contents");
  console.log(`[seed-channels-encrypt] content_packages=${totalPkg}；contents=${totalContent}`);

  const reports: ReportEntry[] = [];
  let written = 0;
  let skipped = 0;
  let failed = 0;

  // ---- ContentPackage ----
  const allPkgs = await prisma.$queryRawUnsafe<Array<{ id: string; channel_id: bigint | null; channel_id_ciphertext: string | null }>>(
    `SELECT id, channel_id, channel_id_ciphertext FROM "content_packages"`,
  );
  for (const p of allPkgs) {
    if (!p.channel_id || p.channel_id === 0n) { skipped++; reports.push({ id: p.id, kind: "package", plain: null, encrypted: false }); continue; }
    if (p.channel_id_ciphertext) { skipped++; reports.push({ id: p.id, kind: "package", plain: p.channel_id, encrypted: true }); continue; }
    try {
      const ct = encryptContentPackageChannelId(p.channel_id);
      const hmac = indexContentPackageChannelId(p.channel_id);
      const back = decryptContentPackageChannelId(ct);
      if (back !== BigInt(p.channel_id)) throw new Error(`roundtrip mismatch: expect=${p.channel_id} got=${back}`);
      if (!dryRun) {
        await prisma.$executeRawUnsafe(
          `UPDATE "content_packages" SET channel_id_ciphertext = $1::text, channel_id_hmac = $2::varchar WHERE id = $3::uuid`,
          ct, hmac, p.id,
        );
      }
      written++; reports.push({ id: p.id, kind: "package", plain: p.channel_id, encrypted: true });
    } catch (e) {
      failed++;
      const rawLen = (e instanceof Error ? (e?.message || "").length : String(e).length);
      emitSafetyEvent({
        event: "seed_channel_encrypt_package_failed",
        errorClass: "crypto_error",
        note: `kind=package id=${p.id} msgLen=${rawLen}`,
      }, e as Error);
      console.error(`  [FAIL] package id=${p.id.slice(0, 8)}：加密或往返校验失败（详细错误已脱敏写入结构化事件）。`);
    }
  }

  // ---- Content ----
  const allContent = await prisma.$queryRawUnsafe<Array<{ id: string; channel_id: bigint | null; channel_id_ciphertext: string | null }>>(
    `SELECT id, channel_id, channel_id_ciphertext FROM "contents"`,
  );
  for (const c of allContent) {
    if (!c.channel_id || c.channel_id === 0n) { skipped++; reports.push({ id: c.id, kind: "content", plain: null, encrypted: false }); continue; }
    if (c.channel_id_ciphertext) { skipped++; reports.push({ id: c.id, kind: "content", plain: c.channel_id, encrypted: true }); continue; }
    try {
      const ct = encryptContentChannelId(c.channel_id);
      const hmac = indexContentChannelId(c.channel_id);
      const back = decryptContentChannelId(ct);
      if (back !== BigInt(c.channel_id)) throw new Error(`roundtrip mismatch: expect=${c.channel_id} got=${back}`);
      if (!dryRun) {
        await prisma.$executeRawUnsafe(
          `UPDATE "contents" SET channel_id_ciphertext = $1::text, channel_id_hmac = $2::varchar WHERE id = $3::uuid`,
          ct, hmac, c.id,
        );
      }
      written++; reports.push({ id: c.id, kind: "content", plain: c.channel_id, encrypted: true });
    } catch (e) {
      failed++;
      const rawLen = (e instanceof Error ? (e?.message || "").length : String(e).length);
      emitSafetyEvent({
        event: "seed_channel_encrypt_content_failed",
        errorClass: "crypto_error",
        note: `kind=content id=${c.id} msgLen=${rawLen}`,
      }, e as Error);
      console.error(`  [FAIL] content id=${c.id.slice(0, 8)}：加密或往返校验失败（详细错误已脱敏写入结构化事件）。`);
    }
  }

  console.log(`
[seed-channels-encrypt] DONE（兼容迁移中，明文列尚未删除）
  - 处理总数（package+content）  = ${reports.length}
  - 成功写入（或 dry-run 会写）= ${written}
  - 跳过（无明文或已有密文）   = ${skipped}
  - 失败（加密/往返错误）     = ${failed}

⚠️  重要声明：
  · 本阶段仅完成「明文 → 密文 + HMAC」回填；
  · 数据库仍保留明文 channel_id 列作为迁移期回退读取；
  · 不得声称「已完成加密存储」；
  · 下一步：验证密文读取全链路无回归 → 独立 DROP COLUMN 迁移 → 再次 dry-run。
  `);
  if (failed > 0) {
    console.error("[seed-channels-encrypt] 存在失败条目；请先查看 stderr [safety] 结构化事件定位原因，再重跑。");
    process.exit(2);
  }
  if (dryRun) {
    console.log("[seed-channels-encrypt] DRY-RUN 结束（只读，未写入 DB）。确认报告 OK 后再去掉 --dry-run。");
  }
}

main()
  .catch((e) => {
    const rawLen = (e instanceof Error ? (e?.message || "").length : String(e).length);
    try {
      emitSafetyEvent({
        event: "seed_channel_encrypt_fatal",
        errorClass: "db_error",
        note: `fatal phase len=${rawLen}`,
      }, e as Error);
    } catch (_emitErr) {
      // emitSafetyEvent 不可用时保证不扩大泄露范围
    }
    console.error(`[seed-channels-encrypt] FATAL：未捕获异常（len=${rawLen}），详细错误已脱敏写入结构化事件。`);
    process.exit(3);
  })
  .finally(() => prisma.$disconnect());
