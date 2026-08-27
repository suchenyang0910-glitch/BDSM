export type DelimitedInputMode = "keyword" | "telegram";

export type DelimitedInputIssue = {
  index: number;
  input: string;
  code: "too_long" | "too_many";
  message: string;
};

export type DelimitedInputState = {
  items: string[];
  errors: DelimitedInputIssue[];
  maxCount: number;
  maxLength: number;
  mode: DelimitedInputMode;
};

const INVISIBLE_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g;
const KEYWORD_SPLIT_RE = /[,\n，;；]+/;

export const DELIMITED_INPUT_LIMITS = Object.freeze({
  keyword: { maxCount: 20, maxLength: 80 },
  telegram: { maxCount: 10, maxLength: 32 },
});

function stripInvisibleChars(input: unknown): string {
  return String(input ?? "").replace(INVISIBLE_CHAR_RE, "");
}

function normalizePhrase(input: unknown): string {
  return stripInvisibleChars(input).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function flattenDelimitedEntries(input: unknown): Array<{ index: number; raw: string }> {
  const seeds = Array.isArray(input) ? input : [input];
  const entries: Array<{ index: number; raw: string }> = [];
  let index = 0;
  for (const seed of seeds) {
    const parts = typeof seed === "string" ? seed.split(KEYWORD_SPLIT_RE) : [String(seed ?? "")];
    for (const part of parts) {
      entries.push({ index, raw: String(part ?? "") });
      index += 1;
    }
  }
  return entries;
}

function flattenTelegramEntries(input: unknown): Array<{ index: number; raw: string }> {
  const baseEntries = flattenDelimitedEntries(input);
  const entries: Array<{ index: number; raw: string }> = [];
  for (const entry of baseEntries) {
    const cleaned = stripInvisibleChars(entry.raw).trim();
    if (!cleaned) {
      entries.push(entry);
      continue;
    }
    if (cleaned.includes("#")) {
      const pieces = cleaned.split(/\s+/).filter(Boolean);
      if (pieces.length > 0) {
        pieces.forEach((piece) => entries.push({ index: entry.index, raw: piece }));
        continue;
      }
    }
    entries.push({ index: entry.index, raw: cleaned });
  }
  return entries;
}

function sanitizeTelegramTag(input: unknown): string {
  const normalized = stripInvisibleChars(input).normalize("NFKC").replace(/^#+/g, "").trim();
  if (!normalized) return "";
  return normalized
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}_]+/gu, "")
    .trim();
}

export function analyzeDelimitedInput(input: unknown, mode: DelimitedInputMode): DelimitedInputState {
  const { maxCount, maxLength } = DELIMITED_INPUT_LIMITS[mode];
  const items: string[] = [];
  const errors: DelimitedInputIssue[] = [];
  const seen = new Set<string>();
  const entries = mode === "keyword" ? flattenDelimitedEntries(input) : flattenTelegramEntries(input);

  for (const entry of entries) {
    const normalized = mode === "keyword" ? normalizePhrase(entry.raw) : sanitizeTelegramTag(entry.raw);
    if (!normalized) continue;
    if (normalized.length > maxLength) {
      errors.push({
        index: entry.index,
        input: normalizePhrase(entry.raw),
        code: "too_long",
        message: mode === "keyword" ? `单项最多 ${maxLength} 个字符` : `单个标签最多 ${maxLength} 个字符`,
      });
      continue;
    }
    const key = normalized.normalize("NFKC").toLocaleLowerCase(mode === "keyword" ? "zh-CN" : "en-US");
    if (seen.has(key)) continue;
    if (items.length >= maxCount) {
      errors.push({
        index: entry.index,
        input: normalizePhrase(entry.raw),
        code: "too_many",
        message: mode === "keyword" ? `最多允许 ${maxCount} 项` : `最多允许 ${maxCount} 个标签`,
      });
      continue;
    }
    seen.add(key);
    items.push(normalized);
  }

  return { items, errors, maxCount, maxLength, mode };
}

export function formatDelimitedItems(items: string[]): string {
  return (items || []).map((item) => normalizePhrase(item)).filter(Boolean).join(", ");
}

export function previewTelegramHashtags(items: string[]): string[] {
  return analyzeDelimitedInput(items, "telegram").items.map((item) => `#${item}`);
}
