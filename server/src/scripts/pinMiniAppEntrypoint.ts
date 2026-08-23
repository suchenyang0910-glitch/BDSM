/**
 * Publish and pin the official Mini App entry point in every configured free
 * channel plus the membership main channel. Default mode is read-only.
 * Pass --confirm only after the Bot has the matching Telegram permission in
 * every target: channels require can_edit_messages; groups require
 * can_pin_messages.
 */
import {
  getBotChatMember,
  getChat,
  pinChannelMessage,
  refMembershipMain,
  refRawChatId,
  sendChannelText,
  type ChannelRef,
} from "../services/telegramBot.js";
import { PUBLIC_FREE_CHANNELS, refFreeChannelByCode } from "../services/freeChannels.js";
import { PrismaClient } from "@prisma/client";
import { decryptChatIdAesGcm } from "../utils/crypto.js";
import { fileURLToPath } from "node:url";

type Target = { channel: ChannelRef };

export function isBotReadyToPin(chatType: string, member: {
  isAdministrator: boolean;
  canPostMessages?: boolean;
  canEditMessages?: boolean;
  canPinMessages?: boolean;
}): boolean {
  if (!member.isAdministrator) return false;
  // Telegram's channel permission model exposes pinning through
  // can_edit_messages, not can_pin_messages. The latter is for groups.
  if (chatType === "channel") return member.canPostMessages === true && member.canEditMessages === true;
  return member.canPinMessages === true;
}

const miniAppUrl = process.env.PUBLIC_MINI_APP_URL || "https://bdsm.linkx.club/";
const shouldPublish = process.argv.includes("--confirm");

async function configuredTargets(): Promise<Target[]> {
  const declaredFreeTargets = PUBLIC_FREE_CHANNELS.flatMap((entry) => {
    const raw = process.env[entry.envVarName];
    if (!raw || !/^-?\d{6,22}$/.test(raw)) return [];
    return [{ channel: refFreeChannelByCode(entry.code) }];
  });
  // Current production may use the compact multi-value config instead of the
  // named free-channel variables. It is valid only as a server-side fallback.
  const legacyRaw = String(process.env.TELEGRAM_CHANNEL_PUBLIC_IDS || "");
  const multiValueTargets = legacyRaw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^-?\d{6,22}$/.test(value))
    .map((value) => ({ channel: refRawChatId(BigInt(value)) }));
  const directFreeTargets = declaredFreeTargets.length > 0 ? declaredFreeTargets : multiValueTargets;
  const membershipRaw = process.env.TELEGRAM_CHANNEL_MEMBERSHIP ?? process.env.MEMBERSHIP_CHANNEL_ID;
  const directMembershipTarget = membershipRaw && /^-?\d{6,22}$/.test(membershipRaw)
    ? { channel: refMembershipMain() }
    : null;

  // The managed-channel registry is authoritative when present. This prevents
  // a stale legacy env value from sending a member-only post to the wrong chat.
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.adminManagedChannel.findMany({
      where: { purpose: { in: ["free_preview", "membership_main"] } },
      select: { purpose: true, deprecatedChatIdBig: true, chatIdCiphertextB64: true },
      orderBy: [{ updatedAt: "desc" }],
    });
    const managedFree: Target[] = [];
    let managedMembership: Target | null = null;
    for (const row of rows) {
      let id: bigint | null = null;
      if (row.chatIdCiphertextB64) {
        try { id = decryptChatIdAesGcm(row.chatIdCiphertextB64); } catch { id = null; }
      }
      if (id == null && typeof row.deprecatedChatIdBig === "bigint") id = row.deprecatedChatIdBig;
      if (id == null) continue;
      const target = { channel: refRawChatId(id) };
      if (row.purpose === "membership_main" && !managedMembership) managedMembership = target;
      if (row.purpose === "free_preview") managedFree.push(target);
    }
    const freeTargets = managedFree.length > 0 ? managedFree : directFreeTargets;
    const membershipTarget = managedMembership ?? directMembershipTarget;
    if (!membershipTarget) throw new Error("membership_channel_not_configured");
    return [...freeTargets, membershipTarget];
  } finally {
    await prisma.$disconnect();
  }
}

const text = [
  "同频 · 精选点播",
  "打开 Mini App 浏览内容、查看订单与权益：",
  miniAppUrl,
].join("\n");

async function main() {
  let targets: Target[];
  try {
    targets = await configuredTargets();
  } catch {
    console.log(JSON.stringify({ ok: false, action: "preflight", reason: "target_resolution_failed" }));
    process.exitCode = 1;
    return;
  }
  if (targets.length < 2) {
    console.log(JSON.stringify({ ok: false, action: "preflight", targets: targets.length, reason: "no_free_channel_configured" }));
    process.exitCode = 1;
    return;
  }

  let targetChecks;
  try {
    targetChecks = await Promise.all(targets.map(async (target) => ({
      chat: await getChat(target.channel),
      member: await getBotChatMember(target.channel),
    })));
  } catch {
    console.log(JSON.stringify({ ok: false, action: "preflight", targets: targets.length, reason: "bot_permission_check_failed" }));
    process.exitCode = 1;
    return;
  }
  const ready = targetChecks.every(({ chat, member }) => isBotReadyToPin(chat.type, member));
  if (!ready) {
    console.log(JSON.stringify({ ok: false, action: "preflight", targets: targets.length, reason: "missing_bot_publish_or_pin_permission" }));
    process.exitCode = 2;
    return;
  }
  if (!shouldPublish) {
    console.log(JSON.stringify({ ok: true, action: "dry_run", targets: targets.length, requiresConfirm: true }));
    return;
  }

  const posted: Array<{ channel: ChannelRef; messageId: number }> = [];
  for (const target of targets) {
    const sent = await sendChannelText({ channel: target.channel, text, disableWebPagePreview: false, disableNotification: true });
    if (!sent.success || !sent.messageId) {
      console.log(JSON.stringify({ ok: false, action: "publish", posted: posted.length, targets: targets.length }));
      process.exitCode = 3;
      return;
    }
    posted.push({ channel: target.channel, messageId: sent.messageId });
  }

  const pins = await Promise.all(posted.map((item) => pinChannelMessage(item)));
  if (!pins.every((pin) => pin.success)) {
    console.log(JSON.stringify({ ok: false, action: "pin", posted: posted.length, pinned: pins.filter((pin) => pin.success).length }));
    process.exitCode = 4;
    return;
  }
  console.log(JSON.stringify({ ok: true, action: "published_and_pinned", targets: targets.length }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    console.log(JSON.stringify({ ok: false, action: "preflight", reason: "unexpected_operation_failure" }));
    process.exitCode = 1;
  });
}
