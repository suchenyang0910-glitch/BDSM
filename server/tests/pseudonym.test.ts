import assert from "node:assert/strict";
import test from "node:test";
import { PLATFORM_PSEUDONYM_COUNT, platformPseudonymAt, isLegacyPlatformDisplayName, isPlatformPseudonym } from "../src/utils/pseudonym.js";

test("platform pseudonym library provides more than one thousand original combinations", () => {
  assert.ok(PLATFORM_PSEUDONYM_COUNT >= 1000);
  const names = new Set(Array.from({ length: PLATFORM_PSEUDONYM_COUNT }, (_, index) => platformPseudonymAt(index)));
  assert.equal(names.size, PLATFORM_PSEUDONYM_COUNT, "each indexed nickname should be distinct");
  assert.match(platformPseudonymAt(0), /^[\u4e00-\u9fff]+$/);
});

test("only technical legacy names are eligible for one-time nickname migration", () => {
  assert.equal(isLegacyPlatformDisplayName("同频用户 A1B2C3"), true);
  assert.equal(isLegacyPlatformDisplayName("本机账户"), true);
  assert.equal(isLegacyPlatformDisplayName("月光边界"), false);
  assert.equal(isLegacyPlatformDisplayName("用户自己设置的名字"), false);
  assert.equal(isPlatformPseudonym("月光边界"), true);
  assert.equal(isPlatformPseudonym("Faxonlei"), false);
});
