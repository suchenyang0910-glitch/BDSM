import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const gatewayPath = path.resolve(TEST_DIR, "../src/routes/playbackMedia.ts");

test("playback media gateway streams HLS fragments instead of redirecting to object storage", async () => {
  const source = await readFile(gatewayPath, "utf8");
  assert.match(source, /streamObjectForRead\(storage\.bucket, objectKey\)/);
  assert.match(source, /reply\.send\(result\.Body\)/);
  assert.doesNotMatch(source, /redirect\(signed\.downloadUrl,\s*302\)/);
});
