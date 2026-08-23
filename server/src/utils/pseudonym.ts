import { randomInt } from "node:crypto";

/**
 * 平台匿名昵称库：40 × 40 = 1,600 个原创、非贬损的组合。
 * 这不是外部用户昵称采集库；昵称只在账户第一次创建时分配并持久化。
 */
const PREFIXES = [
  "月光", "微光", "夜航", "静默", "低语", "星雾", "远岸", "余温",
  "暗潮", "晨雾", "暮色", "云影", "霜影", "风铃", "海盐", "雨幕",
  "墨蓝", "银月", "深蓝", "薄雾", "白夜", "潮汐", "流云", "星河",
  "松针", "原野", "灯塔", "冬青", "夜色", "青岚", "纸鸢", "初雪",
  "旧书", "微醺", "暖灰", "慢火", "野花", "晚风", "静水", "远星",
] as const;

const SUFFIXES = [
  "边界", "默契", "回声", "约定", "余韵", "星图", "轨迹", "片刻",
  "微澜", "信笺", "坐标", "漫游", "序章", "留白", "心事", "光点",
  "弧线", "相遇", "引力", "私语", "节拍", "远方", "答案", "注脚",
  "页码", "余光", "此刻", "回廊", "风景", "分寸", "心跳", "花火",
  "潮声", "轻舟", "愿望", "一隅", "晴空", "暗号", "同行", "原点",
] as const;

export const PLATFORM_PSEUDONYM_COUNT = PREFIXES.length * SUFFIXES.length;

export function platformPseudonymAt(index: number): string {
  const normalized = ((Math.trunc(index) % PLATFORM_PSEUDONYM_COUNT) + PLATFORM_PSEUDONYM_COUNT) % PLATFORM_PSEUDONYM_COUNT;
  const prefix = PREFIXES[Math.floor(normalized / SUFFIXES.length)];
  const suffix = SUFFIXES[normalized % SUFFIXES.length];
  return `${prefix}${suffix}`;
}

export function randomPlatformPseudonym(): string {
  return platformPseudonymAt(randomInt(PLATFORM_PSEUDONYM_COUNT));
}

/** 只迁移旧的技术型占位名，不覆盖用户已经存在的正常昵称。 */
export function isLegacyPlatformDisplayName(value: string | null | undefined): boolean {
  if (!value) return true;
  return value === "同频账户" ||
    value === "访客用户" ||
    value === "本机账户" ||
    /^同频用户\s+[A-F0-9]{6}$/i.test(value) ||
    /^Telegram 用户\s+\d+$/.test(value);
}
