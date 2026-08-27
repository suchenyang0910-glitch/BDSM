import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { getTelegramBotCredentials, validateTelegramInitData } from "../src/utils/telegram.js";
import { createStreamingMultipartPayload, resolveMiniAppUrl, withMiniAppLaunchButton } from "../src/services/telegramBot.js";
import { buildFullVideoCaption, buildPreviewVideoCaption } from "../src/services/telegramPublisher.js";
import { miniAppContentUrl, parsePrivateStartCommand } from "../src/routes/telegramWebhook.js";

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

test("Bot 私信统一追加受控 Mini App 入口，且不重复覆盖业务按钮", () => {
  const markup = withMiniAppLaunchButton({
    inline_keyboard: [[{ text: "复制订单号", copy_text: { text: "INT202608240001" } }]],
  }, "https://mini.example.com/");
  assert.deepEqual(markup.inline_keyboard, [
    [{ text: "复制订单号", copy_text: { text: "INT202608240001" } }],
    [{ text: "打开 Mini App", web_app: { url: "https://mini.example.com/" } }],
  ]);
  const stable = withMiniAppLaunchButton(markup, "https://other.example.com/");
  assert.equal(stable.inline_keyboard.length, 2, "已有 Mini App 按钮时不得重复追加");
  assert.equal(stable.inline_keyboard[1]?.[0]?.web_app?.url, "https://mini.example.com/");
  assert.equal(resolveMiniAppUrl("javascript:alert(1)"), "https://bdsm.linkx.club/");
});

test("免费频道试看文案只导向官方 Bot 对话，不直跳站外收银台", () => {
  const withProduct = buildPreviewVideoCaption({
    id: "content-test-001",
    productId: "product-test-001",
    title: "测试试看",
    description: "测试说明",
  });
  assert.match(withProduct.caption, /https:\/\/t\.me\/InTune_bdsm_bot\?start=content_content-test-001/);
  assert.match(withProduct.caption, /👉👉<a href="https:\/\/t\.me\/InTune_bdsm_bot\?start=content_content-test-001">打开【同频 Bot】 查看试看与完整内容<\/a>👈👈/);
  assert.doesNotMatch(withProduct.caption, /h5-pay\.html|bdsm\.linkx\.club/);

  const withoutProduct = buildPreviewVideoCaption({
    id: "content-test-002",
    productId: null,
    title: "免费内容",
    description: "测试说明",
  });
  assert.match(withoutProduct.caption, /https:\/\/t\.me\/InTune_bdsm_bot/);
  assert.doesNotMatch(withoutProduct.caption, /h5-pay\.html|\?content=/);
});

test("Bot /start content payload 只接受私聊 UUID，并生成直达内容详情的 Mini App 地址", () => {
  const contentId = "d271bf24-a872-42e3-a8af-ae83a738b1e5";
  assert.deepEqual(
    parsePrivateStartCommand({ message: { chat: { type: "private" }, from: { id: 123456 }, text: `/start content_${contentId}` } }),
    { telegramUserId: "123456", contentId },
  );
  assert.equal(parsePrivateStartCommand({ message: { chat: { type: "group" }, from: { id: 123456 }, text: "/start" } }), null);
  assert.equal(parsePrivateStartCommand({ message: { chat: { type: "private" }, from: { id: 123456 }, text: "/start content_not-a-uuid" } })?.contentId, null);
  assert.equal(miniAppContentUrl(contentId), `https://bdsm.linkx.club/#view=content&id=${contentId}&from=bot`);
});

test("私密频道完整视频文案必须包含标题与简介", () => {
  const caption = buildFullVideoCaption({ title: "会员完整内容", description: "仅对已解锁成员开放。" });
  assert.match(caption.caption, /会员完整内容/);
  assert.match(caption.caption, /仅对已解锁成员开放/);
  assert.equal(caption.parseMode, "HTML");
});

test("对象存储视频以真实流式 multipart 字节上传，绝不把 Readable 序列化成对象", async () => {
  const videoBytes = Buffer.from([0, 1, 2, 3, 0xff, 0x00, 0x7f]);
  const multipart = createStreamingMultipartPayload([
    { name: "chat_id", type: "text", value: "-1000000000001" },
    { name: "video", type: "file", filename: "source.mp4", contentType: "video/mp4", body: Readable.from([videoBytes]) },
  ]);
  const pieces: Buffer[] = [];
  for await (const piece of multipart.body) pieces.push(Buffer.from(piece));
  const wire = Buffer.concat(pieces);
  assert.match(multipart.contentType, /^multipart\/form-data; boundary=----intune-/);
  assert.ok(wire.includes(videoBytes), "multipart 必须包含原始视频二进制字节");
  assert.equal(wire.toString("utf8").includes("[object Object]"), false, "不得将 Node Readable 包装为 Blob 后序列化");
  assert.match(wire.toString("latin1"), /Content-Type: video\/mp4/);
});
