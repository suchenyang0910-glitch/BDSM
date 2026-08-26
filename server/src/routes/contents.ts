import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { formatDuration } from "../utils/telegram.js";
import { buildEffectiveSeo, buildVideoObjectJsonLd } from "../services/seoMetadata.js";
import { resolveDefaultMonthlyMembershipProduct } from "../services/membershipProduct.js";
import { createPrivatePresignedReadUrl } from "../services/objectStorage.js";

const contentsQuerySchema = z.object({
  categoryId: z.string().optional(),
  type: z.enum(["public", "single", "package", "membership"]).optional(),
  sort: z.enum(["newest", "featured", "popular"]).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export default async function contentRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  async function tryGetPlatformMetadata() {
    try {
      return await prisma.platformMetadata.findUnique({ where: { id: "default" } });
    } catch {
      return null;
    }
  }

  function resolveBaseUrl(req: any) {
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https");
    const host = String(req.headers.host || "bdsm.linkx.club");
    return `${proto}://${host}`;
  }

  function resolvePublishedCoverUrl(content: any) {
    const cover = Array.isArray(content.videoAssets) ? content.videoAssets[0] : null;
    // VOD covers are stored in video_assets. The browser receives a controlled
    // application route, never an object key or a stable object-storage URL.
    return cover ? `/api/contents/${encodeURIComponent(content.id)}/cover` : content.coverUrl || null;
  }

  fastify.get("/contents", async (req) => {
    const query = contentsQuerySchema.parse(req.query as any);
    const uid = (req as any).userId as string | undefined;
    const now = new Date();

    const where: any = { status: "published" };
    if (query.type) where.accessType = query.type;
    if (query.categoryId && query.categoryId !== "all" && query.categoryId !== "featured") {
      where.categories = { some: { categoryId: query.categoryId } };
    }
    if (query.categoryId === "featured") where.isFeatured = true;

    const orderBy: any[] = [];
    if (query.sort === "featured") orderBy.push({ featuredSort: "asc" });
    if (query.sort === "newest" || query.sort === "popular") orderBy.push({ publishedAt: "desc" });

    const skip = (query.page - 1) * query.pageSize;
    const take = query.pageSize;

    const [total, rows, platformMetadata, defaultMembershipProduct] = await Promise.all([
      prisma.content.count({ where }),
      prisma.content.findMany({
        where,
        orderBy,
        skip,
        take,
        include: {
          categories: { select: { category: { select: { id: true, name: true } } } },
          product: { select: { id: true, priceMinor: true, currency: true, usdtPriceMinor: true, type: true } },
          package: { select: { id: true, title: true } },
          videoAssets: {
            where: { kind: "cover", status: "verified", deletedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      }),
      tryGetPlatformMetadata(),
      resolveDefaultMonthlyMembershipProduct(prisma),
    ]);

    let userEntitlements: Set<string> = new Set();
    let hasMembership = false;
    if (uid) {
      const ents = await prisma.entitlement.findMany({
        where: {
          userId: uid,
          status: "active",
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
        select: { resourceType: true, resourceId: true },
      });
      ents.forEach((e: any) => userEntitlements.add(`${e.resourceType}:${e.resourceId}`));
      hasMembership = ents.some((e: any) => e.resourceType === "membership_channel");
      const packageIds = ents.filter((e: any) => e.resourceType === "package").map((e: any) => e.resourceId);
      if (packageIds.length > 0) {
        const pkgContents = await prisma.content.findMany({
          where: { packageId: { in: packageIds } },
          select: { id: true },
        });
        pkgContents.forEach((c: any) => userEntitlements.add(`content:${c.id}`));
      }
    }

    const data = rows.map((c: any) => {
      const product = c.product || (c.accessType === "membership" ? defaultMembershipProduct : null);
      const cat = c.categories?.[0]?.category;
      const tags: string[] = [];
      if (c.isFeatured) tags.push("精选");
      if (c.isRecommended) tags.push("推荐");
      if (c.isNewArrival) tags.push("新上架");
      if (c.accessType === "public") tags.push("PUBLIC");
      if (c.accessType === "membership") tags.push("MEMBERS ONLY");
      const owned =
        c.accessType === "public" ||
        userEntitlements.has(`content:${c.id}`) ||
        (c.accessType === "membership" && hasMembership);
      return {
        id: c.id,
        title: c.title,
        coverUrl: resolvePublishedCoverUrl(c),
        description: c.description || "",
        previewUrl: c.previewUrl || null,
        duration: formatDuration(c.durationSeconds),
        durationSeconds: c.durationSeconds,
        accessType: c.accessType,
        access: c.accessType === "public" ? "public" : "member",
        unlocked: owned,
        tag: tags.join(" · "),
        tags,
        categoryId: cat?.id,
        categoryName: cat?.name,
        packageId: c.package?.id || c.packageId || null,
        packageTitle: c.package?.title || null,
        productId: product?.id || c.productId || null,
        priceMinor: product?.priceMinor?.toString(),
        priceCurrency: product?.currency,
        usdtPriceMinor: product?.usdtPriceMinor?.toString() ?? null,
        publishedAt: c.publishedAt?.toISOString(),
        effectiveSeo: buildEffectiveSeo({
          contentSeoTitle: c.seoTitle,
          contentSeoDescription: c.seoDescription,
          contentSeoKeywords: c.seoKeywords,
          contentGeoKeywords: c.geoKeywords,
          fallbackTitle: c.title,
          fallbackDescription: c.description,
          platformSeoTitle: platformMetadata?.seoTitle,
          platformSeoDescription: platformMetadata?.seoDescription,
          platformSeoKeywords: platformMetadata?.seoKeywords,
          platformGeoKeywords: platformMetadata?.geoKeywords,
        }),
      };
    });

    return {
      items: data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  });

  fastify.get<{ Params: { id: string } }>("/contents/:id/cover", async (req, reply) => {
    const { id } = req.params;
    const content = await prisma.content.findUnique({
      where: { id },
      select: {
        status: true,
        videoAssets: {
          where: { kind: "cover", status: "verified", deletedAt: null },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { objectKey: true },
        },
      },
    });
    const cover = content?.videoAssets?.[0];
    if (!content || content.status !== "published" || !cover) {
      return reply.status(404).send({ error: "not_found" });
    }
    try {
      const signed = await createPrivatePresignedReadUrl(cover.objectKey, 5 * 60);
      return reply.redirect(signed.downloadUrl);
    } catch {
      return reply.status(503).send({ error: "cover_unavailable" });
    }
  });

  fastify.get<{ Params: { id: string } }>("/contents/:id", async (req, reply) => {
    const { id } = req.params;
    const uid = (req as any).userId as string | undefined;
    const now = new Date();

    const [content, platformMetadata, defaultMembershipProduct] = await Promise.all([
      prisma.content.findUnique({
        where: { id },
        include: {
          categories: { select: { category: { select: { id: true, name: true } } } },
          package: { select: { id: true, title: true, coverUrl: true } },
          product: { select: { id: true, priceMinor: true, currency: true, usdtPriceMinor: true, type: true, durationDays: true } },
          videoAssets: {
            where: { kind: "cover", status: "verified", deletedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      }),
      tryGetPlatformMetadata(),
      resolveDefaultMonthlyMembershipProduct(prisma),
    ]);

    if (!content) return reply.status(404).send({ error: "not_found" });
    if (content.status !== "published") {
      return reply.status(403).send({ error: "content_unavailable", message: "内容已下架或未上架" });
    }

    let unlocked = content.accessType === "public";
    let ownedBy = "";
    if (uid && !unlocked) {
      const ents = await prisma.entitlement.findMany({
        where: {
          userId: uid,
          status: "active",
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
        select: { resourceType: true, resourceId: true, expiresAt: true },
      });
      const hasContent = ents.some((e: any) => e.resourceType === "content" && e.resourceId === id);
      const hasPackage = content.packageId && ents.some((e: any) => e.resourceType === "package" && e.resourceId === content.packageId);
      const hasMembership = ents.some((e: any) => e.resourceType === "membership_channel") && content.accessType === "membership";
      unlocked = hasContent || !!hasPackage || hasMembership;
      if (hasContent) ownedBy = "single";
      else if (hasPackage) ownedBy = "package";
      else if (hasMembership) ownedBy = "membership";
    }

    const tags: string[] = [];
    if (content.isFeatured) tags.push("精选");
    if (content.isRecommended) tags.push("推荐");
    if (content.isNewArrival) tags.push("新上架");

    const effectiveSeo = buildEffectiveSeo({
      contentSeoTitle: content.seoTitle,
      contentSeoDescription: content.seoDescription,
      contentSeoKeywords: content.seoKeywords,
      contentGeoKeywords: content.geoKeywords,
      fallbackTitle: content.title,
      fallbackDescription: content.description,
      platformSeoTitle: platformMetadata?.seoTitle,
      platformSeoDescription: platformMetadata?.seoDescription,
      platformSeoKeywords: platformMetadata?.seoKeywords,
      platformGeoKeywords: platformMetadata?.geoKeywords,
    });
    const pageUrl = `${resolveBaseUrl(req)}/#view=content&id=${encodeURIComponent(content.id)}`;
    const product = content.product || (content.accessType === "membership" ? defaultMembershipProduct : null);
    return {
      id: content.id,
      title: content.title,
      coverUrl: resolvePublishedCoverUrl(content),
      description: content.description || "",
      previewUrl: content.previewUrl || null,
      duration: formatDuration(content.durationSeconds),
      durationSeconds: content.durationSeconds,
      accessType: content.accessType,
      tags,
      categories: content.categories.map((c: any) => c.category),
      package: content.package,
      product: product
        ? {
            id: product.id,
            priceMinor: product.priceMinor.toString(),
            currency: product.currency,
            usdtPriceMinor: product.usdtPriceMinor?.toString() ?? null,
            type: product.type,
            durationDays: product.durationDays,
          }
        : null,
      unlocked,
      ownedBy,
      publishedAt: content.publishedAt?.toISOString(),
      effectiveSeo,
      robots: "noindex,nofollow",
      videoObjectJsonLd: buildVideoObjectJsonLd({
        title: effectiveSeo.title || content.title,
        description: effectiveSeo.description || content.description || "",
        thumbnailUrl: resolvePublishedCoverUrl(content),
        previewUrl: content.previewUrl,
        uploadDate: content.publishedAt?.toISOString() || null,
        durationSeconds: content.durationSeconds,
        pageUrl,
      }),
    };
  });
}
