// ============================================================
// freeChannels：S1 公开免费频道白名单枚举
//
// Security:
//   - 路由层绝不允许运营自填 channelId；所有 public 类型内容必须从白名单 code 选
//   - 明文 chatId 仅在 resolveFreeChannelRefToChatId() 解析，绝不返回给 UI/日志/审计
//   - 缺 env 直接 Fail-Closed（抛错，发布/访问皆失败）
//   - 每个 code 绑定 env 变量名，建议格式 TELEGRAM_FREE_CHANNEL_{CODE}_CHAT_ID
// ============================================================

import { refRawChatId, type ChannelRef, maskChatIdSafe } from "./telegramBot.js";

export type FreeChannelCode =
  | "free_preview_main"
  | "free_tutorial_basics"
  | "free_announcements";

export type FreeChannelEntry = {
  code: FreeChannelCode;
  label: string;
  description: string;
  /** 必须是 env 变量名，格式建议 TELEGRAM_FREE_CHANNEL_*_CHAT_ID */
  envVarName: string;
  /** 可选，给用户看的公开 t.me 链接入口（如果频道是公开的） */
  publicUrlEnvVarName?: string;
};

export const PUBLIC_FREE_CHANNELS: readonly FreeChannelEntry[] = [
  {
    code: "free_preview_main",
    label: "主预览免费频道",
    description: "默认公开预览流：15s 预告片 / 免费花絮",
    envVarName: "TELEGRAM_FREE_CHANNEL_PREVIEW_MAIN_CHAT_ID",
    publicUrlEnvVarName: "TELEGRAM_FREE_CHANNEL_PREVIEW_MAIN_URL",
  },
  {
    code: "free_tutorial_basics",
    label: "新手入门教程（免费）",
    description: "新手教育内容包，零门槛无需会员",
    envVarName: "TELEGRAM_FREE_CHANNEL_TUTORIAL_BASICS_CHAT_ID",
    publicUrlEnvVarName: "TELEGRAM_FREE_CHANNEL_TUTORIAL_BASICS_URL",
  },
  {
    code: "free_announcements",
    label: "公告与活动频道（免费）",
    description: "官方活动/新品公告/优惠券发放",
    envVarName: "TELEGRAM_FREE_CHANNEL_ANNOUNCEMENTS_CHAT_ID",
    publicUrlEnvVarName: "TELEGRAM_FREE_CHANNEL_ANNOUNCEMENTS_URL",
  },
] as const;

export function isValidFreeChannelCode(code: unknown): code is FreeChannelCode {
  return (
    typeof code === "string" &&
    PUBLIC_FREE_CHANNELS.some((c) => c.code === code)
  );
}

export function getFreeChannelEntry(code: string): FreeChannelEntry | null {
  return PUBLIC_FREE_CHANNELS.find((c) => c.code === code) || null;
}

export function listPublicFreeChannelOptions(): Array<{
  code: FreeChannelCode;
  label: string;
  description: string;
}> {
  return PUBLIC_FREE_CHANNELS.map(({ code, label, description }) => ({
    code,
    label,
    description,
  }));
}

/**
 * 实际启用的免费流量分发池。
 * 仅返回服务端已配置合法 chatId 的频道，供发布扇出和后台展示使用；
 * 不向前端泄露 chatId，也不会把“预设但未配置”的频道当成运营选项。
 */
export function listConfiguredPublicFreeChannelOptions(): Array<{
  code: FreeChannelCode;
  label: string;
  description: string;
}> {
  return PUBLIC_FREE_CHANNELS.filter((entry) => {
    try {
      resolveFreeChannelCodeToChatId(entry.code);
      return true;
    } catch {
      return false;
    }
  }).map(({ code, label, description }) => ({ code, label, description }));
}

/** 解析免费频道 code → 明文 chatId。缺 env 直接 Fail-Closed。 */
export function resolveFreeChannelCodeToChatId(
  code: string,
): bigint {
  const entry = getFreeChannelEntry(code);
  if (!entry) {
    throw new Error(
      `[freeChannels:${String(code)}] 不在白名单内：只允许 ${PUBLIC_FREE_CHANNELS.map((c) => c.code).join(" / ")}。`,
    );
  }
  const raw = process.env[entry.envVarName];
  if (!raw || !/^-?\d{6,22}$/.test(String(raw))) {
    throw new Error(
      `[freeChannels:${code}] env ${entry.envVarName} 未配置或格式错误（必须是纯数字 Telegram chat.id，私密频道通常以 -100 开头）。` +
        ` 请在 staging / 生产 server/.env 写入；该值禁止入库或写入 Git。`,
    );
  }
  try {
    return BigInt(raw);
  } catch {
    throw new Error(
      `[freeChannels:${code}] ${entry.envVarName} 格式非法：不是合法的 BigInt。`,
    );
  }
}

/** 将免费频道 code → ChannelRef（供 telegramBot.ts createChannelInvite / sendVideo 等使用） */
export function refFreeChannelByCode(code: string): ChannelRef {
  return refRawChatId(resolveFreeChannelCodeToChatId(code));
}

export function maskFreeChannelSafe(code: string): string {
  try {
    return maskChatIdSafe(resolveFreeChannelCodeToChatId(code));
  } catch {
    return "unconfigured";
  }
}

/** 给资源页 public 分支用：code 对应的公开 t.me 链接（若 env 配了的话），无则返回 null。Fail-Closed 不抛。 */
export function tryGetFreeChannelPublicUrl(code: string): string | null {
  const entry = getFreeChannelEntry(code);
  if (!entry || !entry.publicUrlEnvVarName) return null;
  const v = process.env[entry.publicUrlEnvVarName];
  if (!v || !/^https?:\/\/t\.me\/\S+$/.test(v)) return null;
  return v;
}
