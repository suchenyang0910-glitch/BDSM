import { PrismaClient } from "@prisma/client";
import { computePaymentAddressIntegrityMac } from "../services/paymentAddressIntegrity.js";

/**
 * One-time deployment operation for address records that predate integrity_mac.
 * It deliberately requires an explicit operator acknowledgement, only updates
 * rows without a MAC, and never prints an address or any secret.
 */
async function main(): Promise<void> {
  if (process.env.PAYMENT_ADDRESS_INTEGRITY_BASELINE_APPROVED !== "YES") {
    throw new Error("baseline_not_approved");
  }
  if (process.env.NODE_ENV !== "production") {
    throw new Error("baseline_requires_production_environment");
  }

  const prisma = new PrismaClient();
  try {
    const legacyRows = await prisma.paymentAddress.findMany({
      where: { integrityMac: null },
      select: {
        id: true,
        network: true,
        address: true,
        createdAt: true,
        createdBy: true,
        lifecycleVersion: true,
      },
    });

    let signed = 0;
    for (const row of legacyRows) {
      const integrityMac = computePaymentAddressIntegrityMac(row);
      if (!integrityMac) throw new Error("payment_address_integrity_key_missing");
      const result = await prisma.paymentAddress.updateMany({
        where: { id: row.id, integrityMac: null },
        data: { integrityMac, lastIntegrityCheckAt: new Date() },
      });
      signed += result.count;
    }
    console.log(`[security] payment_address_integrity_baseline completed signed=${signed} alreadySigned=${legacyRows.length - signed}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const code = error instanceof Error ? error.message.replace(/[^a-z0-9_]/gi, "_").slice(0, 80) : "unknown";
  console.error(`[security] payment_address_integrity_baseline failed code=${code}`);
  process.exit(1);
});
