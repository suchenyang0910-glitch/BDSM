import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin, type AdminSession } from "./admin.js";
import { htmlToPlainText, sanitizeArticleHtml } from "../lib/articleHtml.js";

const StatusZ = z.enum(["draft", "published", "archived"]);
// Ant Design submits an untouched optional Input as an empty string. Normalize
// it before validation so optional attribution fields are truly optional.
const emptyStringToNull = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? null : value,
  schema,
);
const ArticleInputZ = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160),
  title: z.string().trim().min(2).max(160),
  summary: z.string().trim().min(10).max(500),
  bodyHtml: z.string().trim().min(20).max(50_000),
  coverImageUrl: z.string().trim().url().max(500).nullable().optional(),
  sourceName: emptyStringToNull(z.string().trim().max(120).nullable().optional()),
  sourceUrl: emptyStringToNull(z.string().trim().url().max(500).nullable().optional()),
  topics: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  seoTitle: z.string().trim().max(160).nullable().optional(),
  seoDescription: z.string().trim().max(300).nullable().optional(),
  seoKeywords: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  geoKeywords: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  status: StatusZ.optional(),
  reason: z.string().trim().max(500).optional(),
});
const ArticleBodyAutoSaveZ = z.object({
  bodyHtml: z.string().trim().min(20).max(50_000),
});

function meta(req: FastifyRequest) {
  const session = (req as any).admin as AdminSession;
  return { adminId: session.adminId, ip: (req.ip as string) || null, ua: (req.headers["user-agent"] as string) || null };
}

function publicShape(row: any) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    bodyHtml: row.bodyHtml || "",
    coverImageUrl: row.coverImageUrl,
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    topics: row.topics || [],
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    seoKeywords: row.seoKeywords || [],
    geoKeywords: row.geoKeywords || [],
    status: row.status,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function audit(prisma: any, req: FastifyRequest, action: string, articleId: string, before: any, after: any, reason?: string) {
  const actor = meta(req);
  await prisma.adminAuditLog.create({
    data: {
      adminId: actor.adminId,
      action,
      objectType: "article",
      objectId: articleId,
      beforeValue: before,
      afterValue: after,
      reason: reason || null,
      ipAddress: actor.ip,
      userAgent: actor.ua,
    },
  });
}

export default async function adminArticleRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.get("/admin/articles", { preHandler: [requireAdmin("content:view")] }, async () => {
    const rows = await prisma.article.findMany({ orderBy: [{ updatedAt: "desc" }] });
    return { items: rows.map(publicShape) };
  });

  fastify.post("/admin/articles", { preHandler: [requireAdmin("content:edit")] }, async (req, reply) => {
    const parsed = ArticleInputZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_article_input", details: parsed.error.issues });
    const { reason, bodyHtml, coverImageUrl, ...input } = parsed.data;
    const safeHtml = sanitizeArticleHtml(bodyHtml);
    if (htmlToPlainText(safeHtml).length < 20) return reply.code(400).send({ error: "invalid_article_html", message: "正文 HTML 不包含足够的可读内容。" });
    const actor = meta(req);
    const created = await prisma.article.create({
      data: {
        ...input,
        bodyHtml: safeHtml,
        bodyMarkdown: htmlToPlainText(safeHtml),
        coverImageUrl: coverImageUrl || null,
        sourceName: input.sourceName || null,
        sourceUrl: input.sourceUrl || null,
        seoTitle: input.seoTitle || null,
        seoDescription: input.seoDescription || null,
        createdBy: actor.adminId,
        updatedBy: actor.adminId,
        status: input.status || "draft",
        publishedAt: input.status === "published" ? new Date() : null,
      },
    });
    await audit(prisma, req, "article.create", created.id, null, publicShape(created), reason);
    return reply.code(201).send({ ok: true, article: publicShape(created) });
  });

  // Keep autosave intentionally narrow: it must never change publication state,
  // SEO, attribution, or the stable slug while an editor is still typing.
  fastify.patch<{ Params: { id: string } }>("/admin/articles/:id/body", { preHandler: [requireAdmin("content:edit")] }, async (req, reply) => {
    const parsed = ArticleBodyAutoSaveZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_article_html", message: "正文至少需要 20 个可读字符。" });
    const before = await prisma.article.findUnique({ where: { id: req.params.id } });
    if (!before) return reply.code(404).send({ error: "article_not_found", message: "文章不存在。" });
    const safeHtml = sanitizeArticleHtml(parsed.data.bodyHtml);
    if (htmlToPlainText(safeHtml).length < 20) return reply.code(400).send({ error: "invalid_article_html", message: "正文 HTML 不包含足够的可读内容。" });
    if (safeHtml === (before.bodyHtml || "")) return { ok: true, article: publicShape(before) };
    const actor = meta(req);
    const after = await prisma.article.update({
      where: { id: before.id },
      data: { bodyHtml: safeHtml, bodyMarkdown: htmlToPlainText(safeHtml), updatedBy: actor.adminId },
    });
    await audit(prisma, req, "article.body_autosave", after.id, { bodyHtml: before.bodyHtml || "" }, { bodyHtml: after.bodyHtml || "" });
    return { ok: true, article: publicShape(after) };
  });

  fastify.patch<{ Params: { id: string } }>("/admin/articles/:id", { preHandler: [requireAdmin("content:edit")] }, async (req, reply) => {
    const parsed = ArticleInputZ.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_article_input", details: parsed.error.issues });
    const before = await prisma.article.findUnique({ where: { id: req.params.id } });
    if (!before) return reply.code(404).send({ error: "article_not_found", message: "文章不存在。" });
    const { reason, bodyHtml, coverImageUrl, ...input } = parsed.data;
    if (before.status === "published" && input.slug !== before.slug) {
      return reply.code(409).send({ error: "article_slug_locked", message: "文章已发布，URL 标识已锁定，避免既有分享链接失效。" });
    }
    const safeHtml = sanitizeArticleHtml(bodyHtml);
    if (htmlToPlainText(safeHtml).length < 20) return reply.code(400).send({ error: "invalid_article_html", message: "正文 HTML 不包含足够的可读内容。" });
    const actor = meta(req);
    const status = input.status || before.status;
    const after = await prisma.article.update({
      where: { id: before.id },
      data: {
        ...input,
        bodyHtml: safeHtml,
        bodyMarkdown: htmlToPlainText(safeHtml),
        coverImageUrl: coverImageUrl || null,
        sourceName: input.sourceName || null,
        sourceUrl: input.sourceUrl || null,
        seoTitle: input.seoTitle || null,
        seoDescription: input.seoDescription || null,
        status,
        publishedAt: status === "published" ? (before.publishedAt || new Date()) : null,
        updatedBy: actor.adminId,
      },
    });
    await audit(prisma, req, "article.update", after.id, publicShape(before), publicShape(after), reason);
    return { ok: true, article: publicShape(after) };
  });

  fastify.post<{ Params: { id: string } }>("/admin/articles/:id/publish", { preHandler: [requireAdmin("content:publish")] }, async (req, reply) => {
    const before = await prisma.article.findUnique({ where: { id: req.params.id } });
    if (!before) return reply.code(404).send({ error: "article_not_found", message: "文章不存在。" });
    const actor = meta(req);
    const after = await prisma.article.update({ where: { id: before.id }, data: { status: "published", publishedAt: before.publishedAt || new Date(), updatedBy: actor.adminId } });
    await audit(prisma, req, "article.publish", after.id, publicShape(before), publicShape(after));
    return { ok: true, article: publicShape(after) };
  });

  fastify.post<{ Params: { id: string } }>("/admin/articles/:id/archive", { preHandler: [requireAdmin("content:publish")] }, async (req, reply) => {
    const before = await prisma.article.findUnique({ where: { id: req.params.id } });
    if (!before) return reply.code(404).send({ error: "article_not_found", message: "文章不存在。" });
    const actor = meta(req);
    const after = await prisma.article.update({ where: { id: before.id }, data: { status: "archived", updatedBy: actor.adminId } });
    await audit(prisma, req, "article.archive", after.id, publicShape(before), publicShape(after));
    return { ok: true, article: publicShape(after) };
  });
}
