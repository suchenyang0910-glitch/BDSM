import type { FastifyInstance } from "fastify";
import { formatDuration } from "../utils/telegram.js";
import { buildEffectiveSeo } from "../services/seoMetadata.js";
import { resolveDefaultMonthlyMembershipProduct } from "../services/membershipProduct.js";

type RawContentRow = {
  id: string;
  title: string;
  coverUrl: string | null;
  description: string | null;
  summary?: string | null;
  previewUrl?: string | null;
  durationSeconds: number | null;
  accessType: string;
  isRecommended: boolean;
  isFeatured: boolean;
  isNewArrival: boolean;
  publishedAt: Date | null;
  productId: string | null;
  packageId: string | null;
  videoAssets?: Array<{ id: string }>;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string[];
  geoKeywords?: string[];
  categories?: Array<{ category: { id: string; name: string } }>;
  package?: { id: string; title: string } | null;
  product?: { id: string; priceMinor: bigint; currency: string; usdtPriceMinor?: bigint | null; type: string } | null;
};

export default async function homeRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  function resolvePublishedCoverUrl(row: RawContentRow) {
    return row.videoAssets?.[0]
      ? `/api/contents/${encodeURIComponent(row.id)}/cover`
      : row.coverUrl || null;
  }

  async function tryGetPlatformMetadata() {
    try {
      return await prisma.platformMetadata.findUnique({ where: { id: "default" } });
    } catch {
      return null;
    }
  }

  function orderByIds<T extends { id: string }>(ids: string[], rows: T[]): T[] {
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => rowMap.get(id)).filter(Boolean) as T[];
  }

  function buildContentPayload(
    row: RawContentRow,
    opts: {
      platformMetadata: any;
      unlocked: boolean;
      tagPrefix?: string[];
      defaultMembershipProduct?: RawContentRow["product"];
    },
  ) {
    const category = row.categories?.[0]?.category;
    const tags = [...(opts.tagPrefix || [])];
    if (row.isFeatured && !tags.includes("今日精选")) tags.push("今日精选");
    if (row.isRecommended && !tags.includes("推荐")) tags.push("推荐");
    if (row.isNewArrival && !tags.includes("新上架")) tags.push("新上架");
    if (row.accessType === "public") tags.push("公开预览");
    if (row.accessType === "membership") tags.push("会员内容");
    if (row.accessType === "package") tags.push("内容包内容");

    const product = row.product || (row.accessType === "membership" ? opts.defaultMembershipProduct || null : null);
    return {
      id: row.id,
      title: row.title,
      coverUrl: resolvePublishedCoverUrl(row),
      description: row.description || row.summary || "",
      previewUrl: row.previewUrl || null,
      duration: formatDuration(row.durationSeconds ?? undefined),
      durationSeconds: row.durationSeconds,
      accessType: row.accessType,
      access: row.accessType === "public" ? "public" : "member",
      isFeatured: row.isFeatured,
      isRecommended: row.isRecommended,
      isNewArrival: row.isNewArrival,
      tag: tags.join(" · "),
      tags,
      categoryId: category?.id || "all",
      categoryName: category?.name || "",
      packageId: row.package?.id || row.packageId || null,
      packageTitle: row.package?.title || null,
      productId: product?.id || row.productId || null,
      priceMinor: product?.priceMinor?.toString(),
      priceCurrency: product?.currency,
      usdtPriceMinor: product?.usdtPriceMinor?.toString() ?? null,
      publishedAt: row.publishedAt?.toISOString(),
      unlocked: opts.unlocked,
      effectiveSeo: buildEffectiveSeo({
        contentSeoTitle: row.seoTitle,
        contentSeoDescription: row.seoDescription,
        contentSeoKeywords: row.seoKeywords,
        contentGeoKeywords: row.geoKeywords,
        fallbackTitle: row.title,
        fallbackDescription: row.description,
        platformSeoTitle: opts.platformMetadata?.seoTitle,
        platformSeoDescription: opts.platformMetadata?.seoDescription,
        platformSeoKeywords: opts.platformMetadata?.seoKeywords,
        platformGeoKeywords: opts.platformMetadata?.geoKeywords,
      }),
    };
  }

  fastify.get("/health", async (_req, reply) => {
    reply.send({ ok: true, ts: new Date().toISOString() });
  });

  fastify.get("/home", async (req) => {
    const now = new Date();
    const uid = (req as any).userId as string | undefined;

    const homepageVersion = await prisma.homepageVersion.findFirst({
      where: { status: "published" },
      orderBy: [{ publishedAt: "desc" }],
    });
    const config: any = homepageVersion?.config || {};

    const [
      rawConfiguredBanners,
      rawConfiguredFeatured,
      rawConfiguredCategories,
      activeBanners,
      activeCategories,
      latestRows,
      fallbackFeaturedRows,
      platformMetadata,
      defaultMembershipProduct,
    ] = await Promise.all([
      config.bannerIds?.length
        ? prisma.banner.findMany({ where: { id: { in: config.bannerIds } } })
        : Promise.resolve([] as any[]),
      config.featuredContentIds?.length
        ? prisma.content.findMany({
            where: { id: { in: config.featuredContentIds }, status: "published" },
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
          })
        : Promise.resolve([] as RawContentRow[]),
      config.categoryOrderIds?.length
        ? prisma.category.findMany({
            where: { id: { in: config.categoryOrderIds }, status: "active" },
          })
        : Promise.resolve([] as any[]),
      prisma.banner.findMany({
        where: {
          status: { in: ["active", "scheduled"] },
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
          ],
        },
        orderBy: [{ sortOrder: "desc" }, { updatedAt: "desc" }],
        take: 6,
      }),
      prisma.category.findMany({
        where: { status: "active" },
        orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
        take: 8,
      }),
      prisma.content.findMany({
        where: { status: "published" },
        orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
        take: 12,
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
      prisma.content.findMany({
        where: { status: "published", isFeatured: true },
        orderBy: [{ featuredSort: "asc" }, { publishedAt: "desc" }],
        take: 4,
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

    const configuredBanners = config.bannerIds?.length
      ? orderByIds(config.bannerIds, rawConfiguredBanners)
      : [];
    const configuredFeatured = config.featuredContentIds?.length
      ? orderByIds(config.featuredContentIds, rawConfiguredFeatured)
      : [];
    const configuredCategories = config.categoryOrderIds?.length
      ? orderByIds(config.categoryOrderIds, rawConfiguredCategories)
      : [];

    const bannersSource = configuredBanners.length > 0 ? configuredBanners : activeBanners;
    const banners = bannersSource.filter((banner: any) => {
      if (!banner || banner.status === "draft" || banner.status === "inactive" || banner.status === "archived") {
        return false;
      }
      if (banner.startsAt && new Date(banner.startsAt) > now) return false;
      if (banner.endsAt && new Date(banner.endsAt) < now) return false;
      return true;
    }).slice(0, 3);

    const categoriesSource = configuredCategories.length > 0 ? configuredCategories : activeCategories;
    const themeCategoriesRaw = categoriesSource.slice(0, 4);
    const systemCategoryAll = { id: "all", name: "全部", slug: "all", iconUrl: null, sortOrder: 0, _system: true };
    const systemCategoryFeatured = { id: "featured", name: "精选", slug: "featured", iconUrl: null, sortOrder: 1, _system: true };
    const categories = [systemCategoryAll, systemCategoryFeatured].concat(
      activeCategories.map((category: any) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        iconUrl: category.iconUrl ?? null,
        sortOrder: category.sortOrder ?? 0,
        _system: false,
      })),
    );

    let userEntitlements: Set<string> = new Set();
    let hasMembership = false;
    if (uid) {
      const entitlements = await prisma.entitlement.findMany({
        where: {
          userId: uid,
          status: "active",
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
        select: { resourceType: true, resourceId: true },
      });
      entitlements.forEach((entitlement: any) => userEntitlements.add(`${entitlement.resourceType}:${entitlement.resourceId}`));
      hasMembership = entitlements.some((entitlement: any) => entitlement.resourceType === "membership_channel");
      const packageIds = entitlements
        .filter((entitlement: any) => entitlement.resourceType === "package")
        .map((entitlement: any) => entitlement.resourceId);
      if (packageIds.length > 0) {
        const packageContents = await prisma.content.findMany({
          where: { packageId: { in: packageIds } },
          select: { id: true },
        });
        packageContents.forEach((content: any) => userEntitlements.add(`content:${content.id}`));
      }
    }

    const isUnlocked = (row: RawContentRow) => (
      row.accessType === "public"
      || userEntitlements.has(`content:${row.id}`)
      || (row.accessType === "membership" && hasMembership)
    );

    const featuredRow = (configuredFeatured[0] || fallbackFeaturedRows[0] || latestRows[0] || null) as RawContentRow | null;
    const featuredContent = featuredRow
      ? buildContentPayload(featuredRow, {
          platformMetadata,
          unlocked: isUnlocked(featuredRow),
          tagPrefix: ["今日精选"],
          defaultMembershipProduct,
        })
      : null;

    const latestContents = latestRows.slice(0, 6).map((row: RawContentRow) => buildContentPayload(row, {
      platformMetadata,
      unlocked: isUnlocked(row),
      defaultMembershipProduct,
    }));

    const themeCategories = await Promise.all(themeCategoriesRaw.map(async (category: any) => {
      const count = await prisma.content.count({
        where: {
          status: "published",
          categories: { some: { categoryId: category.id } },
        },
      });
      return {
        id: category.id,
        name: category.name,
        slug: category.slug,
        iconUrl: category.iconUrl ?? null,
        sortOrder: category.sortOrder ?? 0,
        publishedContentCount: count,
      };
    }));

    const legacyContentsMap = new Map<string, ReturnType<typeof buildContentPayload>>();
    if (featuredContent) legacyContentsMap.set(featuredContent.id, featuredContent);
    for (const item of latestContents) {
      if (!legacyContentsMap.has(item.id)) legacyContentsMap.set(item.id, item);
    }

    return {
      unlocked: hasMembership,
      versionId: homepageVersion?.id || null,
      versionLabel: (homepageVersion as any)?.versionLabel || null,
      publishedAt: (homepageVersion as any)?.publishedAt || null,
      brandHint: "真实表达，在理解与边界中被看见",
      banners: banners.map((banner: any) => ({
        id: banner.id,
        eyebrow: banner.actionLabel || "查看详情",
        title: banner.title || "",
        description: banner.description || "",
        actionLabel: banner.actionLabel || "查看详情",
        targetType: banner.targetType || null,
        targetId: banner.targetType === "external" ? null : banner.targetId,
        externalUrl: banner.targetType === "external" ? banner.externalUrl || undefined : undefined,
        imageUrl: banner.imageUrl || null,
      })),
      categories,
      contents: Array.from(legacyContentsMap.values()),
      featuredContent,
      latestContents,
      themeCategories,
      meta: {
        generatedAt: new Date().toISOString(),
        entitlementCount: userEntitlements.size,
        hasMembership,
      },
      seo: buildEffectiveSeo({
        fallbackTitle: "同频点播",
        fallbackDescription: "视频点播目录、会员权益与 Telegram 频道交付入口。",
        platformSeoTitle: platformMetadata?.seoTitle,
        platformSeoDescription: platformMetadata?.seoDescription,
        platformSeoKeywords: platformMetadata?.seoKeywords,
        platformGeoKeywords: platformMetadata?.geoKeywords,
      }),
      robots: "noindex,nofollow",
    };
  });
}
