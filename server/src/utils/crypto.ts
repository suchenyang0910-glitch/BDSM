import crypto from "crypto";

// ============================================================
// 【Phase 0-2 已锁定】HMAC 密钥必须独立，不允许回退到任何 Bot 配置
// 缺失 CRYPTO_HMAC_SECRET 或 < 32 bytes → 立即抛错（启动期 assertRequiredSecrets 会调用）
// ============================================================
const HMAC_SECRET_NAME = "CRYPTO_HMAC_SECRET";

function getHmacSecret(): Buffer {
  const raw = process.env[HMAC_SECRET_NAME] || "";
  if (!raw || Buffer.byteLength(raw, "utf8") < 32) {
    throw new Error(
      `[crypto:hmac_secret] ${HMAC_SECRET_NAME} is missing or too short (< 32 bytes). ` +
        `Set a strong dedicated 32+ byte secret in server/.env; ` +
        `NEVER reuse Telegram Bot Token / invite keys here (Phase 0-2 红线：密钥用途分离).`,
    );
  }
  return Buffer.from(raw, "utf8");
}

// ============================================================
// 【Phase 0-1 已锁定】AES-GCM 频道 ID 独立密钥
// CRYPTO_CHAT_ID_AES_KEY 必须 32 bytes（AES-256）。不得与 HMAC 或 Bot Token 复用。
// ============================================================
const AES_CHAT_ID_KEY_NAME = "CRYPTO_CHAT_ID_AES_KEY";

function getAesChatIdKey(): Buffer {
  const raw = process.env[AES_CHAT_ID_KEY_NAME] || "";
  const bytes = Buffer.byteLength(raw, "utf8");
  if (!raw || bytes !== 32) {
    throw new Error(
      `[crypto:aes_chat_id_key] ${AES_CHAT_ID_KEY_NAME} must be exactly 32 bytes (AES-256); got ${bytes}. ` +
        `Set a dedicated 32-byte secret in server/.env; NEVER reuse HMAC / Bot tokens.`,
    );
  }
  return Buffer.from(raw, "utf8");
}

export function hmacSha256Hex(payload: string | Buffer, secret?: Buffer): string {
  const key = secret ?? getHmacSecret();
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

export function chatIdIndexKey(chatId: bigint | number | string): string {
  return hmacSha256Hex(`chat_id:${String(chatId)}`);
}

export function userIdIndexKey(telegramUserId: bigint | number | string): string {
  return hmacSha256Hex(`tg_user:${String(telegramUserId)}`);
}

export function inviteLinkFingerprint(inviteLink: string): string {
  const raw = inviteLink.trim();
  if (!raw) return "";
  return hmacSha256Hex(`invite:${raw}`);
}

/**
 * 用于日志/安全事件的短 HMAC 指纹（16 hex = 64bit），避免在 stdout/stderr/审计中直接输出 orderNo、userId、address 等明文业务标识。
 * 既满足“不可反推明文”，也满足“同一业务 ID 跨事件可关联排障”。
 */
export function shortFingerprint(kind: "order" | "user" | "address" | "product" | "admin" | string, plainValue: string | number | bigint | null | undefined): string {
  if (plainValue === null || plainValue === undefined || plainValue === "") return "";
  const raw = String(plainValue);
  const full = hmacSha256Hex(`fp:${kind}:${raw}`);
  return full.slice(0, 16);
}

export function constantTimeEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// ============================================================
// 【Phase 0-1】AES-256-GCM 频道 ID 加密 / 解密
// 封装格式（单一 base64 列，避免 schema 多字段琐碎）：
//   base64( nonce(12 bytes) || tag(16 bytes) || ciphertext(n bytes) )
// ============================================================
const AES_GCM_NONCE_LEN = 12;
const AES_GCM_TAG_LEN = 16;
const CHAT_ID_AAD = Buffer.from("bdsm:chat_id:v1", "utf8");

export function encryptChatIdAesGcm(chatIdPlain: bigint | number | string): string {
  const key = getAesChatIdKey();
  const plain = Buffer.from(String(chatIdPlain), "utf8");
  const nonce = crypto.randomBytes(AES_GCM_NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(CHAT_ID_AAD);
  const c1 = cipher.update(plain);
  const c2 = cipher.final();
  const tag = cipher.getAuthTag();
  if (tag.length !== AES_GCM_TAG_LEN) {
    throw new Error("[crypto:encryptChatId] AES-GCM produced unexpected tag length");
  }
  const out = Buffer.concat([nonce, tag, c1, c2]);
  return out.toString("base64");
}

export function decryptChatIdAesGcm(ciphertextB64: string): bigint {
  const key = getAesChatIdKey();
  if (!ciphertextB64) throw new Error("[crypto:decryptChatId] empty ciphertext");
  let raw: Buffer;
  try {
    raw = Buffer.from(ciphertextB64, "base64");
  } catch {
    throw new Error("[crypto:decryptChatId] invalid base64");
  }
  if (raw.length < AES_GCM_NONCE_LEN + AES_GCM_TAG_LEN + 1) {
    throw new Error("[crypto:decryptChatId] ciphertext too short (corrupted)");
  }
  const nonce = raw.subarray(0, AES_GCM_NONCE_LEN);
  const tag = raw.subarray(AES_GCM_NONCE_LEN, AES_GCM_NONCE_LEN + AES_GCM_TAG_LEN);
  const ctext = raw.subarray(AES_GCM_NONCE_LEN + AES_GCM_TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(CHAT_ID_AAD);
  decipher.setAuthTag(tag);
  const p1 = decipher.update(ctext);
  const p2 = decipher.final();
  const plainBuf = Buffer.concat([p1, p2]);
  const plainStr = plainBuf.toString("utf8");
  if (!/^-?\d+$/.test(plainStr)) {
    throw new Error("[crypto:decryptChatId] plaintext is not a valid integer chatId");
  }
  return BigInt(plainStr);
}

// ============================================================
// 【Phase 0-2】启动期必填密钥断言（由 server/src/index.ts 启动监听前调用）
// 失败直接 throw，不让进程进入 listen 状态
// ============================================================
type RequiredSecretResult = { ok: true } | { ok: false; missing: Array<{ name: string; reason: string }> };

export function assertRequiredSecretsOrThrow(): void {
  const res = collectRequiredSecretProblems();
  if (!res.ok) {
    const lines = res.missing.map((m) => `  - ${m.name}: ${m.reason}`).join("\n");
    throw new Error(`[crypto:assertRequiredSecrets] startup aborted.\n${lines}`);
  }
}

export function collectRequiredSecretProblems(): RequiredSecretResult {
  const missing: Array<{ name: string; reason: string }> = [];

  // (1) CRYPTO_HMAC_SECRET: >= 32 bytes, 独立
  {
    const v = process.env.CRYPTO_HMAC_SECRET || "";
    if (!v) missing.push({ name: "CRYPTO_HMAC_SECRET", reason: "missing (must be dedicated >=32 bytes; NEVER use Bot tokens)" });
    else if (Buffer.byteLength(v, "utf8") < 32) missing.push({ name: "CRYPTO_HMAC_SECRET", reason: `< 32 bytes (got ${Buffer.byteLength(v, "utf8")})` });
    else if (process.env.TELEGRAM_INVITE_BOT_KEY && v === process.env.TELEGRAM_INVITE_BOT_KEY) {
      missing.push({ name: "CRYPTO_HMAC_SECRET", reason: "must NOT equal TELEGRAM_INVITE_BOT_KEY (key purpose separation)" });
    }
  }

  // (2) CRYPTO_CHAT_ID_AES_KEY: 必须 32 bytes, 独立，与 HMAC / Bot Token 都不一样
  {
    const v = process.env.CRYPTO_CHAT_ID_AES_KEY || "";
    const bytes = Buffer.byteLength(v, "utf8");
    if (!v) missing.push({ name: "CRYPTO_CHAT_ID_AES_KEY", reason: "missing (exactly 32 bytes AES-256 key)" });
    else if (bytes !== 32) missing.push({ name: "CRYPTO_CHAT_ID_AES_KEY", reason: `must be exactly 32 bytes (got ${bytes})` });
    else if (v === process.env.CRYPTO_HMAC_SECRET) missing.push({ name: "CRYPTO_CHAT_ID_AES_KEY", reason: "must NOT equal CRYPTO_HMAC_SECRET (separate keys)" });
    else if (process.env.TELEGRAM_INVITE_BOT_KEY && v === process.env.TELEGRAM_INVITE_BOT_KEY) {
      missing.push({ name: "CRYPTO_CHAT_ID_AES_KEY", reason: "must NOT equal TELEGRAM_INVITE_BOT_KEY (separate keys)" });
    }
  }

  // (3) JWT_SECRET: >= 32 bytes
  {
    const v = process.env.JWT_SECRET || "";
    if (!v) missing.push({ name: "JWT_SECRET", reason: "missing" });
    else if (Buffer.byteLength(v, "utf8") < 32) missing.push({ name: "JWT_SECRET", reason: `< 32 bytes (got ${Buffer.byteLength(v, "utf8")})` });
  }

  // (4) DATABASE_URL: 非空
  if (!process.env.DATABASE_URL) missing.push({ name: "DATABASE_URL", reason: "missing" });

  // (5) TELEGRAM_INVITE_BOT_KEY: 非空且不是占位符（测试可能缺，这里只在 NODE_ENV=production 强制）
  if (process.env.NODE_ENV === "production") {
    const v = process.env.TELEGRAM_INVITE_BOT_KEY || "";
    if (!v || v.includes("REPLACE_") || v.includes("PLACEHOLDER") || v.includes("xxx")) {
      missing.push({ name: "TELEGRAM_INVITE_BOT_KEY", reason: "missing or placeholder on NODE_ENV=production" });
    }
  }

  // (6) getUpdates↔webhook 互斥红线：TELEGRAM_DEV_USE_GETUPDATES 在 NODE_ENV=production 绝对不允许
  if (process.env.NODE_ENV === "production" && process.env.TELEGRAM_DEV_USE_GETUPDATES === "true") {
    missing.push({
      name: "TELEGRAM_DEV_USE_GETUPDATES",
      reason: "must NOT be true in production (webhook-only mode; getUpdates and webhook are mutually exclusive — Phase 0-3/0-5 红线)",
    });
  }

  // (7) 收款地址完整性密钥：生产必须存在且与其他用途密钥物理分离。
  // 缺失时不允许“降级为跳过校验”，否则地址池篡改防护形同虚设。
  if (process.env.NODE_ENV === "production") {
    const v = process.env.PAYMENT_ADDRESS_INTEGRITY_KEY || "";
    if (!v) missing.push({ name: "PAYMENT_ADDRESS_INTEGRITY_KEY", reason: "missing (dedicated >=32 bytes; payment address integrity guard must fail closed)" });
    else if (Buffer.byteLength(v, "utf8") < 32) missing.push({ name: "PAYMENT_ADDRESS_INTEGRITY_KEY", reason: `< 32 bytes (got ${Buffer.byteLength(v, "utf8")})` });
    else if ([process.env.CRYPTO_HMAC_SECRET, process.env.CRYPTO_CHAT_ID_AES_KEY, process.env.JWT_SECRET, process.env.TELEGRAM_INVITE_BOT_KEY].includes(v)) {
      missing.push({ name: "PAYMENT_ADDRESS_INTEGRITY_KEY", reason: "must be dedicated and must NOT reuse HMAC/AES/JWT/Bot configuration" });
    }
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}
