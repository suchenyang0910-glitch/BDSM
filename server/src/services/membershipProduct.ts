/**
 * Resolves the default monthly membership product for VOD Phase 1.
 *
 * We deliberately return null when configuration is ambiguous instead of
 * silently choosing a price for a user.
 */
export async function resolveDefaultMonthlyMembershipProduct(prisma: any) {
  const rows = await prisma.product.findMany({
    where: { type: "membership", status: "active", durationDays: 30 },
    orderBy: { createdAt: "asc" },
    take: 2,
    select: {
      id: true,
      priceMinor: true,
      currency: true,
      usdtPriceMinor: true,
      type: true,
      durationDays: true,
    },
  });
  return rows.length === 1 ? rows[0] : null;
}
