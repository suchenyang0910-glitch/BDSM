import { PrismaClient } from "@prisma/client";

import { resolveMembershipChannelRef } from "../services/membershipChannel.js";
import { resolvePackageChannelId } from "../services/channelCrypto.js";
import { getBotChatMember, refRawChatId } from "../services/telegramBot.js";
import { hasFlagInArgv, loadScriptEnvFiles, readArgFromArgv } from "../utils/scriptEnv.js";

type OutputRow = {
  name: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
};

async function checkMembership(prisma: PrismaClient): Promise<OutputRow> {
  try {
    const channel = await resolveMembershipChannelRef(prisma);
    const member = await getBotChatMember(channel);
    return { name: "membership_main", ok: true, detail: member };
  } catch (error) {
    return { name: "membership_main", ok: false, error: String((error as Error)?.message || error) };
  }
}

async function checkPackages(prisma: PrismaClient): Promise<OutputRow[]> {
  const packages = await prisma.contentPackage.findMany({
    where: {
      OR: [
        { channelId: { not: null } },
        { channelIdCiphertext: { not: null } },
      ],
    },
    select: {
      id: true,
      title: true,
      status: true,
      channelId: true,
      channelIdCiphertext: true,
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 20,
  });
  const rows: OutputRow[] = [];
  for (const pkg of packages) {
    try {
      const channelId = resolvePackageChannelId({
        channelId: pkg.channelId,
        channelIdCiphertext: pkg.channelIdCiphertext,
      });
      if (channelId == null) {
        rows.push({
          name: `package:${pkg.id}`,
          ok: false,
          error: "package_channel_not_configured",
        });
        continue;
      }
      const member = await getBotChatMember(refRawChatId(channelId));
      rows.push({
        name: `package:${pkg.id}`,
        ok: true,
        detail: { title: pkg.title, status: pkg.status, member },
      });
    } catch (error) {
      rows.push({
        name: `package:${pkg.id}`,
        ok: false,
        error: String((error as Error)?.message || error),
      });
    }
  }
  return rows;
}

async function main() {
  const useTestDb = hasFlagInArgv(process.argv, "--use-test-db");
  loadScriptEnvFiles({
    explicitEnvFile: readArgFromArgv(process.argv, "--env-file"),
    preferTestEnv: useTestDb,
  });
  const dbUrl = useTestDb
    ? (process.env.DATABASE_URL_TEST || process.env.DATABASE_URL)
    : (process.env.DATABASE_URL || process.env.DATABASE_URL_TEST);
  if (!dbUrl) {
    console.log(JSON.stringify({ ok: false, error: "DATABASE_URL_TEST_or_DATABASE_URL_missing" }));
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    await prisma.$connect();
    const membership = await checkMembership(prisma);
    const packages = await checkPackages(prisma);
    const ok = membership.ok && packages.every((row) => row.ok);
    console.log(JSON.stringify({ ok, databaseMode: useTestDb ? "test" : "primary", membership, packages }, null, 2));
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      databaseMode: useTestDb ? "test" : "primary",
      error: String((error as Error)?.message || error),
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
