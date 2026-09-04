import type { FastifyInstance } from "fastify";
import { buildEffectiveSeo, type EffectiveSeo } from "../services/seoMetadata.js";
import { loadCommunityPostForSeo } from "./communityPosts.js";

type PublicContent = {
  id: string;
  title: string;
  description: string | null;
  summary?: string | null;
  coverUrl: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string[];
  geoKeywords?: string[];
  categories?: Array<{ category: { name: string } }>;
};

const FALLBACK_ORIGIN = "https://samewave.cc";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>\"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch] || ch);
}

function escapeXml(value: unknown): string {
  return escapeHtml(value);
}

/** Keep JSON-LD valid JSON while preventing an embedded script terminator. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function normalizeText(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeKeywords(values: unknown): string[] {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of source) {
    const item = normalizeText(raw, 40);
    if (!item) continue;
    const key = item.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= 20) break;
  }
  return result;
}

export function resolvePublicWebOrigin(raw: unknown): string {
  const candidate = String(raw || FALLBACK_ORIGIN).trim();
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") return FALLBACK_ORIGIN;
    return parsed.origin;
  } catch {
    return FALLBACK_ORIGIN;
  }
}

export function buildRobotsTxt(origin: string): string {
  return [
    "User-agent: *",
    "Allow: /discover",
    "Allow: /community",
    "Allow: /community/",
    "Allow: /content/",
    "Disallow: /api/",
    "Disallow: /admin/",
    "Disallow: /h5/",
    "Disallow: /mini-app/",
    "Disallow: /h5-pay.html",
    "Disallow: /login.html",
    "Disallow: /media/",
    "Disallow: /watch/",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

export function buildSitemapXml(
  origin: string,
  entries: Array<{ id: string; updatedAt: Date }>,
  communityEntries: Array<{ id: string; updatedAt: Date }> = [],
): string {
  const urls = entries.map((entry) => {
    const loc = `${origin}/content/${encodeURIComponent(entry.id)}`;
    const lastmod = entry.updatedAt.toISOString().slice(0, 10);
    return `  <url><loc>${escapeXml(loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`;
  });
  const communityUrls = communityEntries.map((entry) => {
    const loc = `${origin}/community/${encodeURIComponent(entry.id)}`;
    const lastmod = entry.updatedAt.toISOString().slice(0, 10);
    return `  <url><loc>${escapeXml(loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${escapeXml(`${origin}/discover`)}</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${escapeXml(`${origin}/community`)}</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
    ...urls,
    ...communityUrls,
    "</urlset>",
    "",
  ].join("\n");
}

function safeImageUrl(value: unknown): string | null {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function publicContentPage(origin: string, content: PublicContent, effectiveSeo: EffectiveSeo): string {
  const title = normalizeText(effectiveSeo.title || content.title, 120) || "Samewave";
  const description = normalizeText(effectiveSeo.description || content.description || content.summary || "", 300)
    || "Samewave 的公开内容介绍与点播入口。";
  const keywords = normalizeKeywords([...effectiveSeo.keywords, ...effectiveSeo.geoKeywords]);
  const canonical = `${origin}/content/${encodeURIComponent(content.id)}`;
  const openUrl = `/#view=content&id=${encodeURIComponent(content.id)}&from=search`;
  const image = safeImageUrl(content.coverUrl);
  const category = normalizeText(content.categories?.[0]?.category?.name, 60);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: canonical,
    inLanguage: "zh-CN",
    keywords: keywords.join(", ") || undefined,
    image: image || undefined,
    about: keywords.length ? keywords.map((name) => ({ "@type": "Thing", name })) : undefined,
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  ${keywords.length ? `<meta name="keywords" content="${escapeHtml(keywords.join(", "))}">` : ""}
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  ${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ""}
  <script type="application/ld+json">${jsonForScript(jsonLd)}</script>
  <style>body{margin:0;background:#111018;color:#f5f0ff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}.page{width:min(100% - 32px,760px);margin:0 auto;padding:72px 0}.eyebrow{color:#cdb3ff;font-size:12px;font-weight:700;letter-spacing:.12em}.cover{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:18px;background:#252134;margin:20px 0}.card{padding:24px;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:#1b1826}h1{font-size:clamp(28px,5vw,46px);line-height:1.15;margin:10px 0 14px}p{color:#beb4d2;line-height:1.7}a{display:inline-block;margin-top:16px;padding:13px 18px;border-radius:12px;background:#a95cff;color:white;text-decoration:none;font-weight:700}.meta{color:#9e94b3;font-size:14px}</style>
</head>
<body><main class="page"><p class="eyebrow">SAMEWAVE · PUBLIC DISCOVERY</p>${image ? `<img class="cover" src="${escapeHtml(image)}" alt="${escapeHtml(title)}">` : ""}<article class="card"><p class="meta">${escapeHtml(category || "公开内容")}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p><a href="${escapeHtml(openUrl)}">打开点播页面</a></article></main></body>
</html>`;
}

function communityOpenUrl(postId: string): string {
  return `/#view=community&id=${encodeURIComponent(postId)}&from=community`;
}

function makeCommunityImageSeoPath(postId: string, assetId: string): string {
  return `/api/community/posts/${encodeURIComponent(postId)}/assets/${encodeURIComponent(assetId)}/image`;
}

function normalizeCommunityTitle(body: unknown): string {
  return normalizeText(String(body || "").replace(/\s+/g, " "), 60) || "同频社区帖子";
}

function normalizeCommunityDescription(body: unknown): string {
  return normalizeText(String(body || "").replace(/\s+/g, " "), 160) || "同频社区图文帖子";
}

function communityListPage(origin: string, effectiveSeo: EffectiveSeo) {
  const title = normalizeText(effectiveSeo.title || "同频社区", 120) || "同频社区";
  const description = normalizeText(effectiveSeo.description || "Samewave 社区图文流。", 300) || "Samewave 社区图文流。";
  const keywords = normalizeKeywords([...effectiveSeo.keywords, ...effectiveSeo.geoKeywords]);
  const canonical = `${origin}/community`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description,
    url: canonical,
    inLanguage: "zh-CN",
    keywords: keywords.join(", ") || undefined,
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  ${keywords.length ? `<meta name="keywords" content="${escapeHtml(keywords.join(", "))}">` : ""}
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <script type="application/ld+json">${jsonForScript(jsonLd)}</script>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p><p><a href="/">进入 Samewave</a></p></main></body>
</html>`;
}

function communityDetailPage(origin: string, post: any, input: {
  title: string;
  description: string;
  keywords: string[];
  geoKeywords: string[];
  robots: string;
  image: string | null;
}) {
  const canonical = `${origin}/community/${encodeURIComponent(post.id)}`;
  const authorName = normalizeText(post.author?.displayName || "同频成员", 60) || "同频成员";
  const keywords = normalizeKeywords([...input.keywords, ...input.geoKeywords]);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SocialMediaPosting",
    headline: input.title,
    articleBody: input.description,
    datePublished: post.publishedAt ? new Date(post.publishedAt).toISOString() : undefined,
    dateModified: post.updatedAt ? new Date(post.updatedAt).toISOString() : undefined,
    author: { "@type": "Person", name: authorName },
    image: input.image || undefined,
    keywords: keywords.join(", ") || undefined,
    url: canonical,
    mainEntityOfPage: canonical,
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <meta name="description" content="${escapeHtml(input.description)}">
  ${keywords.length ? `<meta name="keywords" content="${escapeHtml(keywords.join(", "))}">` : ""}
  <meta name="robots" content="${escapeHtml(input.robots)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(input.title)}">
  <meta property="og:description" content="${escapeHtml(input.description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  ${input.image ? `<meta property="og:image" content="${escapeHtml(input.image)}">` : ""}
  <script type="application/ld+json">${jsonForScript(jsonLd)}</script>
</head>
<body><main><p>SAMEWAVE COMMUNITY</p><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.description)}</p><p><a href="${escapeHtml(communityOpenUrl(post.id))}">打开圈子详情</a></p></main></body>
</html>`;
}

export default async function publicSeoRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;
  const origin = resolvePublicWebOrigin(process.env.PUBLIC_WEB_ORIGIN);

  fastify.get("/robots.txt", async (_req, reply) => {
    return reply.type("text/plain; charset=utf-8").header("cache-control", "public, max-age=3600").send(buildRobotsTxt(origin));
  });

  fastify.get("/sitemap.xml", async (_req, reply) => {
    const [entries, communityEntries] = await Promise.all([
      prisma.content.findMany({
        where: { status: "published", accessType: "public" },
        select: { id: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 45000,
      }),
      prisma.communityPost.findMany({
        where: { status: "published", searchIndexable: true, deletedAt: null },
        select: { id: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 45000,
      }).catch(() => []),
    ]);
    return reply.type("application/xml; charset=utf-8").header("cache-control", "public, max-age=3600").send(buildSitemapXml(origin, entries, communityEntries));
  });

  fastify.get("/discover", async (_req, reply) => {
    const metadata = await prisma.platformMetadata.findUnique({ where: { id: "default" } }).catch(() => null);
    const title = normalizeText(metadata?.seoTitle || "Samewave", 120);
    const description = normalizeText(metadata?.seoDescription || "Samewave 的公开内容发现入口。", 300);
    const keywords = normalizeKeywords([...(metadata?.seoKeywords || []), ...(metadata?.geoKeywords || [])]);
    const jsonLd = { "@context": "https://schema.org", "@type": "WebSite", name: title, description, url: `${origin}/discover`, keywords: keywords.join(", ") || undefined };
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="index,follow"><link rel="canonical" href="${escapeHtml(`${origin}/discover`)}"><script type="application/ld+json">${jsonForScript(jsonLd)}</script></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p><p><a href="/">进入 Samewave</a></p></main></body></html>`;
    return reply.type("text/html; charset=utf-8").header("cache-control", "public, max-age=300").send(html);
  });

  fastify.get("/community", async (_req, reply) => {
    const metadata = await prisma.platformMetadata.findUnique({ where: { id: "default" } }).catch(() => null);
    const effectiveSeo = buildEffectiveSeo({
      platformSeoTitle: metadata?.seoTitle || "同频社区",
      platformSeoDescription: metadata?.seoDescription || "Samewave 社区图文流。",
      platformSeoKeywords: metadata?.seoKeywords,
      platformGeoKeywords: metadata?.geoKeywords,
      fallbackTitle: "同频社区",
      fallbackDescription: "Samewave 社区图文流。",
    });
    return reply.type("text/html; charset=utf-8").header("cache-control", "public, max-age=300").send(communityListPage(origin, effectiveSeo));
  });

  fastify.get<{ Params: { id: string } }>("/content/:id", async (req, reply) => {
    const [content, metadata] = await Promise.all([
      prisma.content.findFirst({
        where: { id: req.params.id, status: "published", accessType: "public" },
        include: { categories: { select: { category: { select: { name: true } } } } },
      }) as Promise<PublicContent | null>,
      prisma.platformMetadata.findUnique({ where: { id: "default" } }).catch(() => null),
    ]);
    if (!content) return reply.status(404).type("text/html; charset=utf-8").send("<!doctype html><title>Not found</title>");
    const effectiveSeo = buildEffectiveSeo({
      contentSeoTitle: content.seoTitle,
      contentSeoDescription: content.seoDescription,
      contentSeoKeywords: content.seoKeywords,
      contentGeoKeywords: content.geoKeywords,
      fallbackTitle: content.title,
      fallbackDescription: content.description || content.summary,
      platformSeoTitle: metadata?.seoTitle,
      platformSeoDescription: metadata?.seoDescription,
      platformSeoKeywords: metadata?.seoKeywords,
      platformGeoKeywords: metadata?.geoKeywords,
    });
    return reply.type("text/html; charset=utf-8").header("cache-control", "public, max-age=300").send(publicContentPage(origin, content, effectiveSeo));
  });

  fastify.get<{ Params: { id: string } }>("/community/:id", async (req, reply) => {
    const [post, metadata] = await Promise.all([
      loadCommunityPostForSeo(prisma, req.params.id),
      prisma.platformMetadata.findUnique({ where: { id: "default" } }).catch(() => null),
    ]);
    if (!post || post.status !== "published" || post.deletedAt) {
      return reply.status(404).type("text/html; charset=utf-8").send("<!doctype html><title>Not found</title>");
    }
    const title = normalizeText(post.seoTitle || normalizeCommunityTitle(post.body), 120) || "同频社区帖子";
    const description = normalizeText(post.seoDescription || normalizeCommunityDescription(post.body), 300) || "同频社区图文帖子";
    const effectiveSeo = buildEffectiveSeo({
      contentSeoTitle: post.seoTitle,
      contentSeoDescription: post.seoDescription,
      contentSeoKeywords: Array.isArray(post.seoKeywords) && post.seoKeywords.length ? post.seoKeywords : post.topics || [],
      contentGeoKeywords: post.geoKeywords,
      fallbackTitle: title,
      fallbackDescription: description,
      platformSeoTitle: metadata?.seoTitle,
      platformSeoDescription: metadata?.seoDescription,
      platformSeoKeywords: metadata?.seoKeywords,
      platformGeoKeywords: metadata?.geoKeywords,
    });
    const imageAsset = Array.isArray(post.assets)
      ? post.assets.find((asset: any) => asset.kind === "image" && asset.thumbnailObjectKey && asset.moderationStatus === "approved")
      : null;
    const image = imageAsset ? `${origin}${makeCommunityImageSeoPath(post.id, imageAsset.id)}` : null;
    return reply.type("text/html; charset=utf-8").header("cache-control", "public, max-age=300").send(communityDetailPage(origin, post, {
      title: effectiveSeo.title || title,
      description: effectiveSeo.description || description,
      keywords: effectiveSeo.keywords.length > 0 ? effectiveSeo.keywords : normalizeKeywords(post.topics || []),
      geoKeywords: effectiveSeo.geoKeywords,
      robots: post.searchIndexable ? "index,follow" : "noindex,follow",
      image,
    }));
  });
}
