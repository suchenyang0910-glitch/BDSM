export const USDT_MINOR_SCALE = 1_000_000n;
export const XTR_LEGACY_DB_SCALE = 1_000_000n;

function toBigIntAmount(value: bigint | number | string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return BigInt(String(value || "0"));
}

// Compatibility rule:
// - New XTR rows should store integer Telegram Stars directly, e.g. 150 => 150 Stars.
// - Legacy rows may still use a shared 1e6 database scale, e.g. 150000000 => 150 Stars.
export function normalizeStoredXtrAmountToStars(value: bigint | number | string): bigint {
  const raw = toBigIntAmount(value);
  if (raw <= 0n) return raw;
  if (raw >= XTR_LEGACY_DB_SCALE && raw % XTR_LEGACY_DB_SCALE === 0n) {
    return raw / XTR_LEGACY_DB_SCALE;
  }
  return raw;
}

export function formatMinorAmountForDisplay(value: bigint | number | string | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined) return "0";
  const code = String(currency || "").toUpperCase();
  const raw = toBigIntAmount(value);
  if (code === "XTR") {
    return normalizeStoredXtrAmountToStars(raw).toString();
  }
  if (code === "USDT") {
    const whole = raw / USDT_MINOR_SCALE;
    const frac = (raw % USDT_MINOR_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
    return frac ? `${whole.toString()}.${frac}` : whole.toString();
  }
  return raw.toString();
}
