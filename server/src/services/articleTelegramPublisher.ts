import type { Article, PrismaClient } from "@prisma/client";

import { decryptChatIdAesGcm } from "../utils/crypto.js";
import { emitSafetyEvent } from "../utils/structuredError.js";
import { refRawChatId, sendMediaFromStorage } from "./telegramBot.js";

const FALLBACK_PUBLIC_ORIGIN = "https://samewave.cc";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hashtag(value: string): string | null {
  const normalized = String(value || "").trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_]/gu, "");
  return normalized ? `#${normalized.slice(0, 64)}` : null;
}

export function articlePublicUrl(slug: string): string {
  const configured = String(process.env.PUBLIC_WEB_ORIGIN || FALLBACK_PUBLIC_ORIGIN).trim();
  let origin = FALLBACK_PUBLIC_ORIGIN;
  try {
    const url = new URL(configured);
    if (url.protocol === "https:" && !url.username && !url.password) origin = url.origin;
  } catch { /* keep safe production origin */ }
  return `${origin}/#view=article&id=${encodeURIComponent(slug)}&from=telegram`;
}

/** The caption is a pure function so wording and safety limits stay regression-testable. */
export function buildArticleTelegramCaption(article: Pick<Article, "slug" | "title" | "summary" | "topics" | "seoKeywords" | "geoKeywords">): string {
  const themes = (article.topics || []).map(hashtag).filter((value): value is string => !!value).slice(0, 8);
  const keywords = [...(article.seoKeywords || []), ...(article.geoKeywords || [])]
    .map(hashtag).filter((value): value is string => !!value)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 12);
  return [
    `<b>${escapeHtml(article.title)}</b>`,
    "",
    escapeHtml(article.summary),
    themes.length ? `<b>主题</b>：${themes.join(" ")}` : null,
    keywords.length ? `<b>关键词</b>：${keywords.join(" ")}` : null,
    "",
    `阅读全文：<a href="${articlePublicUrl(article.slug)}">打开 Samewave 文章</a>`,
  ].filter((line): line is string => line !== null).join("\n");
}

function filenameFromUrl(rawUrl: string): string {
  try {
    const name = decodeURIComponent(new URL(rawUrl).pathname.split("/").pop() || "article-cover.jpg");
    return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "article-cover.jpg";
  } catch { return "article-cover.jpg"; }
}

async function readPublicCover(url: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; filename: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("article_cover_url_invalid");
  const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() || "";
  if (!response.ok || !response.body || !/^image\/(jpeg|png|webp)$/i.test(contentType)) throw new Error("article_cover_unavailable");
  return { body: response.body, contentType, filename: filenameFromUrl(url) };
}

export type ArticleTelegramPublishResult = {
  targets: number;
  sent: number;
  failed: number;
  skipped: number;
  reason?: "missing_cover" | "no_free_channel";
};

/**
 * Post a newly-published article to every enabled public free-traffic channel.
 * A unique article/channel row is created before sending, so refreshes and
 * repeated publish clicks can retry failures but cannot duplicate sent posts.
 */
export async function publishArticleToFreeChannels(prisma: PrismaClient, articleId: string): Promise<ArticleTelegramPublishResult> {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article || article.status !== "published") return { targets: 0, sent: 0, failed: 0, skipped: 0 };
  if (!article.coverImageUrl) return { targets: 0, sent: 0, failed: 0, skipped: 0, reason: "missing_cover" };
  const channels = await prisma.adminManagedChannel.findMany({
    where: { purpose: "free_preview", chatType: "channel", isPrivate: false, botIsAdmin: true, botCanPostMessages: true },
    select: { id: true, deprecatedChatIdBig: true, chatIdCiphertextB64: true },
  });
  if (!channels.length) return { targets: 0, sent: 0, failed: 0, skipped: 0, reason: "no_free_channel" };

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const channel of channels) {
    const delivery = await prisma.articleTelegramDelivery.upsert({
      where: { articleId_managedChannelId: { articleId: article.id, managedChannelId: channel.id } },
      create: { articleId: article.id, managedChannelId: channel.id, status: "queued" },
      update: {},
    });
    if (delivery.status === "sent") { skipped += 1; continue; }
    const lock = await prisma.articleTelegramDelivery.updateMany({
      where: { id: delivery.id, status: { in: ["queued", "failed"] } },
      data: { status: "processing", attempt: { increment: 1 }, lastAttemptedAt: new Date(), lastErrorClass: null, lastErrorNote: null },
    });
    if (lock.count !== 1) { skipped += 1; continue; }
    try {
      let chatId = channel.deprecatedChatIdBig;
      if (chatId == null) chatId = decryptChatIdAesGcm(channel.chatIdCiphertextB64);
      const cover = await readPublicCover(article.coverImageUrl);
      const result = await sendMediaFromStorage("primary", refRawChatId(chatId), {
        tgMethod: "sendPhoto",
        mediaFilename: cover.filename,
        mediaContentType: cover.contentType,
        mediaBody: cover.body,
        caption: buildArticleTelegramCaption(article),
        parseMode: "HTML",
      });
      if (!result.success || !result.messageId) throw new Error("telegram_send_photo_failed");
      await prisma.articleTelegramDelivery.update({
        where: { id: delivery.id },
        data: { status: "sent", telegramMessageId: BigInt(result.messageId), sentAt: new Date() },
      });
      sent += 1;
    } catch (error) {
      const errorClass = error instanceof Error && /^article_cover_/.test(error.message) ? error.message : "telegram_article_delivery_failed";
      await prisma.articleTelegramDelivery.update({
        where: { id: delivery.id },
        data: { status: "failed", lastErrorClass: errorClass, lastErrorNote: "delivery_failed" },
      });
      emitSafetyEvent({ event: "article_telegram_delivery_failed", errorClass, note: `article=${article.id.slice(0, 8)} channel=${channel.id.slice(0, 8)}` }, error);
      failed += 1;
    }
  }
  return { targets: channels.length, sent, failed, skipped };
}
