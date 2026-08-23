/**
 * Telegram 频道交付服务。
 *
 * 【Security Boundary - 细节2】
 *  路由层只允许传递 ChannelRef（内部引用标识），明文 chatId 仅在本服务层的受控方法中
 *  通过 resolveChannelRefToChatId() 解析并直接调用 TG API。路由层严禁从 env 直接读取
 *  频道 ID 或组装明文 chatId。
 *
 * 【Phase 0-3 / 0-5 红线】getUpdates 与 webhook 互斥：
 *  - 在 webhook 已设置时，`getUpdates` 不会正常工作；二者不得同时启用。
 *  - 生产代码严禁调用 getUpdates；NODE_ENV=production 且 TELEGRAM_DEV_USE_GETUPDATES=true → 启动崩溃。
 *  - 仅 NODE_ENV!==production + TELEGRAM_DEV_USE_GETUPDATES=true 时允许 getUpdates（开发用）。
 */
import { getTelegramBotByKey, type TelegramBotCredential } from "../utils/telegram.js";
import { chatIdIndexKey, constantTimeEqual } from "../utils/crypto.js";

const API_BASE = "https://api.telegram.org";

// ======= ChannelRef（内部引用）体系：路由层只传 ref，不在路由层出现明文 chatId =======

export type ChannelRefKind =
  | "membership_main"
  | "package_featured"
  | "managed_chat_id_bigint"
  | "raw_chat_id_bigint"; // 仅 Admin ManagedChannel 内部流转，不跨层暴露给非管理员路由

export type MembershipChannelRef = { kind: "membership_main" };
export type PackageFeaturedChannelRef = { kind: "package_featured" };
export type ManagedChannelRef = { kind: "managed_chat_id_bigint"; chatId: bigint };
export type RawChatIdRef = { kind: "raw_chat_id_bigint"; chatId: bigint };

export type ChannelRef =
  | MembershipChannelRef
  | PackageFeaturedChannelRef
  | ManagedChannelRef
  | RawChatIdRef;

export function refMembershipMain(): MembershipChannelRef {
  return { kind: "membership_main" };
}
export function refPackageFeatured(): PackageFeaturedChannelRef {
  return { kind: "package_featured" };
}
export function refManagedChat(chatId: bigint): ManagedChannelRef {
  return { kind: "managed_chat_id_bigint", chatId };
}
export function refRawChatId(chatId: bigint): RawChatIdRef {
  return { kind: "raw_chat_id_bigint", chatId };
}

function assertChatId(kind: ChannelRefKind, value: string | null | undefined, envName: string): bigint {
  if (!value || !/^-?\d{6,22}$/.test(String(value))) {
    throw new Error(
      `[bot:${kind}] ${envName} 未配置或格式错误（必须为纯数字的 Telegram chat.id，通常私密频道以 -100 开头）。` +
        ` 请检查 staging / 生产服务器的 server/.env；该值禁止写入 Git。`,
    );
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`[bot:${kind}] ${envName} 格式非法：不是合法的 BigInt。`);
  }
}

function resolveChannelRefToChatId(ref: ChannelRef): bigint {
  switch (ref.kind) {
    case "membership_main":
      return assertChatId(
        ref.kind,
        process.env.TELEGRAM_CHANNEL_MEMBERSHIP ?? process.env.MEMBERSHIP_CHANNEL_ID ?? null,
        "TELEGRAM_CHANNEL_MEMBERSHIP",
      );
    case "package_featured":
      return assertChatId(
        ref.kind,
        process.env.TELEGRAM_CHANNEL_PACKAGE_FEATURED ?? null,
        "TELEGRAM_CHANNEL_PACKAGE_FEATURED",
      );
    case "managed_chat_id_bigint":
    case "raw_chat_id_bigint":
      return ref.chatId;
    default: {
      const _exhaustive: never = ref;
      throw new Error(`[bot:resolve] unknown ChannelRef kind: ${(_exhaustive as any).kind}`);
    }
  }
}

export function maskChatIdSafe(chatId: bigint | number | string): string {
  const raw = String(chatId);
  if (!raw) return "****";
  const tail = raw.slice(-3);
  if (raw.startsWith("-100")) return `-100********${tail}`;
  if (raw.startsWith("-")) return `-********${tail}`;
  return `********${tail}`;
}

export function chatIdFingerprint(chatId: bigint | number | string): string {
  return chatIdIndexKey(chatId);
}

function hasRealToken(bot?: TelegramBotCredential): bot is TelegramBotCredential {
  return Boolean(bot?.token && !bot.token.includes("REPLACE_") && !bot.token.includes("placeholder") && bot.token.includes(":"));
}

function getInviteBot(): TelegramBotCredential | undefined {
  return getTelegramBotByKey(process.env.TELEGRAM_INVITE_BOT_KEY);
}

function assertInviteBot(operation: string): TelegramBotCredential {
  const bot = getInviteBot();
  if (!hasRealToken(bot)) {
    throw new Error(
      `[bot:${operation}] no valid invite Bot configured. ` +
      `Set TELEGRAM_BOTS and TELEGRAM_INVITE_BOT_KEY in server/.env; the selected Bot must be a收费频道管理员。`,
    );
  }
  return bot;
}

export const TELEGRAM_CONFIG = {
  get tokenConfigured() { return hasRealToken(getInviteBot()); },
  get botUsername() { return getInviteBot()?.username || "InTune_bdsm_bot"; },
  get channelMembership() {
    const raw = process.env.MEMBERSHIP_CHANNEL_ID || process.env.TELEGRAM_MEMBERSHIP_CHANNEL;
    return raw ? String(raw) : null;
  },
  publicChannelUrl: process.env.PUBLIC_CHANNEL_URL || "https://t.me/InTune_bdsm",
  defaultInviteTtlSeconds: 3600,
  defaultInviteMemberLimit: 1,
} as const;

export type CreateInviteOptions = {
  channel: ChannelRef;
  ttlSeconds?: number;
  memberLimit?: number;
  name?: string;
};

export type TelegramInviteResult = {
  url: string;
  inviteLink: string;
  expiresAt: Date;
  ttlSeconds: number;
  stub: false;
  /**
   * 【Internal Use Only - 细节2】
   * 解析后的明文 chatId，仅用于服务层在同一调用栈中写入 telegram_invites 表；
   * 绝对禁止返回给路由层的 JSON 响应或写入审计日志的 afterValue。
   */
  _resolvedChannelId: bigint;
};

export type KickMemberOptions = {
  channel: ChannelRef;
  telegramUserId: bigint | number | string;
  allowReinvite?: boolean;
};

export type TelegramKickResult = {
  stub: false;
  success: boolean;
  errorMessage?: string;
  channelId: string;
  userId: string;
};

function channelIdString(channelId: bigint | number | string): string {
  return typeof channelId === "bigint" ? channelId.toString() : String(channelId);
}

async function callBotApi<T = unknown>(bot: TelegramBotCredential, method: string, payload: Record<string, unknown>): Promise<{ ok: boolean; result?: T; error_code?: number; description?: string }> {
  try {
    const response = await fetch(`${API_BASE}/bot${bot.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await response.json() as { ok: boolean; result?: T; error_code?: number; description?: string };
  } catch (error) {
    return { ok: false, error_code: 500, description: error instanceof Error ? error.message : "network error" };
  }
}

type MultipartField = { name: string; type: "text"; value: string | number | boolean } | { name: string; type: "file"; filename: string; contentType: string; body: unknown };

async function callBotApiMultipart<T = unknown>(
  bot: TelegramBotCredential,
  method: string,
  fields: MultipartField[],
): Promise<{ ok: boolean; result?: T; error_code?: number; description?: string }> {
  try {
    const FormDataCtor: any = (globalThis as any).FormData;
    if (!FormDataCtor) {
      return { ok: false, error_code: 500, description: "node_fetch_multipart_formdata_unavailable" };
    }
    const BlobCtor: any = (globalThis as any).Blob;
    const fd = new FormDataCtor();
    for (const f of fields) {
      if (f.type === "text") {
        fd.append(f.name, typeof f.value === "string" ? f.value : JSON.stringify(f.value));
      } else {
        let blobLike: any = f.body;
        if (BlobCtor && blobLike && !(blobLike instanceof BlobCtor)) {
          try { blobLike = new BlobCtor([blobLike], { type: f.contentType }); } catch { /* noop */ }
        }
        fd.append(f.name, blobLike, f.filename);
      }
    }
    const response = await fetch(`${API_BASE}/bot${bot.token}/${method}`, { method: "POST", body: fd as any });
    return await response.json() as { ok: boolean; result?: T; error_code?: number; description?: string };
  } catch (error) {
    return { ok: false, error_code: 500, description: error instanceof Error ? error.message : "network error" };
  }
}

export type SendMediaFromStoragePayload = {
  tgMethod: "sendVideo" | "sendPhoto";
  supportsStreaming?: boolean;
  caption?: string;
  parseMode?: "HTML" | "MarkdownV2" | "Markdown";
  thumbnail?: { filename: string; contentType: string; body: unknown } | null;
  mediaFilename: string;
  mediaContentType: string;
  mediaBody: unknown;
  extraTextFields?: Record<string, string | number | boolean>;
};

export type SendMediaFromStorageResult = {
  stub: false;
  success: boolean;
  chatFingerprint: string;
  chatMasked: string;
  errorCode?: number;
  errorNote?: string;
  messageId?: number;
  telegramFileId?: string;
  telegramFileUniqueId?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  waitedMs: number;
};

export async function createChannelInvite(opts: CreateInviteOptions): Promise<TelegramInviteResult> {
  const bot = assertInviteBot("create invite link");
  const chatId = resolveChannelRefToChatId(opts.channel);
  const ttlSeconds = opts.ttlSeconds ?? TELEGRAM_CONFIG.defaultInviteTtlSeconds;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const result = await callBotApi<{ invite_link: string }>(bot, "createChatInviteLink", {
    chat_id: channelIdString(chatId),
    expire_date: Math.floor(expiresAt.getTime() / 1000),
    member_limit: opts.memberLimit ?? TELEGRAM_CONFIG.defaultInviteMemberLimit,
    creates_join_request: false,
    ...(opts.name ? { name: opts.name } : {}),
  });
  if (!result.ok || !result.result?.invite_link) {
    throw new Error(`createChatInviteLink failed: [${result.error_code}] ${result.description || "unknown"}`);
  }
  return {
    url: result.result.invite_link,
    inviteLink: result.result.invite_link,
    expiresAt,
    ttlSeconds,
    stub: false,
    _resolvedChannelId: chatId, // 细节2：服务层内部使用，严禁写入 JSON 响应或审计日志
  };
}

export async function kickChannelMember(opts: KickMemberOptions): Promise<TelegramKickResult> {
  const bot = assertInviteBot("kick channel member");
  const chatId = resolveChannelRefToChatId(opts.channel);
  const channelId = channelIdString(chatId);
  const userId = channelIdString(opts.telegramUserId);
  const ban = await callBotApi(bot, "banChatMember", {
    chat_id: channelId,
    user_id: userId,
    until_date: opts.allowReinvite === false ? 0 : Math.floor(Date.now() / 1000) + 60,
    revoke_messages: false,
  });
  if (!ban.ok) return { stub: false, success: false, errorMessage: `banChatMember: [${ban.error_code}] ${ban.description || "unknown"}`, channelId, userId };
  if (opts.allowReinvite !== false) {
    const unban = await callBotApi(bot, "unbanChatMember", { chat_id: channelId, user_id: userId, only_if_banned: true });
    if (!unban.ok) return { stub: false, success: false, errorMessage: `unbanChatMember: [${unban.error_code}] ${unban.description || "unknown"}`, channelId, userId };
  }
  return { stub: false, success: true, channelId, userId };
}

export type SendDirectMessageOptions = {
  telegramUserId: bigint | number | string;
  text: string;
  parseMode?: "MarkdownV2" | "HTML" | "Markdown";
  disableWebPagePreview?: boolean;
  /** Telegram Bot API InlineKeyboardMarkup；仅用于受控 Bot 私信操作。 */
  replyMarkup?: {
    inline_keyboard: Array<Array<{
      text: string;
      url?: string;
      copy_text?: { text: string };
    }>>;
  };
};

export type SendDirectMessageResult = {
  stub: false;
  success: boolean;
  errorMessage?: string;
  userId: string;
  messageId?: number;
};

export async function sendDirectMessage(opts: SendDirectMessageOptions): Promise<SendDirectMessageResult> {
  const bot = assertInviteBot("send direct message");
  const userId = channelIdString(opts.telegramUserId);
  const result = await callBotApi<{ message_id: number }>(bot, "sendMessage", {
    chat_id: userId,
    text: opts.text,
    ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
    ...(opts.disableWebPagePreview !== undefined ? { disable_web_page_preview: opts.disableWebPagePreview } : {}),
    ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
  });
  if (!result.ok || !result.result) {
    return { stub: false, success: false, errorMessage: `sendMessage: [${result.error_code}] ${result.description || "unknown"}`, userId };
  }
  return { stub: false, success: true, userId, messageId: result.result.message_id };
}

export async function botSelfTest(): Promise<{ configured: boolean; stub: boolean; ok: boolean; botInfo?: { id: number; username?: string; first_name?: string }; error?: string }> {
  const bot = getInviteBot();
  if (!hasRealToken(bot)) return { configured: false, stub: true, ok: false, error: "No valid TELEGRAM_INVITE_BOT_KEY / TELEGRAM_BOTS configuration" };
  const result = await callBotApi<{ id: number; username?: string; first_name?: string }>(bot, "getMe", {});
  if (!result.ok || !result.result) return { configured: true, stub: false, ok: false, error: `getMe failed: [${result.error_code}] ${result.description || "unknown"}` };
  return { configured: true, stub: false, ok: true, botInfo: result.result };
}

export type GetChatResult = {
  stub: false;
  chatId: string;
  title?: string | null;
  username?: string | null;
  type: string;
  memberCount?: number;
  description?: string | null;
  inviteLink?: string | null;
  photo?: { smallFileId?: string; bigFileId?: string } | null;
  hasVisibleHistory?: boolean;
  isForum?: boolean;
};

export type GetChatMemberResult = {
  stub: false;
  chatId: string;
  userId: string;
  status: string;
  isMember: boolean;
  isAdministrator: boolean;
  canPostMessages?: boolean;
  /** Required by Telegram to pin posts in channels. */
  canEditMessages?: boolean;
  canInviteUsers?: boolean;
  canRestrictMembers?: boolean;
  canPinMessages?: boolean;
};

export async function getChat(chat: ChannelRef): Promise<GetChatResult> {
  const bot = assertInviteBot("getChat");
  const chatId = resolveChannelRefToChatId(chat);
  const id = channelIdString(chatId);
  const r = await callBotApi<any>(bot, "getChat", { chat_id: id });
  if (!r.ok || !r.result) throw new Error(`getChat failed: [${r.error_code}] ${r.description || "unknown"}`);
  const c = r.result as any;
  return {
    stub: false,
    chatId: id,
    title: c.title ?? null,
    username: c.username ?? null,
    type: String(c.type),
    description: c.description ?? null,
    inviteLink: c.invite_link ?? null,
    hasVisibleHistory: c.has_visible_history === true,
    isForum: c.is_forum === true,
    photo: c.photo
      ? { smallFileId: c.photo.small_file_id ?? undefined, bigFileId: c.photo.big_file_id ?? undefined }
      : null,
  };
}

export async function getChatByUsername(username: string): Promise<GetChatResult> {
  const bot = assertInviteBot("getChatByUsername");
  const normalized = String(username || "").trim().replace(/^@+/, "");
  if (!normalized || !/^[A-Za-z0-9_]{4,64}$/.test(normalized)) {
    throw new Error("getChatByUsername invalid username");
  }
  const chatId = `@${normalized}`;
  const r = await callBotApi<any>(bot, "getChat", { chat_id: chatId });
  if (!r.ok || !r.result) throw new Error(`getChat failed: [${r.error_code}] ${r.description || "unknown"}`);
  const c = r.result as any;
  return {
    stub: false,
    chatId: String(c.id),
    title: c.title ?? null,
    username: c.username ?? null,
    type: String(c.type),
    description: c.description ?? null,
    inviteLink: c.invite_link ?? null,
    hasVisibleHistory: c.has_visible_history === true,
    isForum: c.is_forum === true,
    photo: c.photo
      ? { smallFileId: c.photo.small_file_id ?? undefined, bigFileId: c.photo.big_file_id ?? undefined }
      : null,
  };
}

export async function getBotChatMember(chat: ChannelRef | string): Promise<GetChatMemberResult> {
  const bot = assertInviteBot("getBotChatMember");
  const chatId = typeof chat === "string"
    ? (String(chat).startsWith("@") ? String(chat) : channelIdString(BigInt(String(chat))))
    : channelIdString(resolveChannelRefToChatId(chat));
  const me = await botSelfTest();
  if (!me.ok || !me.botInfo?.id) {
    throw new Error(`getBotChatMember bot getMe failed: ${me.error || "unknown"}`);
  }
  const r = await callBotApi<any>(bot, "getChatMember", {
    chat_id: chatId,
    user_id: me.botInfo.id,
  });
  if (!r.ok || !r.result) throw new Error(`getChatMember failed: [${r.error_code}] ${r.description || "unknown"}`);
  const m = r.result as any;
  return {
    stub: false,
    chatId: String(chatId),
    userId: String(me.botInfo.id),
    status: String(m.status || "unknown"),
    isMember: ["member", "administrator", "creator"].includes(String(m.status || "")),
    isAdministrator: ["administrator", "creator"].includes(String(m.status || "")),
    canPostMessages: m.can_post_messages === true,
    canEditMessages: m.can_edit_messages === true,
    canInviteUsers: m.can_invite_users === true,
    canRestrictMembers: m.can_restrict_members === true,
    canPinMessages: m.can_pin_messages === true,
  };
}

export type SendChannelTextOptions = {
  channel: ChannelRef;
  text: string;
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
};

/** Posts a text-only operational message without exposing channel identifiers. */
export async function sendChannelText(opts: SendChannelTextOptions): Promise<{ success: boolean; messageId?: number; errorCode?: number }> {
  const bot = assertInviteBot("send channel text");
  const chatId = channelIdString(resolveChannelRefToChatId(opts.channel));
  const result = await callBotApi<{ message_id: number }>(bot, "sendMessage", {
    chat_id: chatId,
    text: opts.text,
    disable_web_page_preview: opts.disableWebPagePreview ?? false,
    disable_notification: opts.disableNotification ?? true,
  });
  if (!result.ok || !result.result?.message_id) return { success: false, errorCode: result.error_code };
  return { success: true, messageId: result.result.message_id };
}

/** Pins a previously posted message after the caller has performed a chat-type-aware permission preflight. */
export async function pinChannelMessage(opts: { channel: ChannelRef; messageId: number }): Promise<{ success: boolean; errorCode?: number }> {
  const bot = assertInviteBot("pin channel message");
  const chatId = channelIdString(resolveChannelRefToChatId(opts.channel));
  const result = await callBotApi<true>(bot, "pinChatMessage", {
    chat_id: chatId,
    message_id: opts.messageId,
    disable_notification: true,
  });
  return result.ok ? { success: true } : { success: false, errorCode: result.error_code };
}

export async function getChatMemberCount(chat: ChannelRef): Promise<number> {
  const bot = assertInviteBot("getChatMemberCount");
  const chatId = resolveChannelRefToChatId(chat);
  const id = channelIdString(chatId);
  const r = await callBotApi<number>(bot, "getChatMemberCount", { chat_id: id });
  if (!r.ok || typeof r.result !== "number") throw new Error(`getChatMemberCount failed: [${r.error_code}] ${r.description || "unknown"}`);
  return r.result;
}

// ============= 频道发布（P1-#5） =============
// 延迟要求：批量调用 Telegram API 时单次请求间必须 ≥350ms（防官方 flood 限制）
const TG_API_MIN_INTERVAL_MS = 350;
let _lastTgLaneAt = 0;
async function tgRateLimitSleepIfNeeded(): Promise<void> {
  const now = Date.now();
  const wait = TG_API_MIN_INTERVAL_MS - (now - _lastTgLaneAt);
  if (wait > 0) {
    await new Promise<void>((r) => setTimeout(r, wait));
  }
  _lastTgLaneAt = Date.now();
}

export type SendVideoPayload =
  | { videoFileId: string; caption?: string; supportsStreaming?: boolean; thumbnailFileId?: string; parseMode?: "MarkdownV2" | "HTML" | "Markdown" };

export type SendVideoToChannelResult = {
  stub: false;
  success: boolean;
  messageId?: number;
  /** 脱敏的目标频道指纹（HMAC，可入库/审计） */
  chatFingerprint: string;
  /** 脱敏的目标频道掩码（可展示给运营看） */
  chatMasked: string;
  /** 上传前等待时间（用于 flood 调试） */
  waitedMs: number;
  errorMessage?: string;
  /** 原始 TG error_code，内部排错用，不返回给前端 */
  _rawErrorCode?: number;
};

export async function sendVideoToChannel(
  channel: ChannelRef,
  payload: SendVideoPayload,
): Promise<SendVideoToChannelResult> {
  const bot = assertInviteBot("send video to channel");
  const chatId = resolveChannelRefToChatId(channel);
  const fingerprint = chatIdFingerprint(chatId);
  const masked = maskChatIdSafe(chatId);
  const startedAt = Date.now();
  await tgRateLimitSleepIfNeeded();
  const waitedMs = Date.now() - startedAt;

  const r = await callBotApi<{ message_id: number }>(bot, "sendVideo", {
    chat_id: channelIdString(chatId),
    video: payload.videoFileId,
    ...(payload.caption ? { caption: payload.caption } : {}),
    ...(payload.parseMode ? { parse_mode: payload.parseMode } : {}),
    ...(payload.supportsStreaming !== undefined ? { supports_streaming: payload.supportsStreaming } : {}),
    ...(payload.thumbnailFileId ? { thumbnail: payload.thumbnailFileId } : {}),
  });
  if (!r.ok || !r.result) {
    return {
      stub: false,
      success: false,
      chatFingerprint: fingerprint,
      chatMasked: masked,
      waitedMs,
      errorMessage: `sendVideo: [${r.error_code ?? 500}] ${r.description || "unknown"}`,
      _rawErrorCode: r.error_code,
    };
  }
  return {
    stub: false,
    success: true,
    messageId: r.result.message_id,
    chatFingerprint: fingerprint,
    chatMasked: masked,
    waitedMs,
  };
}

export async function sendMediaFromStorage(
  botSlot: TelegramBotSlot | undefined | null,
  channel: ChannelRef,
  payload: SendMediaFromStoragePayload,
): Promise<SendMediaFromStorageResult> {
  const bot = (botSlot ? resolveBotSlot(botSlot) : undefined) || assertInviteBot("send media from storage");
  const chatId = resolveChannelRefToChatId(channel);
  const fingerprint = chatIdFingerprint(chatId);
  const masked = maskChatIdSafe(chatId);
  const startedAt = Date.now();
  await tgRateLimitSleepIfNeeded();
  const waitedMs = Date.now() - startedAt;

  const fileField = payload.tgMethod === "sendPhoto" ? "photo" : "video";
  const fields: MultipartField[] = [
    { name: "chat_id", type: "text", value: channelIdString(chatId) },
    { name: fileField, type: "file", filename: payload.mediaFilename, contentType: payload.mediaContentType, body: payload.mediaBody },
  ];
  if (payload.caption) fields.push({ name: "caption", type: "text", value: payload.caption });
  if (payload.parseMode) fields.push({ name: "parse_mode", type: "text", value: payload.parseMode });
  if (payload.tgMethod === "sendVideo" && payload.supportsStreaming !== undefined) {
    fields.push({ name: "supports_streaming", type: "text", value: payload.supportsStreaming });
  }
  if (payload.thumbnail) {
    fields.push({ name: "thumbnail", type: "file", filename: payload.thumbnail.filename, contentType: payload.thumbnail.contentType, body: payload.thumbnail.body });
  }
  if (payload.extraTextFields) {
    for (const [k, v] of Object.entries(payload.extraTextFields)) fields.push({ name: k, type: "text", value: v as any });
  }
  type TgMedia = { message_id: number; video?: { file_id: string; file_unique_id?: string; width?: number; height?: number; duration?: number }; photo?: Array<{ file_id: string; file_unique_id?: string; width?: number; height?: number }> };
  const r = await callBotApiMultipart<TgMedia>(bot, payload.tgMethod, fields);
  if (!r.ok || !r.result) {
    return {
      stub: false,
      success: false,
      chatFingerprint: fingerprint,
      chatMasked: masked,
      waitedMs,
      errorCode: r.error_code ?? 500,
      errorNote: `len=${(r.description || "").length}`,
    };
  }
  const mid = r.result.message_id;
  if (payload.tgMethod === "sendVideo" && r.result.video) {
    return {
      stub: false,
      success: true,
      messageId: mid,
      telegramFileId: r.result.video.file_id,
      telegramFileUniqueId: r.result.video.file_unique_id,
      width: r.result.video.width,
      height: r.result.video.height,
      durationSeconds: r.result.video.duration,
      chatFingerprint: fingerprint,
      chatMasked: masked,
      waitedMs,
    };
  }
  if (payload.tgMethod === "sendPhoto" && Array.isArray(r.result.photo) && r.result.photo.length > 0) {
    const thumb = r.result.photo[r.result.photo.length - 1];
    return {
      stub: false,
      success: true,
      messageId: mid,
      telegramFileId: thumb.file_id,
      telegramFileUniqueId: thumb.file_unique_id,
      width: thumb.width,
      height: thumb.height,
      chatFingerprint: fingerprint,
      chatMasked: masked,
      waitedMs,
    };
  }
  return {
    stub: false,
    success: true,
    messageId: mid,
    chatFingerprint: fingerprint,
    chatMasked: masked,
    waitedMs,
  };
}

export type GetUpdatesOptions = { limit?: number; offset?: number; allowedUpdates?: readonly string[]; timeoutSeconds?: number };

export type TelegramUpdateLite = {
  updateId: number;
  date?: number;
  chatId?: string;
  chatType?: string;
  chatTitle?: string;
  event: string; // "channel_post" | "my_chat_member" | "message" | "other"
};

export async function getUpdatesLite(opts: GetUpdatesOptions = {}): Promise<TelegramUpdateLite[]> {
  // 【Phase 0-3 红线】非显式开发模式一律禁用，避免与 webhook 互斥
  const allow = process.env.TELEGRAM_DEV_USE_GETUPDATES === "true" && process.env.NODE_ENV !== "production";
  if (!allow) {
    throw new Error(
      "[bot:getUpdates] REFUSED: getUpdates is DISABLED outside NODE_ENV!==production + TELEGRAM_DEV_USE_GETUPDATES=true. " +
        "Production MUST use /api/telegram/webhook (Phase 0-3 webhook-only mode; getUpdates and webhook are mutually exclusive — Phase 0-5).",
    );
  }
  const bot = assertInviteBot("getUpdates");
  const payload: Record<string, unknown> = {
    limit: opts.limit ?? 100,
    offset: opts.offset ?? -1000,
    timeout: opts.timeoutSeconds ?? 0,
  };
  if (opts.allowedUpdates && opts.allowedUpdates.length > 0) {
    payload.allowed_updates = opts.allowedUpdates;
  }
  const r = await callBotApi<any[]>(bot, "getUpdates", payload);
  if (!r.ok || !Array.isArray(r.result)) throw new Error(`getUpdates failed: [${r.error_code}] ${r.description || "unknown"}`);
  const out: TelegramUpdateLite[] = [];
  for (const u of r.result) {
    const base: TelegramUpdateLite = { updateId: Number(u.update_id), event: "other" };
    if (u.channel_post) {
      base.chatId = String(u.channel_post.chat.id);
      base.chatType = u.channel_post.chat.type;
      base.chatTitle = u.channel_post.chat.title;
      base.date = Number(u.channel_post.date ?? 0);
      base.event = "channel_post";
    } else if (u.my_chat_member?.chat) {
      base.chatId = String(u.my_chat_member.chat.id);
      base.chatType = u.my_chat_member.chat.type;
      base.chatTitle = u.my_chat_member.chat.title;
      base.date = Number(u.my_chat_member.date ?? 0);
      base.event = "my_chat_member";
    } else if (u.message?.chat) {
      base.chatId = String(u.message.chat.id);
      base.chatType = u.message.chat.type;
      base.chatTitle = u.message.chat.title || u.message.chat.username || u.message.from?.username || null;
      base.date = Number(u.message.date ?? 0);
      base.event = "message";
    }
    out.push(base);
  }
  return out;
}

export function consumeUpdatesOffset(botKey: string, updates: TelegramUpdateLite[]): number | null {
  if (!updates.length) return null;
  return updates.reduce((m, u) => Math.max(m, u.updateId), -Infinity) + 1;
}

// ============================================================
// 【Phase 0-6】setWebhook / 我方 secret_token / botSlot 固定路由映射
// ============================================================

/**
 * botSlot → 实际 Bot 凭证 key 的服务端映射。
 * 客户端永不传入；路由固定前缀使用非敏感标识（invite_bot / support_bot）。
 * 禁止把 slot 直接等于 Bot Token。
 */
const BOT_SLOT_MAP: Readonly<Record<string, () => TelegramBotCredential | undefined>> = {
  invite_bot: () => getInviteBot(), // 生产唯一主 Bot；后续 support_bot 按需扩展
  default: () => getInviteBot(),    // 单 Bot 场景固定路由的默认槽位
};

export const TELEGRAM_WEBHOOK_CONFIG = {
  /**
   * 固定路由（推荐单 Bot 场景）：POST /api/telegram/webhook
   * 多 Bot 场景额外支持：POST /api/telegram/webhook/:botSlot
   *   botSlot ∈ { invite_bot }，后续 support_bot 在此处扩展。
   */
  fixedPath: "/api/telegram/webhook",
  defaultBotSlot: "default",
} as const;

export type TelegramBotSlot = keyof typeof BOT_SLOT_MAP;

export function resolveBotSlot(slot: string | undefined): TelegramBotCredential | undefined {
  const key: string = slot && slot in BOT_SLOT_MAP ? slot : TELEGRAM_WEBHOOK_CONFIG.defaultBotSlot;
  return BOT_SLOT_MAP[key]();
}

export function listSupportedBotSlots(): string[] {
  return Object.keys(BOT_SLOT_MAP);
}

/**
 * 校验 webhook 请求头中的 secret token（来自 setWebhook(secret_token=...)，我方生成）。
 * 必须与 env 的 TELEGRAM_WEBHOOK_SECRET 恒时比较相等。
 */
export function validateWebhookSecretToken(headerValue: string | undefined | string[]): { ok: boolean; reason?: string } {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || expected.length < 16) {
    return { ok: false, reason: "TELEGRAM_WEBHOOK_SECRET_missing_or_weak" };
  }
  const given = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!given) return { ok: false, reason: "missing_header" };
  const expectedFp = chatIdIndexKey("whsec:" + expected).slice(0, 32);
  const givenFp = chatIdIndexKey("whsec:" + given).slice(0, 32);
  // 恒时比较防时序
  const eq = constantTimeEqual(expected, given);
  if (!eq) return { ok: false, reason: `mismatch_fp_${givenFp}_expected_${expectedFp}` };
  return { ok: true };
}

export type SetWebhookParams = {
  url: string;
  dropPendingUpdates?: boolean;
  maxConnections?: number;
  allowedUpdates?: readonly string[];
  /**
   * 如果传 secretToken，覆盖 env.TELEGRAM_WEBHOOK_SECRET。生产请显式使用 env。
   */
  secretToken?: string;
  botSlot?: TelegramBotSlot;
};

export type WebhookStatusResult = {
  ok: boolean;
  url: string | null;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
  lastErrorDate?: number;
  lastErrorMessage?: string;
  lastSynchronizationErrorDate?: number;
  maxConnections?: number;
  allowedUpdates?: string[];
};

/**
 * 我方主动注册/更新 webhook：
 *   - secret_token 取 env.TELEGRAM_WEBHOOK_SECRET 或显式入参
 *   - 返回 setWebhook 结果（布尔）
 * 发布 Gate 脚本会显式调用此函数，确保 webhook 已绑定。
 */
export async function setOrUpdateWebhook(params: SetWebhookParams): Promise<{ ok: boolean; reason?: string }> {
  const bot = resolveBotSlot(params.botSlot);
  if (!hasRealToken(bot)) return { ok: false, reason: "bot_credential_missing_or_placeholder" };
  const secretToken = params.secretToken || process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secretToken || secretToken.length < 16) {
    return { ok: false, reason: "TELEGRAM_WEBHOOK_SECRET_missing_or_weak" };
  }
  const payload: Record<string, unknown> = {
    url: params.url,
    secret_token: secretToken,
  };
  if (params.dropPendingUpdates !== undefined) payload.drop_pending_updates = params.dropPendingUpdates;
  if (params.maxConnections !== undefined) payload.max_connections = params.maxConnections;
  if (params.allowedUpdates && params.allowedUpdates.length > 0) payload.allowed_updates = params.allowedUpdates;
  const r = await callBotApi<true>(bot!, "setWebhook", payload);
  if (!r.ok) return { ok: false, reason: `tg_${r.error_code}_${r.description || "unknown"}` };
  return { ok: true };
}

export async function deleteWebhook(opts: { dropPendingUpdates?: boolean; botSlot?: TelegramBotSlot } = {}): Promise<{ ok: boolean; reason?: string }> {
  const bot = resolveBotSlot(opts.botSlot);
  if (!hasRealToken(bot)) return { ok: false, reason: "bot_credential_missing_or_placeholder" };
  const r = await callBotApi<true>(bot!, "deleteWebhook", {
    ...(opts.dropPendingUpdates !== undefined ? { drop_pending_updates: opts.dropPendingUpdates } : {}),
  });
  if (!r.ok) return { ok: false, reason: `tg_${r.error_code}_${r.description || "unknown"}` };
  return { ok: true };
}

/**
 * 发布 Gate 脚本 / readiness 探测会调。返回当前 webhook 配置的 URL（不含 secret）。
 * 绝不把 secret_token 回写到任何响应或日志。
 */
export async function getWebhookStatus(opts: { botSlot?: TelegramBotSlot } = {}): Promise<{ ok: boolean; status?: WebhookStatusResult; reason?: string }> {
  const bot = resolveBotSlot(opts.botSlot);
  if (!hasRealToken(bot)) return { ok: false, reason: "bot_credential_missing_or_placeholder" };
  const r = await callBotApi<any>(bot!, "getWebhookInfo", {});
  if (!r.ok || !r.result) return { ok: false, reason: `tg_${r.error_code}_${r.description || "unknown"}` };
  const x = r.result;
  return {
    ok: true,
    status: {
      ok: true,
      url: typeof x.url === "string" ? x.url : null,
      hasCustomCertificate: Boolean(x.has_custom_certificate),
      pendingUpdateCount: Number(x.pending_update_count ?? 0),
      lastErrorDate: x.last_error_date == null ? undefined : Number(x.last_error_date),
      lastErrorMessage: typeof x.last_error_message === "string" ? x.last_error_message : undefined,
      lastSynchronizationErrorDate: x.last_synchronization_error_date == null ? undefined : Number(x.last_synchronization_error_date),
      maxConnections: x.max_connections == null ? undefined : Number(x.max_connections),
      allowedUpdates: Array.isArray(x.allowed_updates) ? x.allowed_updates.map(String) : undefined,
    },
  };
}

// ============================================================
// 【Sprint 3 V2 - P0】Telegram Stars 数字内容支付
// Docs: https://core.telegram.org/bots/payments-stars
// ============================================================

export type LabeledPrice = { label: string; amount: number /* XTR 最小单位整数 */ };

export type CreateStarsInvoiceOptions = {
  title: string;
  description: string;
  payload: string; // 不可猜测；建议 hmac:64hex
  currency?: "XTR";
  prices: LabeledPrice[]; // 总和等于订单 amountMinor
  photoUrl?: string;
  photoSize?: number;
  photoWidth?: number;
  photoHeight?: number;
  /** Mini App 场景：返回 invoice 链接供前端跳转 */
  miniAppInfo?: { url?: string };
  /** Bot DM 场景：直接发送到用户 Telegram */
  sendToTelegramUserId?: bigint | number | string;
  maxTipAmount?: number;
  suggestedTipAmounts?: number[];
  needName?: boolean;
  needPhoneNumber?: boolean;
  needEmail?: boolean;
  sendPhoneNumberToProvider?: boolean;
  sendEmailToProvider?: boolean;
  flexible?: boolean;
  botSlot?: TelegramBotSlot;
};

export type CreateStarsInvoiceResult =
  | { ok: true; invoiceLink: string; via: "createInvoiceLink" }
  | { ok: false; errorClass: string; reason: string };

export async function createStarsInvoice(opts: CreateStarsInvoiceOptions): Promise<CreateStarsInvoiceResult> {
  const bot = resolveBotSlot(opts.botSlot);
  if (!hasRealToken(bot)) return { ok: false, errorClass: "bot_credential_missing", reason: "no valid bot token for stars invoice" };
  if (!opts.payload || opts.payload.length < 16) {
    return { ok: false, errorClass: "payload_weak", reason: "payload must be >= 16 chars (use hmac:64hex)" };
  }
  if (!Array.isArray(opts.prices) || opts.prices.length === 0) {
    return { ok: false, errorClass: "prices_empty", reason: "prices[] required" };
  }
  // 防止 429：与其他批量调用共用 350ms 间隔
  await new Promise((res) => setTimeout(res, 350));
  try {
    // ============ P0-#1-C FIX：强制 createInvoiceLink，禁止 sendInvoice 返回占位 tg:invoice ============
    // Mini App / H5 只接受 https://t.me/ 真实发票链接。
    // 若提供了 sendToTelegramUserId，则在后台「额外私信一张发票」作为提醒，但失败不应影响主流程。
    const basePayload: Record<string, unknown> = {
      title: opts.title,
      description: opts.description,
      payload: opts.payload,
      provider_token: "",
      currency: opts.currency || "XTR",
      prices: opts.prices,
    };
    if (opts.photoUrl) basePayload.photo_url = opts.photoUrl;
    if (opts.photoSize) basePayload.photo_size = opts.photoSize;
    if (opts.photoWidth) basePayload.photo_width = opts.photoWidth;
    if (opts.photoHeight) basePayload.photo_height = opts.photoHeight;
    if (opts.maxTipAmount != null) basePayload.max_tip_amount = opts.maxTipAmount;
    if (opts.suggestedTipAmounts?.length) basePayload.suggested_tip_amounts = opts.suggestedTipAmounts;
    if (opts.needName) basePayload.need_name = true;
    if (opts.needPhoneNumber) basePayload.need_phone_number = true;
    if (opts.needEmail) basePayload.need_email = true;
    if (opts.sendPhoneNumberToProvider) basePayload.send_phone_number_to_provider = true;
    if (opts.sendEmailToProvider) basePayload.send_email_to_provider = true;
    if (opts.flexible) basePayload.is_flexible = true;

    // 1) 可选：额外私信 sendInvoice 给用户（Fail-Open，不影响主链接返回）
    if (opts.sendToTelegramUserId != null) {
      try {
        const dmPayload: Record<string, unknown> = { ...basePayload, chat_id: channelIdString(opts.sendToTelegramUserId) };
        await callBotApi<{ ok?: boolean }>(bot!, "sendInvoice", dmPayload);
      } catch (_dmErr: any) {
        // 私信失败绝不影响主流程；仅 stderr 结构化（不暴露 bot 返回）
        try {
          const { emitSafetyEvent } = await import("../utils/structuredError.js" as any);
          emitSafetyEvent({
            event: "stars_invoice_dm_fallback_failed",
            errorClass: "business",
            note: `payloadHd=${opts.payload.slice(0, 16)}`,
          }, _dmErr);
        } catch (_importErr) {
          // 模块不可用则静默 swallow，仅保证不抛
        }
      }
    }

    // 2) 真正用于支付的链接：必须走 createInvoiceLink
    const r = await callBotApi<string>(bot!, "createInvoiceLink", basePayload);
    if (!r.ok || typeof r.result !== "string") {
      return { ok: false, errorClass: `tg_${r.error_code || 500}`, reason: r.description || "createInvoiceLink failed" };
    }
    const invoiceLink = r.result;
    // P0-#1-C 强校验：必须是 Telegram 官方 https://t.me/$ 开头的真实链接，否则直接视为服务异常
    if (typeof invoiceLink !== "string" || !invoiceLink.startsWith("https://t.me/")) {
      return { ok: false, errorClass: "stars_invoice_link_malformed", reason: `createInvoiceLink returned non https://t.me/ link (len=${invoiceLink?.length || 0})` };
    }
    return { ok: true, invoiceLink, via: "createInvoiceLink" };
  } catch (e: any) {
    return { ok: false, errorClass: "stars_invoice_exception", reason: e?.message || String(e) };
  }
}

export type PreCheckoutAnswerOptions = {
  preCheckoutQueryId: string;
  ok: boolean;
  /** ok=false 时必传，≤128 chars */
  errorMessage?: string;
  botSlot?: TelegramBotSlot;
};

export type PreCheckoutAnswerResult = { ok: boolean; errorClass?: string; reason?: string };

export async function answerPreCheckoutQuery(opts: PreCheckoutAnswerOptions): Promise<PreCheckoutAnswerResult> {
  const bot = resolveBotSlot(opts.botSlot);
  if (!hasRealToken(bot)) return { ok: false, errorClass: "bot_credential_missing", reason: "no valid bot token" };
  if (!opts.preCheckoutQueryId) return { ok: false, errorClass: "missing_id", reason: "preCheckoutQueryId required" };
  if (!opts.ok && (!opts.errorMessage || opts.errorMessage.length === 0 || opts.errorMessage.length > 128)) {
    return { ok: false, errorClass: "bad_error_message", reason: "ok=false requires error_message 1-128 chars" };
  }
  await new Promise((res) => setTimeout(res, 350));
  try {
    const payload: Record<string, unknown> = { pre_checkout_query_id: opts.preCheckoutQueryId, ok: opts.ok };
    if (!opts.ok) payload.error_message = opts.errorMessage;
    const r = await callBotApi<true>(bot!, "answerPreCheckoutQuery", payload);
    if (!r.ok) return { ok: false, errorClass: `tg_${r.error_code || 500}`, reason: r.description || "answerPreCheckoutQuery failed" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, errorClass: "stars_precheckout_exception", reason: e?.message || String(e) };
  }
}

export type RefundStarsPaymentOptions = {
  /** telegram_payment_charge_id（successful_payment 里的值），唯一索引 */
  telegramPaymentChargeId: string;
  /** 用户 ID，用于恒时匹配可选，不强制；但需填审计 */
  forUserIdPlain?: bigint | number | string;
  botSlot?: TelegramBotSlot;
};

export type RefundStarsPaymentResult = { ok: boolean; errorClass?: string; reason?: string };

/**
 * 调用 refundStarPayment 退 Stars。
 * 【调用方职责】：必须在 finance 角色审计通过后调用；调用方需把"已退"状态写入 orders + payment_transactions 事务里。
 *  此函数仅负责 Telegram API 调用，本身不写库。
 */
export async function refundStarsPayment(opts: RefundStarsPaymentOptions): Promise<RefundStarsPaymentResult> {
  const bot = resolveBotSlot(opts.botSlot);
  if (!hasRealToken(bot)) return { ok: false, errorClass: "bot_credential_missing", reason: "no valid bot token" };
  if (!opts.telegramPaymentChargeId || opts.telegramPaymentChargeId.length < 4) {
    return { ok: false, errorClass: "bad_charge_id", reason: "telegramPaymentChargeId required" };
  }
  await new Promise((res) => setTimeout(res, 350));
  try {
    const payload: Record<string, unknown> = {
      user_id: opts.forUserIdPlain ? Number(channelIdString(opts.forUserIdPlain)) : undefined,
      telegram_payment_charge_id: opts.telegramPaymentChargeId,
    };
    const r = await callBotApi<true>(bot!, "refundStarPayment", payload);
    if (!r.ok) return { ok: false, errorClass: `tg_${r.error_code || 500}`, reason: r.description || "refundStarPayment failed" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, errorClass: "stars_refund_exception", reason: e?.message || String(e) };
  }
}
