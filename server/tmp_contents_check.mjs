import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const uid = "d73f84bb-d3a6-4695-99b1-88d26fa0db52";
try {
  const published = await prisma.content.findMany({
    where: { status: "published" },
    select: { id: true, slug: true, title: true, accessType: true, isRecommended: true, isFeatured: true, categories: { take: 1, select: { category: { select: { slug: true, name: true } } } } },
    orderBy: [{ isRecommended: "desc" }, { isFeatured: "desc" }],
    take: 10,
  });
  console.log("--- Published contents sample ---");
  for (const c of published) {
    const catSlug = c.categories?.[0]?.category?.slug || "featured";
    console.log(`  id=${c.id} slug=${c.slug} title=${c.title} access=${c.accessType} cat=${catSlug} rec=${c.isRecommended} feat=${c.isFeatured}`);
  }
  const product = await prisma.product.findFirst({ where: { type: "membership" } });
  console.log("--- Membership product ID:", product?.id, "title:", product?.title);
} finally {
  await prisma.$disconnect();
}
