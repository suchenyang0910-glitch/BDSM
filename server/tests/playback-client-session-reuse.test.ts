import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

for (const file of ["h5/app.js", "telegram-mini-app/app.js"]) {
  test(`${file} refreshes a deep-linked detail after automatic login and reuses its prefetched HLS session`, async () => {
    const source = await readFile(path.join(ROOT, file), "utf8");
    assert.match(source, /await bootstrapSession\(\);[\s\S]{0,500}state\.detailCache = \{\};/);
    assert.match(source, /const prefetched = state\.player\.prefetchedSession;/);
    assert.match(source, /prefetched && prefetched\.contentId === detail\.id/);
    assert.match(source, /routeTo\(parseHash\(\)\);/);
  });
}
