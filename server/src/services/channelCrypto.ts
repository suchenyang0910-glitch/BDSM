// ============================================================
// channelCrypto：ContentPackage.channelId / Content.channelId 的受控加密接入层
//
// 红线约束（与 crypto.ts 同原语但不修改 crypto.ts 本体，P0 冻结保护）：
//   - 加密：AES-256-GCM，封装 nonce(12B) || tag(16B) || ciphertext → base64
//   - 索引：HMAC-SHA-256，key 前缀 "pkg_channel:..."  /  "content_channel:..."
//   - 与 adminManagedChannels 表同加密规范，方便未来同一密钥轮换
//   - 解密结果统一转为 bigint；加密接受 bigint | number | string，存库前一律加密
//   - 缺失密钥抛错，Fail-Closed
// ============================================================

import crypto from "crypto";
import {
  encryptChatIdAesGcm as baseEncrypt,
  decryptChatIdAesGcm as baseDecrypt,
  hmacSha256Hex,
} from "../utils/crypto.js";

const CONTENT_PACKAGE_CHANNEL_PREFIX = "pkg_channel_v1:";
const CONTENT_CHANNEL_PREFIX = "content_channel_v1:";

export function encryptContentPackageChannelId(chatIdPlain: bigint | number | string): string {
  return baseEncrypt(chatIdPlain);
}

export function decryptContentPackageChannelId(ciphertextB64: string): bigint | null {
  if (!ciphertextB64) return null;
  try {
    return baseDecrypt(ciphertextB64);
  } catch {
    return null;
  }
}

export function indexContentPackageChannelId(chatIdPlain: bigint | number | string): string {
  return hmacSha256Hex(`${CONTENT_PACKAGE_CHANNEL_PREFIX}${String(chatIdPlain)}`);
}

export function encryptContentChannelId(chatIdPlain: bigint | number | string): string {
  return baseEncrypt(chatIdPlain);
}

export function decryptContentChannelId(ciphertextB64: string): bigint | null {
  if (!ciphertextB64) return null;
  try {
    return baseDecrypt(ciphertextB64);
  } catch {
    return null;
  }
}

export function indexContentChannelId(chatIdPlain: bigint | number | string): string {
  return hmacSha256Hex(`${CONTENT_CHANNEL_PREFIX}${String(chatIdPlain)}`);
}

type ChannelPlainInput = bigint | number | string;
type ChannelStoredCols = {
  channelIdCiphertextB64: string | null;
  channelIdHmac: string | null;
  channelIdDeprecatedBigIntColumn: bigint | null; // 保留用于迁移期回读
};

export function encryptPackageColsFromPlain(
  plain: ChannelPlainInput | null | undefined,
): { channelIdCiphertextB64: string | null; channelIdHmac: string | null } {
  if (plain === null || plain === undefined || plain === "" || plain === "0" || plain === 0 || plain === 0n) {
    return { channelIdCiphertextB64: null, channelIdHmac: null };
  }
  return {
    channelIdCiphertextB64: encryptContentPackageChannelId(plain),
    channelIdHmac: indexContentPackageChannelId(plain),
  };
}

export function encryptContentColsFromPlain(
  plain: ChannelPlainInput | null | undefined,
): { channelIdCiphertextB64: string | null; channelIdHmac: string | null } {
  if (plain === null || plain === undefined || plain === "" || plain === "0" || plain === 0 || plain === 0n) {
    return { channelIdCiphertextB64: null, channelIdHmac: null };
  }
  return {
    channelIdCiphertextB64: encryptContentChannelId(plain),
    channelIdHmac: indexContentChannelId(plain),
  };
}

// 迁移期临时：从两列中尽量取解密值；优先 ciphertext，失败时回退 deprecated 明文（不泄露）
export function resolvePackageChannelId(
  row: Partial<{
    channelId: bigint | null;
    channelIdCiphertext: string | null;
  }>,
): bigint | null {
  if (row?.channelIdCiphertext) {
    const v = decryptContentPackageChannelId(row.channelIdCiphertext);
    if (v != null) return v;
  }
  if (typeof row?.channelId === "bigint" && row.channelId !== 0n) return row.channelId;
  return null;
}

export function resolveContentChannelId(
  row: Partial<{
    channelId: bigint | null;
    channelIdCiphertext: string | null;
  }>,
): bigint | null {
  if (row?.channelIdCiphertext) {
    const v = decryptContentChannelId(row.channelIdCiphertext);
    if (v != null) return v;
  }
  if (typeof row?.channelId === "bigint" && row.channelId !== 0n) return row.channelId;
  return null;
}

// 不使用 crypto 的直接导入时，防止 tree-shaker 丢加密原语（仅占位）
export const CRYPTO_CONSTANTS = Object.freeze({
  aesAlgorithm: "aes-256-gcm",
  nonceBytes: 12,
  tagBytes: 16,
});

// 纯内部断言 crypto 模块存在（不抛错）
export function _assertCryptoModule(): { ok: boolean; available?: boolean } {
  try {
    const fn = (crypto as unknown as { getCiphers?: () => string[] }).getCiphers;
    const _ = typeof fn === "function" ? (fn.call(crypto)?.length ?? 0) : 0;
    return { ok: true, available: !!_ };
  } catch {
    return { ok: false, available: false };
  }
}
