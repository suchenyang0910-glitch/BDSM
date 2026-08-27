const MAX_KEYWORD_COUNT = 20;
const MAX_KEYWORD_LENGTH = 80;
const MAX_TG_TAG_COUNT = 10;
const MAX_TG_TAG_LENGTH = 32;
const TELEGRAM_CAPTION_LIMIT = 1024;

const KEYWORD_SPLIT_RE = /[,\n，;；]+/;
const INVISIBLE_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g;

export type ListNormalizationIssue = {
  index: number;
  input: string;
  code: "too_long" | "too_many";
  message: string;
};

export type ListNormalizationResult = {
  items: string[];
  errors: ListNormalizationIssue[];
};

export type EffectiveSeo = {
  title: string | null;
  description: string | null;
  keywords: string[];
  geoKeywords: string[];
  source: {
    title: "content" | "platform" | "none";
    description: "content" | "platform" | "none";
    keywords: "content" | "platform" | "none";
    geoKeywords: "content" | "platform" | "none";
  };
};

function stripInvisibleChars(input: unknown): string {
  return String(input ?? "").replace(INVISIBLE_CHAR_RE, "");
}

function normalizePhrase(input: unknown): string {
  return stripInvisibleChars(input).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizePhraseKey(input: string): string {
  return input.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

function flattenDelimitedEntries(input: unknown): Array<{ index: number; raw: string }> {
  const entries: Array<{ index: number; raw: string }> = [];
  let index = 0;
  const visit = (seed: unknown) => {
    if (Array.isArray(seed)) {
      for (const nested of seed) visit(nested);
      return;
    }
    const parts = typeof seed === "string" ? seed.split(KEYWORD_SPLIT_RE) : [String(seed ?? "")];
    for (const part of parts) {
      entries.push({ index, raw: String(part ?? "") });
      index += 1;
    }
  };
  visit(input);
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
        for (const piece of pieces) {
          entries.push({ index: entry.index, raw: piece });
        }
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

type NormalizeKeywordOptions = {
  maxCount?: number;
  maxLength?: number;
};

type NormalizeTelegramOptions = {
  maxCount?: number;
  maxLength?: number;
  prefixHash?: boolean;
};

export function validateKeywordList(input: unknown, opts?: NormalizeKeywordOptions): ListNormalizationResult {
  const maxCount = opts?.maxCount ?? MAX_KEYWORD_COUNT;
  const maxLength = opts?.maxLength ?? MAX_KEYWORD_LENGTH;
  const out: string[] = [];
  const errors: ListNormalizationIssue[] = [];
  const seen = new Set<string>();

  for (const entry of flattenDelimitedEntries(input)) {
    const normalized = normalizePhrase(entry.raw);
    if (!normalized) continue;
    if (normalized.length > maxLength) {
      errors.push({
        index: entry.index,
        input: normalized,
        code: "too_long",
        message: `单项最多 ${maxLength} 个字符`,
      });
      continue;
    }
    const key = normalizePhraseKey(normalized);
    if (seen.has(key)) continue;
    if (out.length >= maxCount) {
      errors.push({
        index: entry.index,
        input: normalized,
        code: "too_many",
        message: `最多允许 ${maxCount} 项`,
      });
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }

  return { items: out, errors };
}

export function normalizeKeywordList(input: unknown, opts?: NormalizeKeywordOptions): string[] {
  return validateKeywordList(input, opts).items;
}

export function keywordListIsEmpty(input: unknown): boolean {
  return normalizeKeywordList(input).length === 0;
}

export function buildEffectiveSeo(input: {
  contentSeoTitle?: string | null;
  contentSeoDescription?: string | null;
  contentSeoKeywords?: unknown;
  contentGeoKeywords?: unknown;
  fallbackTitle?: string | null;
  fallbackDescription?: string | null;
  platformSeoTitle?: string | null;
  platformSeoDescription?: string | null;
  platformSeoKeywords?: unknown;
  platformGeoKeywords?: unknown;
}): EffectiveSeo {
  const contentTitle = String(input.contentSeoTitle || "").trim();
  const contentDescription = String(input.contentSeoDescription || "").trim();
  const contentKeywords = normalizeKeywordList(input.contentSeoKeywords);
  const contentGeoKeywords = normalizeKeywordList(input.contentGeoKeywords);
  const platformTitle = String(input.platformSeoTitle || "").trim();
  const platformDescription = String(input.platformSeoDescription || "").trim();
  const platformKeywords = normalizeKeywordList(input.platformSeoKeywords);
  const platformGeoKeywords = normalizeKeywordList(input.platformGeoKeywords);
  const fallbackTitle = String(input.fallbackTitle || "").trim();
  const fallbackDescription = String(input.fallbackDescription || "").trim();

  const title = contentTitle || platformTitle || fallbackTitle || null;
  const description = contentDescription || platformDescription || fallbackDescription || null;
  const keywords = contentKeywords.length > 0 ? contentKeywords : platformKeywords;
  const geoKeywords = contentGeoKeywords.length > 0 ? contentGeoKeywords : platformGeoKeywords;

  return {
    title,
    description,
    keywords,
    geoKeywords,
    source: {
      title: contentTitle ? "content" : platformTitle ? "platform" : fallbackTitle ? "none" : "none",
      description: contentDescription ? "content" : platformDescription ? "platform" : fallbackDescription ? "none" : "none",
      keywords: contentKeywords.length > 0 ? "content" : platformKeywords.length > 0 ? "platform" : "none",
      geoKeywords: contentGeoKeywords.length > 0 ? "content" : platformGeoKeywords.length > 0 ? "platform" : "none",
    },
  };
}

export function validateTelegramTagList(input: unknown, opts?: NormalizeTelegramOptions): ListNormalizationResult {
  const maxCount = opts?.maxCount ?? MAX_TG_TAG_COUNT;
  const maxLength = opts?.maxLength ?? MAX_TG_TAG_LENGTH;
  const prefixHash = opts?.prefixHash !== false;
  const out: string[] = [];
  const errors: ListNormalizationIssue[] = [];
  const seen = new Set<string>();

  for (const entry of flattenTelegramEntries(input)) {
    const sanitized = sanitizeTelegramTag(entry.raw);
    if (!sanitized) continue;
    if (sanitized.length > maxLength) {
      errors.push({
        index: entry.index,
        input: normalizePhrase(entry.raw),
        code: "too_long",
        message: `单个标签最多 ${maxLength} 个字符`,
      });
      continue;
    }
    const key = sanitized.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    if (out.length >= maxCount) {
      errors.push({
        index: entry.index,
        input: normalizePhrase(entry.raw),
        code: "too_many",
        message: `最多允许 ${maxCount} 个标签`,
      });
      continue;
    }
    seen.add(key);
    out.push(prefixHash ? `#${sanitized}` : sanitized);
  }

  return { items: out, errors };
}

export function normalizeTelegramTagValuesFromInputs(inputs: unknown[]): string[] {
  return validateTelegramTagList(inputs, { prefixHash: false }).items;
}

export function normalizeTelegramHashtagsFromInputs(inputs: unknown[]): string[] {
  return validateTelegramTagList(inputs, { prefixHash: true }).items;
}

export function buildTelegramTagLine(inputs: unknown[]): string {
  return normalizeTelegramHashtagsFromInputs(inputs).join(" ");
}

export function appendTelegramTagLine(baseCaption: string, inputs: unknown[]): string {
  const tagLine = buildTelegramTagLine(inputs);
  const normalizedBase = String(baseCaption || "").trim();
  if (!tagLine) return normalizedBase;
  const baseWithoutTags = normalizedBase ? normalizedBase.replace(/\s+$/g, "") : "";
  const reservedBase = baseWithoutTags ? `${baseWithoutTags}\n${tagLine}` : tagLine;
  if (reservedBase.length <= TELEGRAM_CAPTION_LIMIT) return reservedBase;

  const allowedBaseLength = TELEGRAM_CAPTION_LIMIT - tagLine.length - 1;
  if (allowedBaseLength <= 0) return tagLine.slice(0, TELEGRAM_CAPTION_LIMIT);
  const clippedBase = baseWithoutTags.slice(0, allowedBaseLength).replace(/\s+$/g, "");
  return clippedBase ? `${clippedBase}\n${tagLine}` : tagLine;
}

export function buildVideoObjectJsonLd(input: {
  title: string;
  description?: string | null;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  uploadDate?: string | null;
  durationSeconds?: number | null;
  pageUrl: string;
}) {
  const durationSeconds = typeof input.durationSeconds === "number" && input.durationSeconds > 0 ? input.durationSeconds : null;
  const hours = durationSeconds ? Math.floor(durationSeconds / 3600) : 0;
  const minutes = durationSeconds ? Math.floor((durationSeconds % 3600) / 60) : 0;
  const seconds = durationSeconds ? durationSeconds % 60 : 0;
  const isoDuration = durationSeconds ? `PT${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${seconds ? `${seconds}S` : ""}` : undefined;
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: input.title,
    description: input.description || "",
    thumbnailUrl: input.thumbnailUrl ? [input.thumbnailUrl] : undefined,
    uploadDate: input.uploadDate || undefined,
    contentUrl: input.previewUrl || undefined,
    embedUrl: input.pageUrl,
    duration: isoDuration,
  };
}

export const SEO_LIMITS = Object.freeze({
  MAX_KEYWORD_COUNT,
  MAX_KEYWORD_LENGTH,
  MAX_TG_TAG_COUNT,
  MAX_TG_TAG_LENGTH,
  TELEGRAM_CAPTION_LIMIT,
});
