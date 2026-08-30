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

  test(`${file} keeps a stable detail response when deep-link routing races session bootstrap`, async () => {
    const source = await readFile(path.join(ROOT, file), "utf8");
    assert.match(source, /let detail = state\.detailCache\[id\] \|\| null;/);
    assert.match(source, /detail = await apiCall\("\/api\/contents\/" \+ encodeURIComponent\(id\)\);/);
    assert.match(source, /if \(state\.route\.view !== "detail" \|\| state\.route\.id !== id\) return;/);
    assert.match(source, /if \(!detail \|\| typeof detail !== "object" \|\| !detail\.id\)/);
    assert.doesNotMatch(source, /const detail = state\.detailCache\[id\];/);
  });
}
