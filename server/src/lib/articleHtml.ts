const ALLOWED_TAGS = new Set(["p", "h2", "h3", "h4", "strong", "em", "span", "ul", "ol", "li", "blockquote", "figure", "figcaption", "br", "hr", "a", "img", "table", "thead", "tbody", "tr", "th", "td"]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
const ARTICLE_TEXT_COLORS = new Set(["violet", "pink", "red", "orange", "green", "blue"]);

function restoreEscapedArticleColorMarkup(value: string): string {
  return value.replace(/&lt;span\s+data-article-color=(?:&quot;|")?(violet|pink|red|orange|green|blue)(?:&quot;|")?\s*&gt;([\s\S]*?)&lt;\/span&gt;/gi, (_match, color, children) => `<span data-article-color="${color}">${children}</span>`);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Article HTML is authored in the admin console. Keep its rendering surface
 * deliberately small: no style, script, event handler, iframe or data URL can
 * reach the public client. Text outside allowed tags remains readable.
 */
export function sanitizeArticleHtml(input: string): string {
  const source = restoreEscapedArticleColorMarkup(String(input || "")).trim();
  const tokenPattern = /<[^>]*>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let output = "";

  while ((match = tokenPattern.exec(source))) {
    output += escapeHtml(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const raw = match[0];
    const closing = /^<\s*\//.test(raw);
    const name = raw.replace(/^<\s*\/?\s*([a-z0-9]+)[\s\S]*$/i, "$1").toLowerCase();
    if (!ALLOWED_TAGS.has(name)) {
      output += escapeHtml(raw);
      continue;
    }
    if (closing) {
      if (!VOID_TAGS.has(name)) output += `</${name}>`;
      continue;
    }
    if (name === "a") {
      const href = raw.match(/\bhref\s*=\s*([\"'])(.*?)\1/i)?.[2] || "";
      const safe = safeHttpsUrl(href);
      if (safe) output += `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">`;
      continue;
    }
    if (name === "img") {
      const src = raw.match(/\bsrc\s*=\s*([\"'])(.*?)\1/i)?.[2] || "";
      const alt = raw.match(/\balt\s*=\s*([\"'])(.*?)\1/i)?.[2] || "文章配图";
      const safe = safeHttpsUrl(src);
      if (safe) output += `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" loading="lazy">`;
      continue;
    }
    if (name === "span") {
      const color = raw.match(/\bdata-article-color\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
      output += ARTICLE_TEXT_COLORS.has(color) ? `<span data-article-color="${color}">` : "<span>";
      continue;
    }
    output += `<${name}>`;
  }
  output += escapeHtml(source.slice(cursor));
  return output.trim();
}

export function htmlToPlainText(html: string): string {
  return sanitizeArticleHtml(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h2|h3|h4|li|blockquote|figure|figcaption)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function legacyMarkdownToHtml(markdown: string): string {
  return String(markdown || "").split(/\r?\n\s*\r?\n/).map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\r?\n/g, "<br>")}</p>`).join("");
}
