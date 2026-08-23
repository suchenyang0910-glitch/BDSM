import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getTelegramBotCredentials, validateTelegramInitData } from "../utils/telegram.js";
import { isLegacyPlatformDisplayName, randomPlatformPseudonym } from "../utils/pseudonym.js";

const sessionSchema = z.object({
  initData: z.string().min(1),
  botKey: z.string().regex(/^[a-z0-9_-]{1,32}$/i).optional(),
});

export default async function telegramRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.post<{ Body: { initData: string } }>("/session", async (req, reply) => {
    const parse = sessionSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({ error: "bad_request", details: parse.error.issues });
    }
    const { initData } = parse.data;

    const activeBots = getTelegramBotCredentials().filter((bot) => bot.active);
    if (!activeBots.length) {
      return reply.status(500).send({ error: "server_config", message: "No active Telegram Bot configured" });
    }

    const candidates = parse.data.botKey
      ? [...activeBots.filter((bot) => bot.key === parse.data.botKey), ...activeBots.filter((bot) => bot.key !== parse.data.botKey)]
      : activeBots;
    const verified = candidates.map((bot) => ({ bot, result: validateTelegramInitData(initData, bot.token) })).find(({ result }) => result.ok && result.user);
    if (!verified || !verified.result.user) {
      return reply.status(401).send({ error: "invalid_signature", message: "Telegram initData verification failed" });
    }
    const user = verified.result.user;

    let dbUser = await prisma.user.findUnique({
      where: { telegramUserId: BigInt(user.id) },
      include: {
        entitlements: {
          where: { status: "active", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          select: { resourceType: true, resourceId: true, expiresAt: true },
        },
      },
    });

    if (!dbUser) {
      dbUser = await prisma.user.create({
        data: {
          telegramUserId: BigInt(user.id),
          username: user.username || null,
          displayName: randomPlatformPseudonym(),
          photoUrl: user.photo_url || null,
        },
        include: { entitlements: true },
      });
    } else if (dbUser.status !== "active") {
      return reply.status(403).send({ error: "account_restricted", message: "Account is not active" });
    } else {
      dbUser = await prisma.user.update({
        where: { id: dbUser.id },
        data: {
          username: user.username || dbUser.username,
          displayName: isLegacyPlatformDisplayName(dbUser.displayName) ? randomPlatformPseudonym() : dbUser.displayName,
          photoUrl: user.photo_url || dbUser.photoUrl,
        },
        include: {
          entitlements: {
            where: { status: "active", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            select: { resourceType: true, resourceId: true, expiresAt: true },
          },
        },
      });
    }

    const hasMembership = dbUser.entitlements.some(
      (e: any) => e.resourceType === "membership_channel",
    );
    const membershipExpiry = dbUser.entitlements
      .filter((e: any) => e.resourceType === "membership_channel" && e.expiresAt)
      .sort((a: any, b: any) => (b.expiresAt as any) - (a.expiresAt as any))[0]?.expiresAt;

    const session = req.session as any;
    session.userId = dbUser.id;
    session.telegramUserId = user.id;
    session.authBotKey = verified.bot.key;

    return {
      user: {
        id: dbUser.id,
        telegramUserId: String(dbUser.telegramUserId),
        displayName: dbUser.displayName,
        username: dbUser.username,
        photoUrl: dbUser.photoUrl,
      },
      access: {
        membership: hasMembership ? "active" : "none",
        expiresAt: membershipExpiry ? membershipExpiry.toISOString() : null,
      },
      entitlementCount: dbUser.entitlements.length,
      authBotKey: verified.bot.key,
      sessionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  });
}
