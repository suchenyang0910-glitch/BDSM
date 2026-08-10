import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
try {
  const u = await prisma.user.findFirst({
    where: { telegramUserId: 1000000001n },
    select: { id: true, telegramUserId: true, displayName: true },
  });
  console.log("DEMO_USER id=", u.id, "telegramUserId=", u.telegramUserId.toString(), "displayName=", u.displayName);
} finally {
  await prisma.$disconnect();
}
