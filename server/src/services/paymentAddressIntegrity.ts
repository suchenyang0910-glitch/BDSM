import { createHmac } from "node:crypto";
import { shortFingerprint } from "../utils/crypto.js";
import { emitSafetyEvent } from "../utils/structuredError.js";

type AddressLike = {
  id: string;
  network: string;
  address: string;
  createdAt: Date | string;
  createdBy?: string | null;
  lifecycleVersion?: number | null;
  integrityMac?: string | null;
  status?: string | null;
};

export function getPaymentAddressIntegrityKey(): string | null {
  const raw = String(process.env.PAYMENT_ADDRESS_INTEGRITY_KEY || "").trim();
  return raw && raw.length >= 32 ? raw : null;
}

export function normalizePaymentAddress(address: string, network: string): string {
  const trimmed = String(address || "").trim();
  if (String(network || "").trim().toLowerCase() === "tron_trc20") return trimmed;
  return trimmed;
}

function canonicalCreatedAt(input: Date | string): string {
  const date = input instanceof Date ? input : new Date(input);
  return date.toISOString();
}

export function buildPaymentAddressIntegrityPayload(row: AddressLike): string {
  return [
    row.id,
    String(row.network || "").trim().toLowerCase(),
    normalizePaymentAddress(row.address, row.network),
    canonicalCreatedAt(row.createdAt),
    String(row.createdBy || ""),
    String(row.lifecycleVersion ?? 1),
  ].join("|");
}

export function computePaymentAddressIntegrityMac(row: AddressLike): string | null {
  const key = getPaymentAddressIntegrityKey();
  if (!key) return null;
  return createHmac("sha256", key).update(buildPaymentAddressIntegrityPayload(row), "utf8").digest("hex");
}

export async function verifyAndFreezePaymentAddressIntegrity(
  prisma: any,
  row: AddressLike | null | undefined,
  context: "assign" | "monitor" | "confirm" | "retire" | "reveal",
): Promise<{ ok: boolean; reason?: string }> {
  if (!row) return { ok: false, reason: "missing_address_row" };
  const expected = computePaymentAddressIntegrityMac(row);
  if (!expected) {
    // 测试/本地开发允许不配置该专用密钥；生产启动期已强制校验，运行时仍 fail closed 防御错误配置。
    if (process.env.NODE_ENV !== "production") return { ok: true, reason: "integrity_key_missing_non_production" };
    return { ok: false, reason: "integrity_key_missing" };
  }
  const actual = String(row.integrityMac || "").trim().toLowerCase();
  if (actual && actual === expected) {
    try {
      await prisma.paymentAddress.update({
        where: { id: row.id },
        data: { lastIntegrityCheckAt: new Date() },
      });
    } catch {}
    return { ok: true };
  }

  const freezeReason = "payment_address_integrity_failed";
  try {
    await prisma.paymentAddress.update({
      where: { id: row.id },
      data: {
        autoCreditFrozenAt: new Date(),
        autoCreditFreezeReason: freezeReason,
        lastIntegrityCheckAt: new Date(),
      },
    });
  } catch {}
  try {
    emitSafetyEvent({
      event: "payment_address_integrity_failed",
      errorClass: "security",
      addressId: shortFingerprint("payment_address", row.id),
      retryHint: 0,
      note: `context=${context}; status=${row.status || "unknown"}`,
    });
  } catch {}
  return { ok: false, reason: freezeReason };
}
