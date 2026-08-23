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

type Target = { channel: ChannelRef };

const miniAppUrl = process.env.PUBLIC_MINI_APP_URL || "https://bdsm.linkx.club/";
const shouldPublish = process.argv.includes("--confirm");

function configuredTargets(): Target[] {
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
  const freeTargets = declaredFreeTargets.length > 0 ? declaredFreeTargets : multiValueTargets;
  const membershipRaw = process.env.TELEGRAM_CHANNEL_MEMBERSHIP ?? process.env.MEMBERSHIP_CHANNEL_ID;
  if (!membershipRaw || !/^-?\d{6,22}$/.test(membershipRaw)) {
    throw new Error("membership_channel_not_configured");
  }
  return [...freeTargets, { channel: refMembershipMain() }];
}

const text = [
  "同频 · 精选点播",
  "打开 Mini App 浏览内容、查看订单与权益：",
  miniAppUrl,
].join("\n");

async function main() {
  const targets = configuredTargets();
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
