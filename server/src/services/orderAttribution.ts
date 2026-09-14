export const ORDER_ATTRIBUTION_RULE_VERSION = "last_non_direct_v1";
export const ORDER_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionOrderAttribution = {
  version: 1;
  trafficEntryId: string;
  trafficEntryCode: string;
  trafficEntryType: string;
  destinationType: string;
  destinationId: string;
  capturedAt: string;
};

export type OrderAttributionInput = {
  sessionAttribution: unknown;
  clientType: "web" | "telegram_mini_app";
  identityType: "h5_session" | "telegram_session";
};

function readSessionAttribution(input: unknown, now: Date): SessionOrderAttribution | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<SessionOrderAttribution>;
  const capturedAt = typeof value.capturedAt === "string" ? new Date(value.capturedAt) : null;
  if (
    value.version !== 1 ||
    !capturedAt ||
    !Number.isFinite(capturedAt.getTime()) ||
    capturedAt.getTime() > now.getTime() ||
    now.getTime() - capturedAt.getTime() > ORDER_ATTRIBUTION_WINDOW_MS ||
    typeof value.trafficEntryId !== "string" ||
    typeof value.trafficEntryCode !== "string" ||
    typeof value.trafficEntryType !== "string" ||
    typeof value.destinationType !== "string" ||
    typeof value.destinationId !== "string"
  ) return null;
  return value as SessionOrderAttribution;
}

/**
 * Writes exactly one immutable attribution record with the order.  The input
 * comes only from the server session populated by the verified traffic-entry
 * resolver; request bodies and client analytics are intentionally ignored.
 */
export async function captureOrderAttribution(
  tx: any,
  orderId: string,
  input: OrderAttributionInput,
  now = new Date(),
): Promise<void> {
  const source = readSessionAttribution(input.sessionAttribution, now);
  const base = {
    orderId,
    clientType: input.clientType,
    identityType: input.identityType,
    ruleVersion: ORDER_ATTRIBUTION_RULE_VERSION,
    capturedAt: now,
  };

  if (!source) {
    await tx.orderAttribution.create({ data: { ...base, status: "unknown" } });
    return;
  }

  // Keep the values observed at the verified entry-resolution time.  A later
  // entry edit/deactivation must not rewrite an already-established source.
  const entry = await tx.trafficEntry.findFirst({
    where: { id: source.trafficEntryId, code: source.trafficEntryCode },
    select: { id: true },
  });
  if (!entry) {
    await tx.orderAttribution.create({ data: { ...base, status: "unknown" } });
    return;
  }

  const activeCampaigns = await tx.operationCampaign.findMany({
    where: {
      status: "active",
      trafficEntryIds: { has: source.trafficEntryId },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    },
    select: { id: true, code: true },
    orderBy: { createdAt: "asc" },
  });
  const campaign = activeCampaigns.length === 1 ? activeCampaigns[0] : null;
  await tx.orderAttribution.create({
    data: {
      ...base,
      // A shared entry remains valid channel attribution, but must never be
      // silently attributed to one of multiple active campaigns.
      status: activeCampaigns.length > 1 ? "campaign_ambiguous" : "attributed",
      trafficEntryId: source.trafficEntryId,
      trafficEntryCode: source.trafficEntryCode,
      trafficEntryType: source.trafficEntryType,
      destinationType: source.destinationType,
      destinationId: source.destinationId,
      campaignId: campaign?.id ?? null,
      campaignCode: campaign?.code ?? null,
      sourceCapturedAt: new Date(source.capturedAt),
    },
  });
}

export function orderAttributionInputFromRequest(req: any): OrderAttributionInput {
  const session = req.session as any;
  const telegramSession = !!session?.telegramUserId;
  return {
    sessionAttribution: session?.orderAttribution ?? null,
    clientType: telegramSession ? "telegram_mini_app" : "web",
    identityType: telegramSession ? "telegram_session" : "h5_session",
  };
}
