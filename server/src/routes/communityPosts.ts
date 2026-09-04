import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadCommunityFeatureConfig, startOfCurrentUtcDay } from "../services/communityConfig.js";
import { buildEffectiveSeo, normalizeKeywordList } from "../services/seoMetadata.js";

const COMMUNITY_PAGE_SIZE_MAX = 20;
const COMMUNITY_POST_BODY_MAX = 2_000;
const COMMUNITY_POST_TOPIC_MAX = 5;
const COMMUNITY_POST_TOPIC_LENGTH = 24;
const COMMUNITY_POST_DAILY_LIMIT = 5;

const listPostsQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(COMMUNITY_PAGE_SIZE_MAX).default(20),
  sort: z.enum(["new", "hot"]).default("new"),
});

const createPostSchema = z.object({
  body: z.string().trim().min(1).max(COMMUNITY_POST_BODY_MAX),
  topics: z.array(z.string().trim().min(1).max(COMMUNITY_POST_TOPIC_LENGTH)).max(COMMUNITY_POST_TOPIC_MAX).default([]),
});

const updatePostSchema = z.object({
  body: z.string().trim().min(1).max(COMMUNITY_POST_BODY_MAX),
  topics: z.array(z.string().trim().min(1).max(COMMUNITY_POST_TOPIC_LENGTH)).max(COMMUNITY_POST_TOPIC_MAX).default([]),
});

const myPostsQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(COMMUNITY_PAGE_SIZE_MAX).default(20),
});

type CommunityCursorPayload = {
  id: string;
  isPinned?: boolean;
  publishedAt?: string | null;
  createdAt: string;
  reactionCount?: number;
  commentCount?: number;
};

function requireUser(req: any, reply: any): string | null {
  const userId = typeof req.userId === "string" && req.userId ? req.userId : null;
  if (!userId) {
    reply.status(401).send({ error: "unauthorized", message: "请先登录。" });
    return null;
  }
  return userId;
}

function normalizeCommunityTopics(input: string[]): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of input || []) {
    const value = String(raw || "").trim().replace(/^#+/g, "").replace(/\s+/g, " ");
    if (!value) continue;
    const key = value.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(value);
    if (items.length >= COMMUNITY_POST_TOPIC_MAX) break;
  }
  return items;
}

function normalizeCommunityBody(input: unknown): string {
  return String(input || "").replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

function summarizeBody(input: string, max = 160): string {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function summarizeTitle(input: string, max = 48): string {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function encodeCursor(payload: CommunityCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(input: string | undefined): CommunityCursorPayload | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as CommunityCursorPayload;
    if (!parsed?.id || !parsed?.createdAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function makeImageGatewayUrl(postId: string, assetId: string) {
  return `/api/community/posts/${encodeURIComponent(postId)}/assets/${encodeURIComponent(assetId)}/image`;
}

function deriveCommunitySeo(input: {
  body: string;
  topics: string[];
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: unknown;
  geoKeywords?: unknown;
  platformSeoTitle?: string | null;
  platformSeoDescription?: string | null;
  platformSeoKeywords?: unknown;
  platformGeoKeywords?: unknown;
}) {
  const fallbackTitle = summarizeTitle(input.body) || "同频社区";
  const fallbackDescription = summarizeBody(input.body, 160) || "同频社区图文帖子";
  return buildEffectiveSeo({
    contentSeoTitle: input.seoTitle,
    contentSeoDescription: input.seoDescription,
    contentSeoKeywords: normalizeKeywordList([...(input.topics || []), ...(Array.isArray(input.seoKeywords) ? input.seoKeywords : [])]),
    contentGeoKeywords: input.geoKeywords,
    fallbackTitle,
    fallbackDescription,
    platformSeoTitle: input.platformSeoTitle,
    platformSeoDescription: input.platformSeoDescription,
    platformSeoKeywords: input.platformSeoKeywords,
    platformGeoKeywords: input.platformGeoKeywords,
  });
}

async function loadPlatformSeo(prisma: any) {
  return prisma.platformMetadata.findUnique({ where: { id: "default" } }).catch(() => null);
}

async function buildCommunityAssetPayload(asset: any, options?: { allowOwnerPreview?: boolean }) {
  const allowOwnerPreview = !!options?.allowOwnerPreview;
  if (!asset) return null;
  if (asset.kind === "image" && asset.thumbnailObjectKey && (asset.moderationStatus === "approved" || allowOwnerPreview)) {
    return {
      id: asset.id,
      kind: "image",
      ordinal: asset.ordinal,
      width: asset.width ?? null,
      height: asset.height ?? null,
      aspectRatio: asset.aspectRatio ?? null,
      imageUrl: makeImageGatewayUrl(asset.postId, asset.id),
    };
  }
  if (asset.kind === "video" && asset.posterObjectKey && asset.transcodeStatus === "ready" && asset.moderationStatus === "approved") {
    return {
      id: asset.id,
      kind: "video",
      ordinal: asset.ordinal,
      width: asset.width ?? null,
      height: asset.height ?? null,
      aspectRatio: asset.aspectRatio ?? null,
      durationSeconds: asset.durationSeconds ?? null,
      posterUrl: `/api/community/posts/${encodeURIComponent(asset.postId)}/assets/${encodeURIComponent(asset.id)}/poster`,
      playbackUrl: `/api/community/media/${encodeURIComponent(asset.postId)}/videos/${encodeURIComponent(asset.id)}/master.m3u8`,
    };
  }
  return null;
}

async function serializeCommunityPost(row: any, options?: { viewerUserId?: string | null; includeRejectedReason?: boolean; platformSeo?: any }) {
  const viewerUserId = options?.viewerUserId || null;
  const isOwner = viewerUserId && row.authorId === viewerUserId;
  const effectiveSeo = deriveCommunitySeo({
    body: row.body || "",
    topics: row.topics || [],
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    seoKeywords: row.seoKeywords,
    geoKeywords: row.geoKeywords,
    platformSeoTitle: options?.platformSeo?.seoTitle,
    platformSeoDescription: options?.platformSeo?.seoDescription,
    platformSeoKeywords: options?.platformSeo?.seoKeywords,
    platformGeoKeywords: options?.platformSeo?.geoKeywords,
  });
  const assets = await Promise.all((row.assets || []).sort((a: any, b: any) => (a.ordinal || 0) - (b.ordinal || 0)).map((asset: any) => buildCommunityAssetPayload(asset, {
    allowOwnerPreview: !!(isOwner && row.status !== "published"),
  })));
  const visibleAssets = assets.filter(Boolean);
  const hiddenForPublic = row.status !== "published";

  return {
    id: row.id,
    body: hiddenForPublic && !isOwner ? null : row.body,
    summary: summarizeBody(row.body || "", 160),
    title: summarizeTitle(row.body || "") || "圈子帖子",
    topics: Array.isArray(row.topics) ? row.topics : [],
    status: row.status,
    visibility: row.visibility,
    mediaCount: row.mediaCount || 0,
    reactionCount: row.reactionCount || 0,
    commentCount: row.commentCount || 0,
    reportCount: row.reportCount || 0,
    moderationReason: hiddenForPublic && !isOwner ? null : (options?.includeRejectedReason ? row.moderationReason || null : null),
    isPinned: !!row.isPinned,
    searchIndexable: !!row.searchIndexable,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canonicalUrl: `https://samewave.cc/community/${encodeURIComponent(row.id)}`,
    effectiveSeo: {
      title: effectiveSeo.title,
      description: effectiveSeo.description,
      keywords: effectiveSeo.keywords,
      geoKeywords: effectiveSeo.geoKeywords,
      robots: row.status !== "published" ? "noindex,nofollow" : row.searchIndexable ? "index,follow" : "noindex,follow",
    },
    author: row.author
      ? {
          id: row.author.id,
          displayName: row.author.displayName || "同频成员",
          photoUrl: row.author.photoUrl || null,
        }
      : null,
    assets: hiddenForPublic && !isOwner ? [] : visibleAssets,
  };
}

async function requireReadablePost(prisma: any, postId: string, viewerUserId: string | null) {
  const row = await prisma.communityPost.findUnique({
    where: { id: postId },
    include: {
      author: { select: { id: true, displayName: true, photoUrl: true } },
      assets: {
        orderBy: [{ ordinal: "asc" }],
      },
    },
  });
  if (!row || row.deletedAt) return null;
  if (row.status === "published") return row;
  if (viewerUserId && row.authorId === viewerUserId && (row.status === "pending" || row.status === "rejected")) return row;
  return null;
}

async function assertPostRateLimit(prisma: any, userId: string) {
  const count = await prisma.communityPost.count({
    where: {
      authorId: userId,
      createdAt: { gte: startOfCurrentUtcDay() },
    },
  });
  if (count >= COMMUNITY_POST_DAILY_LIMIT) {
    throw Object.assign(new Error("post_rate_limited"), {
      statusCode: 429,
      payload: { error: "post_rate_limited", message: "今日发帖次数已达上限，请明天再试。" },
    });
  }
}

function buildListWhere(sort: "new" | "hot", cursor: CommunityCursorPayload | null) {
  const where: any = { status: "published", deletedAt: null };
  if (!cursor) return where;
  const publishedAt = cursor.publishedAt ? new Date(cursor.publishedAt) : null;
  if (sort === "new" && publishedAt) {
    const afterCurrentPin = [
      { publishedAt: { lt: publishedAt } },
      { publishedAt, id: { lt: cursor.id } },
    ];
    // The cursor must include every ordering field. Without isPinned here,
    // moving from a pinned row to the normal feed can duplicate or skip rows.
    where.OR = cursor.isPinned
      ? [{ isPinned: false }, { isPinned: true, OR: afterCurrentPin }]
      : [{ isPinned: false, OR: afterCurrentPin }];
  } else {
    const afterCurrentPin = [
      { reactionCount: { lt: Number(cursor.reactionCount || 0) } },
      { reactionCount: Number(cursor.reactionCount || 0), commentCount: { lt: Number(cursor.commentCount || 0) } },
      {
        reactionCount: Number(cursor.reactionCount || 0),
        commentCount: Number(cursor.commentCount || 0),
        createdAt: { lt: new Date(cursor.createdAt) },
      },
      {
        reactionCount: Number(cursor.reactionCount || 0),
        commentCount: Number(cursor.commentCount || 0),
        createdAt: new Date(cursor.createdAt),
        id: { lt: cursor.id },
      },
    ];
    where.OR = cursor.isPinned
      ? [{ isPinned: false }, { isPinned: true, OR: afterCurrentPin }]
      : [{ isPinned: false, OR: afterCurrentPin }];
  }
  return where;
}

function buildListOrder(sort: "new" | "hot") {
  if (sort === "new") return [{ isPinned: "desc" }, { publishedAt: "desc" }, { id: "desc" }] as const;
  return [{ isPinned: "desc" }, { reactionCount: "desc" }, { commentCount: "desc" }, { createdAt: "desc" }, { id: "desc" }] as const;
}

function nextListCursor(items: any[], sort: "new" | "hot") {
  if (!items.length) return null;
  const last = items[items.length - 1];
  return encodeCursor({
    id: String(last.id),
    isPinned: !!last.isPinned,
    publishedAt: last.publishedAt ? new Date(last.publishedAt).toISOString() : null,
    createdAt: new Date(last.createdAt).toISOString(),
    reactionCount: sort === "hot" ? Number(last.reactionCount || 0) : undefined,
    commentCount: sort === "hot" ? Number(last.commentCount || 0) : undefined,
  });
}

export async function registerCommunityPostRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;
  const featureConfig = loadCommunityFeatureConfig(process.env);

  if (!featureConfig.enabled) return;

  fastify.get("/community/posts", async (req: any, reply) => {
    const parsed = listPostsQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_community_query", details: parsed.error.issues });
    const cursor = decodeCursor(parsed.data.cursor);
    if (parsed.data.cursor && !cursor) return reply.status(400).send({ error: "invalid_community_cursor", message: "分页游标无效或已过期。" });
    const [items, platformSeo] = await Promise.all([
      prisma.communityPost.findMany({
        where: buildListWhere(parsed.data.sort, cursor),
        include: {
          author: { select: { id: true, displayName: true, photoUrl: true } },
          assets: true,
        },
        orderBy: buildListOrder(parsed.data.sort) as any,
        take: parsed.data.limit + 1,
      }),
      loadPlatformSeo(prisma),
    ]);
    const hasMore = items.length > parsed.data.limit;
    const pageItems = items.slice(0, parsed.data.limit);
    return {
      items: await Promise.all(pageItems.map((row: any) => serializeCommunityPost(row, { viewerUserId: (req as any).userId || null, platformSeo }))),
      nextCursor: hasMore ? nextListCursor(pageItems, parsed.data.sort) : null,
      sort: parsed.data.sort,
      capabilities: {
        postingEnabled: featureConfig.postingEnabled,
        imageUploadEnabled: featureConfig.imageUploadEnabled,
        videoUploadEnabled: false,
      },
    };
  });

  fastify.get<{ Params: { id: string } }>("/community/posts/:id", async (req: any, reply) => {
    const row = await requireReadablePost(prisma, String(req.params?.id || "").trim(), (req as any).userId || null);
    if (!row) return reply.status(404).send({ error: "community_post_not_found", message: "圈子帖子不存在或暂不可见。" });
    const platformSeo = await loadPlatformSeo(prisma);
    return serializeCommunityPost(row, {
      viewerUserId: (req as any).userId || null,
      includeRejectedReason: true,
      platformSeo,
    });
  });

  if (featureConfig.postingEnabled) fastify.post("/community/posts", async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = createPostSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_community_post", details: parsed.error.issues });
    try {
      await assertPostRateLimit(prisma, userId);
    } catch (error: any) {
      if (error?.statusCode && error?.payload) return reply.status(error.statusCode).send(error.payload);
      throw error;
    }
    const body = normalizeCommunityBody(parsed.data.body);
    const topics = normalizeCommunityTopics(parsed.data.topics);
    const row = await prisma.communityPost.create({
      data: {
        authorId: userId,
        body,
        topics,
        status: "pending",
      },
      include: {
        author: { select: { id: true, displayName: true, photoUrl: true } },
        assets: true,
      },
    });
    const platformSeo = await loadPlatformSeo(prisma);
    return reply.status(201).send({
      ok: true,
      post: await serializeCommunityPost(row, { viewerUserId: userId, includeRejectedReason: true, platformSeo }),
    });
  });

  if (featureConfig.postingEnabled) fastify.patch<{ Params: { id: string } }>("/community/posts/:id", async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = updatePostSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_community_post", details: parsed.error.issues });
    const before = await prisma.communityPost.findUnique({ where: { id: req.params.id }, include: { author: true, assets: true } });
    if (!before || before.deletedAt) return reply.status(404).send({ error: "community_post_not_found", message: "圈子帖子不存在。" });
    if (before.authorId !== userId) return reply.status(403).send({ error: "community_post_forbidden", message: "仅作者可编辑圈子帖子。" });
    if (String(before.status) !== "pending" && String(before.status) !== "rejected") {
      return reply.status(409).send({ error: "community_post_not_editable", message: "仅待审核或已驳回帖子可编辑。" });
    }
    const row = await prisma.communityPost.update({
      where: { id: before.id },
      data: {
        body: normalizeCommunityBody(parsed.data.body),
        topics: normalizeCommunityTopics(parsed.data.topics),
        status: "pending",
        moderationReason: null,
        searchIndexable: false,
      },
      include: {
        author: { select: { id: true, displayName: true, photoUrl: true } },
        assets: true,
      },
    });
    const platformSeo = await loadPlatformSeo(prisma);
    return { ok: true, post: await serializeCommunityPost(row, { viewerUserId: userId, includeRejectedReason: true, platformSeo }) };
  });

  if (featureConfig.postingEnabled) fastify.delete<{ Params: { id: string } }>("/community/posts/:id", async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const before = await prisma.communityPost.findUnique({ where: { id: req.params.id } });
    if (!before || before.deletedAt) return reply.status(404).send({ error: "community_post_not_found", message: "圈子帖子不存在。" });
    if (before.authorId !== userId) return reply.status(403).send({ error: "community_post_forbidden", message: "仅作者可删除自己的圈子帖子。" });
    await prisma.communityPost.update({
      where: { id: before.id },
      data: {
        status: "removed",
        deletedAt: new Date(),
      },
    });
    return { ok: true };
  });

  fastify.get("/community/me/posts", async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = myPostsQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_community_query", details: parsed.error.issues });
    const cursor = decodeCursor(parsed.data.cursor);
    if (parsed.data.cursor && !cursor) return reply.status(400).send({ error: "invalid_community_cursor", message: "分页游标无效或已过期。" });
    const where: any = {
      authorId: userId,
      deletedAt: null,
    };
    if (cursor) {
      where.OR = [
        { createdAt: { lt: new Date(cursor.createdAt) } },
        { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
      ];
    }
    const [items, platformSeo] = await Promise.all([
      prisma.communityPost.findMany({
        where,
        include: {
          author: { select: { id: true, displayName: true, photoUrl: true } },
          assets: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: parsed.data.limit + 1,
      }),
      loadPlatformSeo(prisma),
    ]);
    const hasMore = items.length > parsed.data.limit;
    const pageItems = items.slice(0, parsed.data.limit);
    return {
      items: await Promise.all(pageItems.map((row: any) => serializeCommunityPost(row, {
        viewerUserId: userId,
        includeRejectedReason: true,
        platformSeo,
      }))),
      nextCursor: hasMore ? nextListCursor(pageItems, "new") : null,
    };
  });
}

export async function loadCommunityPostForSeo(prisma: any, postId: string) {
  return prisma.communityPost.findUnique({
    where: { id: postId },
    include: {
      author: { select: { id: true, displayName: true, photoUrl: true } },
      assets: true,
    },
  });
}
