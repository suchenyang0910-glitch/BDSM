import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";

test("same-origin HLS vendor route serves the bundled player", async () => {
  const app = fastify();
  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), "node_modules", "hls.js", "dist"),
    prefix: "/api/vendor/hls/",
    decorateReply: false,
    index: false,
  });
  await app.ready();
  const response = await app.inject({ method: "GET", url: "/api/vendor/hls/hls.min.js" });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"] || ""), /javascript/);
  assert.match(response.body, /Hls/);
  await app.close();
});

test("H5 and Mini App reference the same-origin HLS player instead of a third-party CDN", () => {
  const root = path.resolve(process.cwd(), "..");
  for (const relativePath of ["h5/index.html", "telegram-mini-app/index.html"]) {
    const html = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert.match(html, /src="\/api\/vendor\/hls\/hls\.min\.js"/);
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/hls\.js/i);
  }
});
