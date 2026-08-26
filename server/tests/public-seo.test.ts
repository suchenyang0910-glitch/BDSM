import assert from "node:assert/strict";
import test from "node:test";
import { buildRobotsTxt, buildSitemapXml, resolvePublicWebOrigin } from "../src/routes/publicSeo.js";

test("public SEO: canonical origin accepts HTTPS only", () => {
  assert.equal(resolvePublicWebOrigin("https://samewave.cc/path"), "https://samewave.cc");
  assert.equal(resolvePublicWebOrigin("http://unsafe.example"), "https://samewave.cc");
  assert.equal(resolvePublicWebOrigin("not a url"), "https://samewave.cc");
});

test("public SEO: robots keeps private application surfaces out of crawlers", () => {
  const robots = buildRobotsTxt("https://samewave.cc");
  assert.match(robots, /Allow: \/content\//);
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Disallow: \/admin\//);
  assert.match(robots, /Sitemap: https:\/\/samewave\.cc\/sitemap\.xml/);
});

test("public SEO: sitemap canonicalizes only server paths and escapes XML", () => {
  const xml = buildSitemapXml("https://samewave.cc", [{ id: "abc&123", updatedAt: new Date("2026-08-26T00:00:00.000Z") }]);
  assert.match(xml, /<loc>https:\/\/samewave\.cc\/discover<\/loc>/);
  assert.match(xml, /https:\/\/samewave\.cc\/content\/abc%26123/);
  assert.match(xml, /<lastmod>2026-08-26<\/lastmod>/);
});
