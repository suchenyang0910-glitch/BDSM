/**
 * One-time, idempotent import of the original public article guide into the
 * editable Article CMS. Existing CMS rows are never overwritten.
 */
import { PrismaClient } from "@prisma/client";
import { STATIC_ARTICLES } from "../routes/articles.js";
import { htmlToPlainText } from "../lib/articleHtml.js";

const prisma = new PrismaClient();

async function main() {
  let created = 0;
  let existing = 0;
  for (const article of STATIC_ARTICLES) {
    const found = await prisma.article.findUnique({ where: { slug: article.slug }, select: { id: true } });
    if (found) {
      existing += 1;
      continue;
    }
    await prisma.article.create({
      data: {
        slug: article.slug,
        title: article.title,
        summary: article.summary,
        bodyHtml: article.bodyHtml,
        bodyMarkdown: htmlToPlainText(article.bodyHtml),
        coverImageUrl: article.coverImageUrl,
        sourceName: article.sourceName || null,
        sourceUrl: article.sourceUrl || null,
        topics: article.topics,
        seoTitle: article.seo.title,
        seoDescription: article.seo.description,
        seoKeywords: article.seo.keywords,
        geoKeywords: article.seo.geoKeywords,
        status: "published",
        publishedAt: new Date(article.publishedAt),
      },
    });
    created += 1;
  }
  console.log(JSON.stringify({ ok: true, created, existing, total: STATIC_ARTICLES.length }));
}

main()
  .catch((error) => { console.error("static_article_import_failed", error instanceof Error ? error.message : "unknown"); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
