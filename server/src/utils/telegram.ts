import crypto from "crypto";

export type TelegramBotCredential = { key: string; token: string; username?: string; active: boolean };

/** 受控登录 Bot 白名单。Token 仅可存在于服务端环境变量。 */
export function getTelegramBotCredentials(): TelegramBotCredential[] {
  const raw = process.env.TELEGRAM_BOTS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<Partial<TelegramBotCredential>>;
      if (!Array.isArray(parsed)) throw new Error("must be a JSON array");
      const bots = parsed
        .filter((bot) => typeof bot.key === "string" && /^[a-z0-9_-]{1,32}$/i.test(bot.key) && typeof bot.token === "string" && bot.token.length > 20)
        .map((bot) => ({ key: bot.key!, token: bot.token!, username: bot.username, active: bot.active !== false }));
      if (bots.length) return bots;
    } catch (error) {
      throw new Error(`Invalid TELEGRAM_BOTS: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token ? [{ key: "primary", token, username: process.env.TELEGRAM_BOT_USERNAME, active: true }] : [];
}

export function getTelegramBotByKey(key?: string): TelegramBotCredential | undefined {
  const bots = getTelegramBotCredentials().filter((bot) => bot.active);
  return key ? bots.find((bot) => bot.key === key) : bots[0];
}

/**
 * Telegram WebApp initData HMAC-SHA256 验签
 * 规则：https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
 *
 * @param initData 原始 initData 字符串（前端直接传的 query string 格式）
 * @param botToken 服务端 Bot Token（绝不能泄露给前端）
 * @returns 验签是否通过，以及解析后的 data 对象
 */
export function validateTelegramInitData(
  initData: string,
  botToken: string,
): { ok: boolean; data: Record<string, string>; user?: { id: number; first_name: string; last_name?: string; username?: string; language_code?: string; photo_url?: string } } {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  params.delete("hash");

  const sortedKeys = [...params.keys()].sort();
  const dataCheckString = sortedKeys
    .map((k) => `${k}=${params.get(k)}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const data: Record<string, string> = {};
  sortedKeys.forEach((k) => {
    data[k] = params.get(k) || "";
  });

  let user: any;
  try {
    if (data.user) user = JSON.parse(data.user);
  } catch {
    user = undefined;
  }

  const expectedHashBuffer = Buffer.from(expectedHash, "hex");
  const receivedHashBuffer = Buffer.from(receivedHash, "hex");
  // timingSafeEqual 会在长度不一致时抛异常；无效输入必须安全地返回 false。
  const hashOk =
    receivedHash.length === 64 &&
    receivedHashBuffer.length === expectedHashBuffer.length &&
    crypto.timingSafeEqual(expectedHashBuffer, receivedHashBuffer);

  const authDate = Number(data.auth_date);
  const timeOk = Number.isFinite(authDate) && Date.now() / 1000 - authDate < 3600;

  return { ok: hashOk && timeOk, data, user };
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
