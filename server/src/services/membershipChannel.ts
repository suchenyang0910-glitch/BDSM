/**
 * Canonical membership delivery resolver.
 *
 * The encrypted admin-managed channel binding is authoritative when present.
 * Legacy environment variables remain a fail-closed fallback so upgrades do
 * not interrupt existing installations.
 */
import { decryptChatIdAesGcm } from "../utils/crypto.js";
import { refMembershipMain, refRawChatId, type ChannelRef } from "./telegramBot.js";

export async function resolveMembershipChannelRef(prisma: any): Promise<ChannelRef> {
  const row = await prisma.adminManagedChannel.findFirst({
    where: { purpose: "membership_main" },
    select: { deprecatedChatIdBig: true, chatIdCiphertextB64: true },
    orderBy: [{ updatedAt: "desc" }],
  });
  let chatId: bigint | null = null;
  if (row?.chatIdCiphertextB64) {
    try { chatId = decryptChatIdAesGcm(row.chatIdCiphertextB64); } catch { chatId = null; }
  }
  if (chatId == null && typeof row?.deprecatedChatIdBig === "bigint") chatId = row.deprecatedChatIdBig;
  return chatId != null ? refRawChatId(chatId) : refMembershipMain();
}
