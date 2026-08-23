import type { FastifyInstance } from "fastify";
import { formatDuration } from "../utils/telegram.js";
import { buildEffectiveSeo } from "../services/seoMetadata.js";

export default async function homeRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  async function tryGetPlatformMetadata() {
    try {
      return await prisma.platformMetadata.findUnique({ where: { id: "default" } });
    } catch {
      return null;
    }
  }

  fastify.get("/health", async (_req, reply) => {
    reply.send({ ok: true, ts: new Date().toISOString() });
  });

  fastify.get("/home", async (req) => {
    const now = new Date();
    const uid = (req as any).userId as string | undefined;

    const hv = await prisma.homepageVersion.findFirst({
      where: { status: "published" },
      orderBy: [{ publishedAt: "desc" }],
    });
    const cfg: any = hv?.config || {};
    const orderIdx = <T extends { id: string }>(ids: string[], rows: T[]) => {
      const m = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => m.get(id)).filter(Boolean) as T[];
    };

    const [rawBanners, pubCategories, rawRec, rawFeat, platformMetadata] = await Promise.all([
      cfg.bannerIds?.length
        ? prisma.banner.findMany({
            where: { id: { in: cfg.bannerIds } },
          })
        : prisma.banner.findMany({
            where: {
              status: "active",
              AND: [
                { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
              ],
            },
            take: 10,
          }),
      cfg.categoryOrderIds?.length
        ? prisma.category.findMany({ where: { id: { in: cfg.categoryOrderIds }, status: "active" } })
        : prisma.category.findMany({ where: { status: "active" }, take: 20 }),
      cfg.recommendContentIds?.length
        ? prisma.content.findMany({
            where: { id: { in: cfg.recommendContentIds }, status: "published" },
            include: {
              categories: { select: { category: { select: { id: true, name: true } } } },
              product: { select: { priceMinor: true, currency: true, type: true } },
            },
          })
        : prisma.content.findMany({
            where: { status: "published" },
            orderBy: [{ publishedAt: "desc" }],
            take: 30,
            include: {
              categories: { select: { category: { select: { id: true, name: true } } } },
              product: { select: { priceMinor: true, currency: true, type: true } },
            },
          }),
      cfg.featuredContentIds?.length
        ? prisma.content.findMany({
            where: { id: { in: cfg.featuredContentIds }, status: "published" },
            include: {
              categories: { select: { category: { select: { id: true, name: true } } } },
              product: { select: { priceMinor: true, currency: true, type: true } },
            },
          })
        : Promise.resolve([] as any[]),
      tryGetPlatformMetadata(),
    ]);

    const banners = (cfg.bannerIds?.length ? orderIdx(cfg.bannerIds, rawBanners) : rawBanners).filter((b: any) => {
      if (b.status === "archived" || b.status === "inactive" || b.status === "draft") return false;
      if (b.startsAt && new Date(b.startsAt) > now) return false;
      if (b.endsAt && new Date(b.endsAt) < now) return false;
      return true;
    });

    const publishedCategories = cfg.categoryOrderIds?.length ? orderIdx(cfg.categoryOrderIds, pubCategories) : pubCategories;

    const featuredIds = new Set(rawFeat.map((c: any) => c.id));
    const recommendIds = new Set(rawRec.map((c: any) => c.id));
    const combined: any[] = [];
    const seen = new Set<string>();
    for (const c of rawRec) {
      if (!seen.has(c.id)) { combined.push(c); seen.add(c.id); }
    }
    for (const c of rawFeat) {
      if (!seen.has(c.id)) { combined.push(c); seen.add(c.id); }
    }
    const allPublishedContents = combined.length > 0 ? combined : rawRec;

    function computeTags(content: any): string[] {
      const tags: string[] = [];
      if (content.accessType === "public") tags.push("PUBLIC");
      if (content.accessType === "membership") tags.push("MEMBERS ONLY");
      if (content.accessType === "package") tags.push("CONTENT PACK");
      if (content.accessType === "single") tags.push("SINGLE");
      if (featuredIds.has(content.id)) tags.unshift("精选");
      if (recommendIds.has(content.id)) tags.unshift("推荐");
      return tags;
    }

    const contents = allPublishedContents.map((c: any) => {
      const cat = c.categories?.[0]?.category;
      return {
        id: c.id,
        title: c.title,
        coverUrl: c.coverImageUrl,
        description: c.summary || "",
        duration: formatDuration((c as any).durationSeconds),
        durationSeconds: (c as any).durationSeconds,
        accessType: c.accessType || (c.productId ? "single" : "public"),
        access: (c.accessType === "public" || !c.productId) ? "public" : "member",
        isFeatured: featuredIds.has(c.id),
        isRecommended: recommendIds.has(c.id),
        tag: computeTags(c).join(" · "),
        tags: computeTags(c),
        categoryId: cat?.id || "featured",
        categoryName: cat?.name,
        priceMinor: c.product?.priceMinor?.toString(),
        priceCurrency: c.product?.currency,
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

    const systemCategoryAll = { id: "all", name: "全部", slug: "all", iconUrl: null, _system: true };
    const systemCategoryFeatured = publishedCategories.find((c: any) => c.slug === "featured")
      ? null
      : { id: "featured", name: "精选", slug: "featured", iconUrl: null, _system: true };
    const finalCategories = [systemCategoryAll, systemCategoryFeatured, ...publishedCategories].filter(Boolean);

    let userEntitlements: Set<string> = new Set();
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
      const packageIds = ents.filter((e: any) => e.resourceType === "package").map((e: any) => e.resourceId);
      if (packageIds.length > 0) {
        const pkgContents = await prisma.content.findMany({ where: { packageId: { in: packageIds } }, select: { id: true } });
        pkgContents.forEach((c: any) => userEntitlements.add(`content:${c.id}`));
      }
    }

    const hasMembership = userEntitlements.size > 0 && [...userEntitlements].some((k) => k.startsWith("membership_channel:"));

    const contentsWithAccess = contents.map((c: any) => {
      const owned =
        c.accessType === "public" ||
        userEntitlements.has(`content:${c.id}`) ||
        (c.accessType === "membership" && hasMembership);
      return { ...c, unlocked: owned };
    });

    return {
      unlocked: hasMembership,
      versionId: hv?.id || null,
      versionLabel: (hv as any)?.versionLabel || null,
      publishedAt: (hv as any)?.publishedAt || null,
      banners: banners.map((b: any) => {
        const {
          telegramBotToken,
          telegramPrivateChannelInviteLink,
          telegramPrivateJoinLink,
          telegramChatId,
          telegramMessageId,
          ...rest
        } = b;
        void telegramBotToken; void telegramPrivateChannelInviteLink; void telegramPrivateJoinLink; void telegramChatId; void telegramMessageId;
        const actionLabel = b.actionLabel || (rest as any).subtitle || "";
        const targetMap = { none: null, content: "content", category: "category", product: "product", external: "external", content_package: "package" } as any;
        const targetType = targetMap[(b.redirectType || "none")] || null;
        let targetId: string | null = null;
        let externalUrl: string | undefined;
        if (b.redirectType === "content") targetId = b.redirectContentId;
        else if (b.redirectType === "category") targetId = b.redirectCategoryId;
        else if (b.redirectType === "product") targetId = b.redirectProductId;
        else if (b.redirectType === "content_package") targetId = b.redirectContentPackageId;
        else if (b.redirectType === "external") { targetId = b.redirectUrl || null; externalUrl = b.redirectUrl || undefined; }
        return {
          id: b.id,
          eyebrow: actionLabel,
          title: b.title || "",
          description: (b.subtitle || b.description || "") as string,
          actionLabel: actionLabel || "查看",
          targetType,
          targetId,
          externalUrl,
          imageUrl: b.coverImageUrl || b.imageUrl,
        };
      }),
      categories: finalCategories.map((c: any) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        iconUrl: c.icon ?? c.iconUrl ?? null,
        _system: (c as any)._system ?? false,
        sortOrder: (c as any).displayOrder ?? 0,
      })),
      contents: contentsWithAccess,
      meta: {
        generatedAt: new Date().toISOString(),
        entitlementCount: userEntitlements.size,
        hasMembership,
      },
      seo: buildEffectiveSeo({
        fallbackTitle: "同频点播",
        fallbackDescription: "Telegram Mini App 与 H5 混合内容目录。",
        platformSeoTitle: platformMetadata?.seoTitle,
        platformSeoDescription: platformMetadata?.seoDescription,
        platformSeoKeywords: platformMetadata?.seoKeywords,
        platformGeoKeywords: platformMetadata?.geoKeywords,
      }),
      robots: "noindex,nofollow",
    };
  });
}
