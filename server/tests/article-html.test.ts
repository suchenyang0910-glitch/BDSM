import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { htmlToPlainText, sanitizeArticleHtml } from "../src/lib/articleHtml.js";
import articleRoutes from "../src/routes/articles.js";

test("article HTML keeps the editorial allowlist and strips executable markup", () => {
  const html = sanitizeArticleHtml('<h2 onclick="alert(1)">标题</h2><p>正文<script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(2)"><a href="https://example.com" style="color:red">来源</a>');
  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /onclick|onerror|javascript:|style=/i);
  assert.match(html, /href="https:\/\/example\.com\//);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("article HTML derives a readable legacy plain-text shadow", () => {
  const html = sanitizeArticleHtml('<p>第一段 <strong>重点</strong></p><figure><img src="https://samewave.cc/example.png" alt="示意图"><figcaption>图注</figcaption></figure>');
  assert.equal(htmlToPlainText(html), "第一段 重点\n图注");
});

test("article HTML keeps accessible table structure without attributes", () => {
  const html = sanitizeArticleHtml('<table class="unsafe"><thead><tr><th onclick="x()">状态</th></tr></thead><tbody><tr><td>停止</td></tr></tbody></table>');
  assert.equal(html, "<table><thead><tr><th>状态</th></tr></thead><tbody><tr><td>停止</td></tr></tbody></table>");
});

test("public article API exposes a cover and already-sanitized HTML only", async () => {
  const app = Fastify();
  app.decorate("prisma", {
    article: {
      findMany: async () => [{
        slug: "safe-html-test", title: "安全 HTML", summary: "这是一段足够长的安全文章摘要，用于验证输出。",
        bodyMarkdown: "旧正文", bodyHtml: '<p>可见正文</p><script>alert(1)</script>', coverImageUrl: "https://samewave.cc/article-assets/cover.png",
        topics: ["沟通"], status: "published", publishedAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:00:00Z"),
      }],
    },
  });
  await app.register(articleRoutes, { prefix: "/api" });
  try {
    const result = await app.inject({ method: "GET", url: "/api/articles/safe-html-test" });
    assert.equal(result.statusCode, 200, result.body);
    const body = result.json() as { coverImageUrl: string; bodyHtml: string };
    assert.equal(body.coverImageUrl, "https://samewave.cc/article-assets/cover.png");
    assert.match(body.bodyHtml, /<p>可见正文<\/p>/);
    assert.match(body.bodyHtml, /&lt;script&gt;/);
  } finally {
    await app.close();
  }
});
