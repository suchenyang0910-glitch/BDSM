const MAX_KEYWORD_COUNT = 20;
const MAX_KEYWORD_LENGTH = 40;
const MAX_TG_TAG_COUNT = 10;
const MAX_TG_TAG_LENGTH = 32;
const TELEGRAM_CAPTION_LIMIT = 1024;

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

export function normalizeKeywordList(input: unknown, opts?: { maxCount?: number; maxLength?: number }): string[] {
  const maxCount = opts?.maxCount ?? MAX_KEYWORD_COUNT;
  const maxLength = opts?.maxLength ?? MAX_KEYWORD_LENGTH;
  const source = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[\n,，;；]+/)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of source) {
    const normalized = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!normalized) continue;
    const clipped = normalized.slice(0, maxLength);
    const key = clipped.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= maxCount) break;
  }
  return out;
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

export function normalizeTelegramHashtagsFromInputs(inputs: unknown[]): string[] {
  const flattened: string[] = [];
  for (const source of inputs) {
    if (Array.isArray(source)) {
      for (const item of source) flattened.push(String(item ?? ""));
      continue;
    }
    flattened.push(String(source ?? ""));
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of flattened) {
    const parts = raw.split(/[\s,，;；]+/);
    for (const part of parts) {
      const sanitized = String(part || "")
        .replace(/^#+/g, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[^\p{L}\p{N}_]+/gu, "")
        .trim();
      if (!sanitized) continue;
      const clipped = sanitized.slice(0, MAX_TG_TAG_LENGTH);
      if (!clipped) continue;
      const key = clipped.toLocaleLowerCase("en-US");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`#${clipped}`);
      if (out.length >= MAX_TG_TAG_COUNT) return out;
    }
  }
  return out;
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
