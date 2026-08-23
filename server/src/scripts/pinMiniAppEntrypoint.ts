/**
 * Publish and pin the official Mini App entry point in every configured free
 * channel plus the membership main channel. Default mode is read-only.
 * Pass --confirm only after the Bot has post + pin permissions everywhere.
 */
import {
  getBotChatMember,
  pinChannelMessage,
  refMembershipMain,
  refRawChatId,
  sendChannelText,
  type ChannelRef,
} from "../services/telegramBot.js";
import { PUBLIC_FREE_CHANNELS, refFreeChannelByCode } from "../services/freeChannels.js";
import { PrismaClient } from "@prisma/client";
import { decryptChatIdAesGcm } from "../utils/crypto.js";

type Target = { channel: ChannelRef };

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

  if (directFreeTargets.length > 0 && directMembershipTarget) {
    return [...directFreeTargets, directMembershipTarget];
  }

  // Fallback for the managed-channel deployment model: channel IDs stay
  // encrypted in the registry and are resolved only inside this server script.
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
    const freeTargets = directFreeTargets.length > 0 ? directFreeTargets : managedFree;
    const membershipTarget = directMembershipTarget ?? managedMembership;
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
  const targets = await configuredTargets();
  if (targets.length < 2) throw new Error("no_free_channel_configured");

  const members = await Promise.all(targets.map((target) => getBotChatMember(target.channel)));
  const ready = members.every((member) => member.isAdministrator && member.canPostMessages && member.canPinMessages);
  if (!ready) {
    console.log(JSON.stringify({ ok: false, action: "preflight", targets: targets.length, reason: "missing_bot_pin_or_post_permission" }));
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

main().catch(() => {
  console.log(JSON.stringify({ ok: false, action: "preflight", reason: "operation_failed" }));
  process.exitCode = 1;
});
