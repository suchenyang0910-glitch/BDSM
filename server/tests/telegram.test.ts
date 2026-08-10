import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { getTelegramBotCredentials, validateTelegramInitData } from "../src/utils/telegram.js";

function makeInitData(token: string, authDate: number): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAEAAQ",
    user: JSON.stringify({ id: 99887766, first_name: "Test", username: "test_user" }),
  });
  const dataCheckString = [...params.keys()].sort().map((key) => `${key}=${params.get(key)}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex"));
  return params.toString();
}

test("valid initData is accepted only by the signing Bot token", () => {
  const primary = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
  const backup = "987654321:ZYXWVUTSRQPONMLKJIHGFEDCBA987654321";
  const initData = makeInitData(primary, Math.floor(Date.now() / 1000));
  assert.equal(validateTelegramInitData(initData, primary).ok, true);
  assert.equal(validateTelegramInitData(initData, backup).ok, false);
});

test("expired initData is rejected", () => {
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
  const initData = makeInitData(token, Math.floor(Date.now() / 1000) - 3601);
  assert.equal(validateTelegramInitData(initData, token).ok, false);
});

test("malformed hash is rejected without throwing", () => {
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
  const params = new URLSearchParams(makeInitData(token, Math.floor(Date.now() / 1000)));
  params.set("hash", "not-a-valid-hex-hash");
  assert.doesNotThrow(() => validateTelegramInitData(params.toString(), token));
  assert.equal(validateTelegramInitData(params.toString(), token).ok, false);
});

test("multiple active Bot credentials are parsed from the controlled server allowlist", () => {
  const previous = process.env.TELEGRAM_BOTS;
  process.env.TELEGRAM_BOTS = JSON.stringify([
    { key: "primary", username: "InTune_bdsm_bot", token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789", active: true },
    { key: "backup", username: "InTune_backup_bot", token: "987654321:ZYXWVUTSRQPONMLKJIHGFEDCBA987654321", active: true },
  ]);
  const bots = getTelegramBotCredentials();
  assert.deepEqual(bots.map((bot) => bot.key), ["primary", "backup"]);
  if (previous === undefined) delete process.env.TELEGRAM_BOTS;
  else process.env.TELEGRAM_BOTS = previous;
});
