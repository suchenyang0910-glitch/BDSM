import assert from "node:assert/strict";
import test from "node:test";
import { articlePublicUrl, buildArticleTelegramCaption, publishArticleToFreeChannels } from "../src/services/articleTelegramPublisher.js";

test("article Telegram caption contains title, summary, topic, keywords and public link", () => {
  const previous = process.env.PUBLIC_WEB_ORIGIN;
  process.env.PUBLIC_WEB_ORIGIN = "https://samewave.cc/";
  try {
    const caption = buildArticleTelegramCaption({
      slug: "safe-boundaries",
      title: "边界与沟通",
      summary: "一篇足够清晰的文章简介，用于验证频道分发文案。",
      topics: ["沟通", "边界"],
      seoKeywords: ["安全词", "沟通"],
      geoKeywords: ["成年人"],
    });
    assert.match(caption, /<b>边界与沟通<\/b>/);
    assert.match(caption, /主题.*#沟通 #边界/);
    assert.match(caption, /关键词.*#安全词 #沟通 #成年人/);
    assert.match(caption, /https:\/\/samewave\.cc\/#view=article&id=safe-boundaries&from=telegram/);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_WEB_ORIGIN;
    else process.env.PUBLIC_WEB_ORIGIN = previous;
  }
});

test("article public link rejects unsafe configured origins", () => {
  const previous = process.env.PUBLIC_WEB_ORIGIN;
  process.env.PUBLIC_WEB_ORIGIN = "http://internal.example";
  try {
    assert.equal(articlePublicUrl("article-a"), "https://samewave.cc/#view=article&id=article-a&from=telegram");
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_WEB_ORIGIN;
    else process.env.PUBLIC_WEB_ORIGIN = previous;
  }
});

test("published article never re-sends a channel delivery that is already marked sent", async () => {
  let upserted = 0;
  let lockAttempted = 0;
  const prisma = {
    article: {
      findUnique: async () => ({
        id: "article-sent-once",
        status: "published",
        coverImageUrl: "https://cdn.example.test/article-cover.jpg",
        slug: "safe-boundaries",
        title: "边界与沟通",
        summary: "文章简介足够长，用于验证已发送记录的幂等行为。",
        topics: [], seoKeywords: [], geoKeywords: [],
      }),
    },
    adminManagedChannel: {
      findMany: async () => [{ id: "free-channel-a", deprecatedChatIdBig: BigInt(-1001), chatIdCiphertextB64: null }],
    },
    articleTelegramDelivery: {
      upsert: async () => {
        upserted += 1;
        return { id: "delivery-a", status: "sent" };
      },
      updateMany: async () => {
        lockAttempted += 1;
        return { count: 0 };
      },
    },
  } as any;

  const result = await publishArticleToFreeChannels(prisma, "article-sent-once");
  assert.deepEqual(result, { targets: 1, sent: 0, failed: 0, skipped: 1 });
  assert.equal(upserted, 1);
  assert.equal(lockAttempted, 0, "a sent delivery must not fetch a cover or call Telegram again");
});

test("article without a cover never queries channels or creates a delivery", async () => {
  let channelsQueried = false;
  const prisma = {
    article: {
      findUnique: async () => ({ id: "article-without-cover", status: "published", coverImageUrl: null }),
    },
    adminManagedChannel: {
      findMany: async () => { channelsQueried = true; return []; },
    },
  } as any;

  const result = await publishArticleToFreeChannels(prisma, "article-without-cover");
  assert.deepEqual(result, { targets: 0, sent: 0, failed: 0, skipped: 0, reason: "missing_cover" });
  assert.equal(channelsQueried, false);
});
