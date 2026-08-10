import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
try {
  const pub = await prisma.content.findMany({
    where: { status: "published" },
    orderBy: [{ isRecommended: "desc" }, { isFeatured: "desc" }],
    select: { id: true, title: true, accessType: true, channelId: true, packageId: true, isRecommended: true, isFeatured: true },
    take: 10,
  });
  console.log("Published contents (db):");
  for (const c of pub) console.log("  id=" + c.id + " title=" + c.title + " access=" + c.accessType + " ch=" + (c.channelId?.toString() || "") + " pkg=" + (c.packageId || "") + " rec=" + c.isRecommended + " feat=" + c.isFeatured);
  const mems = pub.filter(c => c.accessType === "membership");
  console.log("membership content id list:", mems.map(c=>c.id).join(", "));
  console.log("topic-02 like title:", pub.filter(c => c.title && (c.title.includes("02") || c.title.includes("第")))[0]);
} finally {
  await prisma.$disconnect();
}
