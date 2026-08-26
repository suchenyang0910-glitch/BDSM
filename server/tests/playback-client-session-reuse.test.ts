import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

for (const file of ["h5/app.js", "telegram-mini-app/app.js"]) {
  test(`${file} reuses a prepared HLS session before MediaSource sets currentSrc`, async () => {
    const source = await readFile(path.join(ROOT, file), "utf8");
    assert.match(source, /if \(state\.player\.preparedContentId === detail\.id\) \{/);
    assert.doesNotMatch(source, /preparedContentId === detail\.id && video\.currentSrc/);
    assert.match(source, /sessionReady: false/);
    assert.match(source, /state\.sessionReady = true/);
    assert.match(source, /bootstrapApp\(\);/);
    assert.doesNotMatch(source, /else routeTo\(parseHash\(\)\);\s*bootstrapApp\(\);/);
    assert.match(source, /function playbackErrorClass\(err\)/);
    assert.match(source, /console\.warn\("\[playback\] failed", errorClass\)/);
  });
}
