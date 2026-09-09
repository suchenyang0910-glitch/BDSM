import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptPath = new URL("../scripts/runCommunityGuidedExperiment.ts", import.meta.url);

test("official AI community experiment requires an explicit write confirmation and preserves transparent labels", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /--confirm-official-ai-experiment/);
  assert.match(source, /--dry-run/);
  assert.equal((source.match(/\bday:\s*\d+/g) ?? []).length, 20);
  assert.match(source, /isOfficial:\s*true/);
  assert.match(source, /aiAssisted:\s*true/);
  assert.match(source, /status:\s*shouldPublish\s*\?\s*"published"\s*:\s*"pending"/);
  assert.match(source, /未创建用户、点赞、评论、阅读或举报等任何虚假互动/);
});

test("official AI community experiment queues future posts and only releases posts due at the scheduled time", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /publishedAt:\s*scheduledAt/);
  assert.match(source, /publishedAt:\s*\{\s*lte:\s*now\s*\}/);
  assert.match(source, /status:\s*"pending"/);
  assert.match(source, /data:\s*\{\s*status:\s*"published"\s*\}/);
});
