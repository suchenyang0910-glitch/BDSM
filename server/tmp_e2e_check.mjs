import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const uid = "d73f84bb-d3a6-4695-99b1-88d26fa0db52";
try {
  const orderCount = await prisma.order.count({ where: { userId: uid } });
  const orders = await prisma.order.findMany({
    where: { userId: uid },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { product: { select: { title: true, type: true } } },
  });
  console.log("ORDER COUNT=", orderCount);
  for (const o of orders) {
    console.log(`  - orderNo=${o.orderNo} status=${o.status} amount=${o.amountMinor}${o.currency} product=${o.product?.title}(${o.product?.type}) createdAt=${o.createdAt.toISOString()}`);
  }
  const entCount = await prisma.entitlement.count({ where: { userId: uid } });
  console.log("ENTITLEMENT COUNT=", entCount);
  const ents = await prisma.entitlement.findMany({
    where: { userId: uid },
    orderBy: [{ status: "asc" }, { expiresAt: "desc" }],
  });
  for (const e of ents) {
    console.log(`  - id=${e.id} type=${e.resourceType} resourceId=${e.resourceId} status=${e.status} starts=${e.startsAt.toISOString().slice(0,10)} expires=${e.expiresAt?.toISOString().slice(0,10)}`);
  }
  console.log("ORD2026080636D3C12A7A9F 搜索=", await prisma.order.findFirst({ where: { orderNo: "ORD2026080636D3C12A7A9F" } }));
} finally {
  await prisma.$disconnect();
}
