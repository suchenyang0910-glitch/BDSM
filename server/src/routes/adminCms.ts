import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireAdmin, type AdminSession } from "./admin.js";
import { adminHasPermission } from "../services/authAdmin.js";
import { resolvePackageChannelId, resolveContentChannelId } from "../services/channelCrypto.js";
import {
  refMembershipMain,
  refRawChatId,
  type ChannelRef,
  chatIdFingerprint,
  maskChatIdSafe,
} from "../services/telegramBot.js";
import { emitSafetyEvent } from "../utils/structuredError.js";
import {
  isValidFreeChannelCode,
  listPublicFreeChannelOptions,
  refFreeChannelByCode,
  getFreeChannelEntry,
} from "../services/freeChannels.js";
import {
  createPresignedPutUpload,
  headObject,
  deleteObjectSafe,
  makePublicUrl,
  objectStorageBackend,
  requireObjectStorageEnv,
  generateStorageKey,
} from "../services/objectStorage.js";
import {
  initTelegramPublisher,
  getPublishQueueHandle,
  buildPreviewVideoCaption,
} from "../services/telegramPublisher.js";
import { randomBytes, createHash } from "node:crypto";

const ContentStatusZ = z.enum(["draft", "pending_review", "published", "archived", "scheduled"]);
const BannerStatusZ = z.enum(["draft", "active", "inactive", "scheduled", "archived"]);
const BannerTargetTypeZ = z.enum(["none", "content", "category", "product", "external", "package"]);

function adminMeta(req: FastifyRequest) {
  const sess = (req as any).admin as AdminSession;
  return {
    adminId: sess.adminId,
    adminRole: sess.role,
    adminEmail: sess.email,
    ip: (req.ip as string) || null,
    ua: (req.headers["user-agent"] as string) || null,
  };
}

function writeAudit(
  prisma: any,
  meta: ReturnType<typeof adminMeta>,
  action: string,
  objectType: string,
  objectId: string,
  beforeValue: any,
  afterValue: any,
  reason?: string | null,
) {
  return prisma.adminAuditLog.create({
    data: {
      adminId: meta.adminId,
      action,
      objectType,
      objectId,
      beforeValue: beforeValue == null ? null : (typeof beforeValue === "string" ? beforeValue : beforeValue),
      afterValue: afterValue == null ? null : (typeof afterValue === "string" ? afterValue : afterValue),
      reason: reason ?? null,
      ipAddress: meta.ip,
      userAgent: meta.ua,
    },
  });
}

function serialize(v: any) {
  if (v == null) return null;
  return JSON.parse(JSON.stringify(v));
}

function stripSensitiveFields(v: any): any {
  if (v == null) return v;
  const copy = serialize(v);
  if (Array.isArray(copy)) {
    return copy.map((item) => stripSensitiveFields(item));
  }
  if (copy && typeof copy === "object") {
    if ("channelId" in copy) delete copy.channelId;
    if ("inviteLink" in copy) delete copy.inviteLink;
    for (const k of Object.keys(copy)) copy[k] = stripSensitiveFields(copy[k]);
  }
  return copy;
}

type AccessTypeBound = "public" | "single" | "membership" | "package";
interface ContentAccessValidationContext {
  prisma: PrismaClient;
  accessType: AccessTypeBound;
  packageId?: string | null;
  productId?: string | null;
  freeChannelCode?: string | null;
  coverAssetId?: string | null;
  previewAssetId?: string | null;
  fullVideoAssetId?: string | null;
}

async function validateContentAccessTypeConstraints(ctx: ContentAccessValidationContext): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string; message?: string; details?: any }
> {
  const { prisma, accessType, packageId, productId, freeChannelCode, coverAssetId, previewAssetId, fullVideoAssetId } = ctx;

  if (accessType === "single") {
    return {
      ok: false,
      status: 409,
      error: "single_delivery_not_enabled",
      message:
        "单篇购买（single）首期不支持：共享 VIP 频道无法做到只开放单条内容，会造成权益越界。请改为 membership 或 package 类型。",
    };
  }

  // —— FK 基础校验：如传入 assetId，必须是存在且 status=ready（避免引用不存在/未完成上传的素材）
  const fkChecks: Array<{ key: "coverAssetId" | "previewAssetId" | "fullVideoAssetId"; id: string | null | undefined; expectedKind?: "cover_image" | "preview_video" | "full_video" }> = [
    { key: "coverAssetId", id: coverAssetId, expectedKind: "cover_image" },
    { key: "previewAssetId", id: previewAssetId, expectedKind: "preview_video" },
    { key: "fullVideoAssetId", id: fullVideoAssetId, expectedKind: "full_video" },
  ];
  for (const fk of fkChecks) {
    if (!fk.id) continue;
    const a = await prisma.mediaAsset.findUnique({ where: { id: fk.id }, select: { id: true, status: true, kind: true } });
    if (!a) {
      return { ok: false, status: 404, error: `${fk.key}_not_found`, message: `指定的素材不存在（${fk.key}=${fk.id}），请先完成素材上传并校验通过。` };
    }
    if (a.status !== "ready") {
      return { ok: false, status: 409, error: `${fk.key}_not_ready`, message: `素材尚未完成上传或校验失败（当前 status=${a.status}）。请先完成上传并点击校验通过。` };
    }
    if (fk.expectedKind && a.kind !== fk.expectedKind) {
      return { ok: false, status: 409, error: `${fk.key}_kind_mismatch`, message: `素材类型不匹配：${fk.key} 必须是 ${fk.expectedKind}，实际为 ${a.kind}。` };
    }
  }

  // —— 强业务矩阵校验：accessType × 素材
  if (accessType === "public") {
    if (fullVideoAssetId) {
      return { ok: false, status: 400, error: "public_forbids_full_video", message: "public（免费预览）类型禁止上传或绑定完整视频；完整视频仅允许在会员/内容包私密频道交付。" };
    }
    if (!previewAssetId) {
      return { ok: false, status: 400, error: "public_requires_preview_asset", message: "public 类型必须上传并绑定试看视频（previewAssetId，30–60 秒并已加水印）。" };
    }
  }

  if (accessType === "package") {
    if (!packageId) {
      return {
        ok: false,
        status: 400,
        error: "package_id_required",
        message: "package 类型必须绑定已发布且已配置受控频道的内容包。",
      };
    }
    const pkg = await prisma.contentPackage.findUnique({
      where: { id: packageId },
      select: {
        id: true,
        status: true,
        channelId: true,
        channelIdCiphertext: true,
        productId: true,
        product: { select: { status: true } },
      },
    });
    if (!pkg) {
      return { ok: false, status: 404, error: "package_not_found", message: "指定的内容包不存在" };
    }
    const pkgChannel = resolvePackageChannelId({
      channelId: pkg.channelId,
      channelIdCiphertext: pkg.channelIdCiphertext,
    });
    const missing: string[] = [];
    if (pkg.status !== "published") missing.push("内容包未发布（status 必须为 published）");
    if (pkgChannel == null) missing.push("内容包未配置交付频道（需服务端完成受控映射，channelId 不能为空）");
    if (pkg.productId && pkg.product?.status !== "active") missing.push("内容包对应商品未启用（product.status 必须为 active）");
    if (missing.length > 0) {
      return {
        ok: false,
        status: 409,
        error: "package_not_ready",
        message: "内容包暂不可交付",
        details: missing,
      };
    }
  }

  if (accessType === "membership" && !fullVideoAssetId) {
    return { ok: false, status: 400, error: "membership_requires_full_video", message: "会员交付内容必须上传并绑定完整视频（fullVideoAssetId）。" };
  }
  if (accessType === "package" && !fullVideoAssetId) {
    return { ok: false, status: 400, error: "package_requires_full_video", message: "内容包交付内容必须上传并绑定完整视频（fullVideoAssetId）。" };
  }

  if (accessType === "membership") {
    if (packageId) {
      return {
        ok: false,
        status: 400,
        error: "membership_must_not_bind_package",
        message: "会员内容不得绑定 packageId；会员频道由服务端受控统一交付。",
      };
    }
  }

  if (accessType === "public") {
    if (packageId) {
      return {
        ok: false,
        status: 400,
        error: "public_must_not_bind_package",
        message: "公开内容不得绑定收费内容包 packageId。",
      };
    }
    if (!freeChannelCode || typeof freeChannelCode !== "string") {
      return {
        ok: false,
        status: 400,
        error: "free_channel_code_required",
        message: "公开内容必须选择免费频道（只能从白名单枚举选，不能自定义 channelId）。",
      };
    }
    if (!isValidFreeChannelCode(freeChannelCode)) {
      return {
        ok: false,
        status: 400,
        error: "free_channel_code_not_in_whitelist",
        message: `免费频道编码不在白名单：${freeChannelCode}。请从白名单选择：${listPublicFreeChannelOptions().map((c) => c.code).join(" / ")}。`,
      };
    }
  }

  void productId;
  return { ok: true };
}

async function validatePublishReady(
  prisma: PrismaClient,
  contentId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string; message?: string; details?: any }> {
  const row = await prisma.content.findUnique({
    where: { id: contentId },
    select: {
      accessType: true,
      packageId: true,
      productId: true,
      freeChannelCode: true,
      coverAssetId: true,
      previewAssetId: true,
      fullVideoAssetId: true,
    },
  });
  if (!row) return { ok: false, status: 404, error: "not_found", message: "内容不存在" };
  return validateContentAccessTypeConstraints({
    prisma,
    accessType: row.accessType as AccessTypeBound,
    packageId: row.packageId,
    productId: row.productId,
    freeChannelCode: row.freeChannelCode,
    coverAssetId: row.coverAssetId,
    previewAssetId: row.previewAssetId,
    fullVideoAssetId: row.fullVideoAssetId,
  });
}

export default async function adminCmsRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma as PrismaClient;
  const SENSITIVE_MASK = "******";
  const ZID = z.string().trim().min(1).max(64);

  // 【P0-素材上传发布】初始化 Bot 发布队列（BullMQ + Redis，缺 REDIS_URL 自动回退 DB 轮询）
  try {
    await initTelegramPublisher(fastify);
  } catch (err) {
    emitSafetyEvent({ event: "admin_init_publisher_failed", errorClass: "publisher_init_error", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
  }

  // ===========================================================================
  // CONTENTS (Step 1 BE-R1)
  // ===========================================================================
  const ZCONTENT_CREATE = z.object({
    title: z.string().trim().min(1).max(200),
    coverUrl: z.string().trim().url().max(500).optional().nullable(),
    thumbnailUrl: z.string().trim().url().max(500).optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
    tags: z.array(z.string().max(50)).optional().default([]),
    previewUrl: z.string().trim().max(500).optional().nullable(),
    durationSeconds: z.number().int().min(0).optional().nullable(),
    accessType: z.enum(["public", "single", "membership", "package"]).optional().default("single"),
    freeChannelCode: z.string().max(64).trim().optional().nullable(),
    coverAssetId: ZID.optional().nullable(),
    previewAssetId: ZID.optional().nullable(),
    fullVideoAssetId: ZID.optional().nullable(),
    isRecommended: z.boolean().optional().default(false),
    isFeatured: z.boolean().optional().default(false),
    isNewArrival: z.boolean().optional().default(false),
    featuredSort: z.number().int().optional().nullable(),
    sortOrder: z.number().int().min(0).optional().default(0),
    recommendStartsAt: z.string().datetime().optional().nullable(),
    recommendEndsAt: z.string().datetime().optional().nullable(),
    scheduledAt: z.string().datetime().optional().nullable(),
    packageId: ZID.optional().nullable(),
    productId: ZID.optional().nullable(),
    categoryIds: z.array(ZID).optional().default([]),
    reason: z.string().max(500).optional(),
  });
  const ZCONTENT_EDIT = ZCONTENT_CREATE.partial().extend({ id: ZID });
  const ZCATEGORY_SET = z.object({ categoryIds: z.array(ZID), reason: z.string().max(500).optional() });
  const ZSTATUS_ACTION = z.object({ reason: z.string().max(500).optional() });
  const ZCONTENT_QP = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    status: z.string().optional(),
    categoryId: ZID.optional(),
    q: z.string().optional(),
    accessType: z.string().optional(),
  });
  const ZAUDIT_REASON = z.object({ reason: z.string().max(500).optional() });
  const ZPUBLISH_VIDEO = z.object({
    videoFileId: z.string().trim().min(1).max(512),
    thumbnailFileId: z.string().trim().max(512).optional().nullable(),
    caption: z.string().max(2048).optional().nullable(),
    supportsStreaming: z.boolean().optional().default(true),
    parseMode: z.enum(["MarkdownV2", "HTML", "Markdown"]).optional().default("HTML"),
    reason: z.string().max(500).optional(),
  });

  const ZREGISTER_TELEGRAM_PUBLISH = z.object({
    telegramMessageId: z.union([z.string().trim().min(1), z.number().int()]),
    telegramChatFingerprint: z.string().trim().max(128).optional().nullable(),
    freeChannelCode: z.string().trim().max(64).optional().nullable(),
    videoFileIdRemark: z.string().trim().max(512).optional().nullable(),
    caption: z.string().max(2048).optional().nullable(),
    reason: z.string().max(500).optional(),
  });

  const ZSTART_PUBLISH = z.object({
    channelKinds: z.array(
      z.enum(["public_free_preview", "membership_full", "package_full"])
    ).min(1).max(6),
    reason: z.string().max(500).optional(),
  });
  const ZPUBLISH_JOBS_QP = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  });

  // —— 免费频道白名单枚举（只暴露 code/label/描述，绝不暴露 chatId）
  fastify.get(
    "/admin/free-channels",
    { preHandler: [requireAdmin("content:view")] },
    async (_req: any, reply) => {
      return reply.send({
        items: listPublicFreeChannelOptions().map((c) => ({
          code: c.code,
          label: c.label,
          description: c.description,
        })),
      });
    },
  );

  fastify.get(
    "/admin/contents",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const qp = ZCONTENT_QP.parse(req.query);
      const where: any = {};
      if (qp.status && ContentStatusZ.safeParse(qp.status).success) where.status = qp.status;
      if (qp.accessType) where.accessType = qp.accessType;
      if (qp.categoryId) where.categories = { some: { categoryId: qp.categoryId } };
      if (qp.q?.trim()) {
        where.OR = [
          { title: { contains: qp.q.trim(), mode: "insensitive" } },
          { description: { contains: qp.q.trim(), mode: "insensitive" } },
        ];
      }
      const [total, rows] = await prisma.$transaction([
        prisma.content.count({ where }),
        prisma.content.findMany({
          where,
          include: {
            categories: { orderBy: { displayOrder: "asc" }, include: { category: true } },
            product: { select: { id: true, title: true, priceMinor: true, currency: true } },
            package: { select: { id: true, title: true } },
            lastEditor: { select: { id: true, email: true, displayName: true } },
          },
          skip: (qp.page - 1) * qp.limit,
          take: qp.limit,
          orderBy: [{ sortOrder: "desc" }, { isFeatured: "desc" }, { isRecommended: "desc" }, { updatedAt: "desc" }],
        }),
      ]);
      return reply.send({
        total, page: qp.page, limit: qp.limit,
        data: rows.map((c: any) => ({
          ...c,
          categories: c.categories.map((x: any) => ({ id: x.categoryId, name: x.category.name, slug: x.category.slug, displayOrder: x.displayOrder })),
        })),
      });
    },
  );

  fastify.get(
    "/admin/contents/:id",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const row = await prisma.content.findUnique({
        where: { id },
        include: {
          categories: { orderBy: { displayOrder: "asc" }, include: { category: true } },
          product: true,
          package: true,
          lastEditor: { select: { id: true, email: true, displayName: true } },
          coverAsset: {
            select: {
              id: true, kind: true, status: true, originalFilename: true, mimeType: true,
              storagePublicUrl: true, contentLength: true, widthPixels: true, heightPixels: true,
              lastVerifiedAt: true, createdAt: true,
            },
          },
          previewAsset: {
            select: {
              id: true, kind: true, status: true, originalFilename: true, mimeType: true,
              storagePublicUrl: true, contentLength: true, durationSeconds: true,
              widthPixels: true, heightPixels: true, hasWatermark: true,
              lastVerifiedAt: true, createdAt: true,
            },
          },
          fullVideoAsset: {
            select: {
              id: true, kind: true, status: true, originalFilename: true, mimeType: true,
              contentLength: true, durationSeconds: true,
              widthPixels: true, heightPixels: true,
              lastVerifiedAt: true, createdAt: true,
            },
          },
        },
      });
      if (!row) return reply.status(404).send({ error: "not_found" });
      return reply.send({
        ...row,
        categories: row.categories.map((x: any) => ({ id: x.categoryId, name: x.category.name, slug: x.category.slug, displayOrder: x.displayOrder })),
      });
    },
  );

  fastify.post(
    "/admin/contents",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const body = ZCONTENT_CREATE.parse(req.body);
      const meta = adminMeta(req);
      const preCheck = await validateContentAccessTypeConstraints({
        prisma,
        accessType: body.accessType as AccessTypeBound,
        packageId: body.packageId,
        productId: body.productId,
        freeChannelCode: body.freeChannelCode,
        coverAssetId: body.coverAssetId ?? null,
        previewAssetId: body.previewAssetId ?? null,
        fullVideoAssetId: body.fullVideoAssetId ?? null,
      });
      if (!preCheck.ok) {
        return reply.status(preCheck.status).send({ error: preCheck.error, message: preCheck.message, details: preCheck.details });
      }
      const { reason, categoryIds, ...payload } = body;
      const parseDates = (d: any) => (d ? new Date(d) : null);

      // 根据 3 FK 查对应 MediaAsset.storagePublicUrl / durationSeconds，回填冗余列（方便不 JOIN 时直接用）
      const assetFk: Array<string | null> = [payload.coverAssetId ?? null, payload.previewAssetId ?? null, payload.fullVideoAssetId ?? null];
      const assets = assetFk.some((x) => x != null)
        ? await prisma.mediaAsset.findMany({
            where: { id: { in: assetFk.filter((x): x is string => x != null) } },
            select: { id: true, kind: true, storagePublicUrl: true, durationSeconds: true },
          })
        : [];
      const am = new Map(assets.map((a) => [a.id, a]));
      const coverAsset = payload.coverAssetId ? am.get(payload.coverAssetId) : undefined;
      const previewAsset = payload.previewAssetId ? am.get(payload.previewAssetId) : undefined;
      const fullAsset = payload.fullVideoAssetId ? am.get(payload.fullVideoAssetId) : undefined;
      const redundantCoverUrl = coverAsset?.storagePublicUrl || null;
      const redundantPreviewUrl = previewAsset?.storagePublicUrl || null;
      const redundantDuration = fullAsset?.durationSeconds ?? previewAsset?.durationSeconds ?? null;

      const data: any = {
        title: payload.title,
        coverUrl: (payload.coverUrl != null ? payload.coverUrl : redundantCoverUrl) ?? null,
        thumbnailUrl: payload.thumbnailUrl ?? null,
        description: payload.description ?? null,
        tags: payload.tags ?? [],
        previewUrl: (payload.previewUrl != null ? payload.previewUrl : redundantPreviewUrl) ?? null,
        durationSeconds: payload.durationSeconds ?? redundantDuration ?? null,
        accessType: payload.accessType,
        isRecommended: payload.isRecommended,
        isFeatured: payload.isFeatured,
        isNewArrival: payload.isNewArrival,
        featuredSort: payload.featuredSort ?? null,
        sortOrder: payload.sortOrder,
        recommendStartsAt: parseDates(payload.recommendStartsAt),
        recommendEndsAt: parseDates(payload.recommendEndsAt),
        scheduledAt: parseDates(payload.scheduledAt),
        packageId: payload.packageId ?? null,
        productId: payload.productId ?? null,
        coverAssetId: payload.coverAssetId ?? null,
        previewAssetId: payload.previewAssetId ?? null,
        fullVideoAssetId: payload.fullVideoAssetId ?? null,
        status: "draft",
        lastEditorId: meta.adminId,
      };
      const result = await prisma.$transaction(async (tx: any) => {
        const created = await tx.content.create({
          data: {
            ...data,
            categories: categoryIds.length
              ? { create: categoryIds.map((cid, i) => ({ categoryId: cid, displayOrder: i, assignedBy: meta.adminId })) }
              : undefined,
          },
          include: { categories: { orderBy: { displayOrder: "asc" } } },
        });
        await writeAudit(
          tx, meta, "content.create", "content", created.id,
          null,
          stripSensitiveFields(created),
          reason,
        );
        return created;
      });
      return reply.status(201).send({ ok: true, id: result.id });
    },
  );

  fastify.patch(
    "/admin/contents/:id",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const body = ZCONTENT_EDIT.omit({ id: true }).parse(req.body);
      const meta = adminMeta(req);
      const { reason, categoryIds, ...payload } = body;
      const before = await prisma.content.findUnique({
        where: { id },
        include: { categories: { orderBy: { displayOrder: "asc" } } },
      });
      if (!before) return reply.status(404).send({ error: "not_found" });

      if (!adminHasPermission(meta.adminRole, "content:publish")) {
        if (before.status === "published") {
          return reply.status(403).send({ error: "forbidden", message: "无权编辑已发布内容，请先下架" });
        }
      }

      const mergedAccessType = (payload.accessType ?? before.accessType) as AccessTypeBound;
      const mergedPackageId = payload.packageId !== undefined ? payload.packageId : before.packageId;
      const mergedProductId = payload.productId !== undefined ? payload.productId : before.productId;
      const mergedFreeChannelCode = payload.freeChannelCode !== undefined ? payload.freeChannelCode : before.freeChannelCode;
      const mergedCoverAssetId = payload.coverAssetId !== undefined ? payload.coverAssetId : before.coverAssetId;
      const mergedPreviewAssetId = payload.previewAssetId !== undefined ? payload.previewAssetId : before.previewAssetId;
      const mergedFullVideoAssetId = payload.fullVideoAssetId !== undefined ? payload.fullVideoAssetId : before.fullVideoAssetId;
      const preCheck = await validateContentAccessTypeConstraints({
        prisma,
        accessType: mergedAccessType,
        packageId: mergedPackageId,
        productId: mergedProductId,
        freeChannelCode: mergedFreeChannelCode,
        coverAssetId: mergedCoverAssetId ?? null,
        previewAssetId: mergedPreviewAssetId ?? null,
        fullVideoAssetId: mergedFullVideoAssetId ?? null,
      });
      if (!preCheck.ok) {
        return reply.status(preCheck.status).send({ error: preCheck.error, message: preCheck.message, details: preCheck.details });
      }

      // 冗余列回填：若显式修改了 asset FK，则取对应 MediaAsset.storagePublicUrl / durationSeconds 同步写回冗余列
      const touchedAssetFks = [
        payload.coverAssetId !== undefined ? (payload.coverAssetId ?? null) : null,
        payload.previewAssetId !== undefined ? (payload.previewAssetId ?? null) : null,
        payload.fullVideoAssetId !== undefined ? (payload.fullVideoAssetId ?? null) : null,
      ];
      const touchedAnyAsset = payload.coverAssetId !== undefined || payload.previewAssetId !== undefined || payload.fullVideoAssetId !== undefined;
      let assetRedundancies: { coverUrl?: string | null; previewUrl?: string | null; durationSeconds?: number | null } | null = null;
      if (touchedAnyAsset) {
        const ids = touchedAssetFks.filter((x): x is string => x != null);
        const rows = ids.length
          ? await prisma.mediaAsset.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, storagePublicUrl: true, durationSeconds: true } })
          : [];
        const rm = new Map(rows.map((r) => [r.id, r]));
        assetRedundancies = {};
        if (payload.coverAssetId !== undefined) {
          assetRedundancies.coverUrl = payload.coverAssetId ? rm.get(payload.coverAssetId)?.storagePublicUrl || null : null;
        }
        if (payload.previewAssetId !== undefined) {
          assetRedundancies.previewUrl = payload.previewAssetId ? rm.get(payload.previewAssetId)?.storagePublicUrl || null : null;
        }
        if (payload.fullVideoAssetId !== undefined || payload.previewAssetId !== undefined) {
          const full = payload.fullVideoAssetId !== undefined
            ? (payload.fullVideoAssetId ? rm.get(payload.fullVideoAssetId)?.durationSeconds ?? null : null)
            : undefined;
          const prev = payload.previewAssetId !== undefined
            ? (payload.previewAssetId ? rm.get(payload.previewAssetId)?.durationSeconds ?? null : null)
            : undefined;
          assetRedundancies.durationSeconds = full !== undefined ? full : prev !== undefined ? prev : before.durationSeconds;
        }
      }

      const data: any = { lastEditorId: meta.adminId };
      for (const k of Object.keys(payload)) {
        const v = (payload as any)[k];
        if (v === undefined) continue;
        if (k === "recommendStartsAt" || k === "recommendEndsAt" || k === "scheduledAt") {
          (data as any)[k] = v ? new Date(v) : null;
        } else {
          (data as any)[k] = v;
        }
      }
      if (assetRedundancies) {
        if (assetRedundancies.coverUrl !== undefined && payload.coverUrl === undefined) data.coverUrl = assetRedundancies.coverUrl;
        if (assetRedundancies.previewUrl !== undefined && payload.previewUrl === undefined) data.previewUrl = assetRedundancies.previewUrl;
        if (assetRedundancies.durationSeconds !== undefined && payload.durationSeconds === undefined) data.durationSeconds = assetRedundancies.durationSeconds;
      }

      const result = await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data,
          include: { categories: { orderBy: { displayOrder: "asc" } } },
        });
        if (Array.isArray(categoryIds)) {
          await tx.contentCategory.deleteMany({ where: { contentId: id } });
          if (categoryIds.length) {
            await tx.contentCategory.createMany({
              data: categoryIds.map((cid, i) => ({ contentId: id, categoryId: cid, displayOrder: i, assignedBy: meta.adminId })),
            });
          }
          after.categories = await tx.contentCategory.findMany({ where: { contentId: id }, orderBy: { displayOrder: "asc" } });
        }
        await writeAudit(tx, meta, "content.update", "content", id, stripSensitiveFields(before), stripSensitiveFields(after), reason);
        return after;
      });
      return reply.send({ ok: true, id: result.id });
    },
  );

  fastify.put(
    "/admin/contents/:id/categories",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const body = ZCATEGORY_SET.parse(req.body);
      const meta = adminMeta(req);
      const before = await prisma.contentCategory.findMany({
        where: { contentId: id },
        orderBy: { displayOrder: "asc" },
      });
      const exists = await prisma.content.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return reply.status(404).send({ error: "not_found" });

      const result = await prisma.$transaction(async (tx: any) => {
        await tx.contentCategory.deleteMany({ where: { contentId: id } });
        const rows = body.categoryIds.length
          ? await tx.contentCategory.createManyAndReturn({
              data: body.categoryIds.map((cid, i) => ({ contentId: id, categoryId: cid, displayOrder: i, assignedBy: meta.adminId })),
            })
          : [];
        await writeAudit(
          tx, meta, "content.set_categories", "content", id,
          serialize(before.map((x: any) => ({ categoryId: x.categoryId, displayOrder: x.displayOrder }))),
          serialize(body.categoryIds),
          body.reason,
        );
        return rows;
      });
      return reply.send({ ok: true, categoryIds: result.map((r: any) => r.categoryId) });
    },
  );

  const submitReviewHandler = async (req: any, reply: any) => {
      const id = ZID.parse(req.params.id);
      const { reason } = ZSTATUS_ACTION.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await prisma.content.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      if (!["draft", "archived"].includes(before.status)) {
        return reply.status(409).send({ error: "bad_status", message: "仅草稿或归档可提交审核" });
      }
      const preCheck = await validatePublishReady(prisma, id);
      if (!preCheck.ok) {
        return reply.status(preCheck.status).send({ error: preCheck.error, message: preCheck.message, details: preCheck.details });
      }
      await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data: { status: "pending_review", lastEditorId: meta.adminId },
        });
        await writeAudit(tx, meta, "content.submit_review", "content", id, stripSensitiveFields(before), stripSensitiveFields(after), reason);
      });
      return reply.send({ ok: true, status: "pending_review" });
    };

  fastify.post(
    "/admin/contents/:id/submit_for_review",
    { preHandler: [requireAdmin("content:edit")] },
    submitReviewHandler,
  );

  fastify.post(
    "/admin/contents/:id/submit_review",
    { preHandler: [requireAdmin("content:edit")] },
    submitReviewHandler,
  );

  fastify.post(
    "/admin/contents/:id/publish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const { reason } = ZSTATUS_ACTION.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await prisma.content.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      if (!["draft", "pending_review", "archived", "scheduled"].includes(before.status)) {
        return reply.status(409).send({ error: "bad_status", message: "当前状态不允许发布" });
      }
      const preCheck = await validatePublishReady(prisma, id);
      if (!preCheck.ok) {
        return reply.status(preCheck.status).send({ error: preCheck.error, message: preCheck.message, details: preCheck.details });
      }
      await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data: { status: "published", publishedAt: new Date(), lastEditorId: meta.adminId },
        });
        await writeAudit(tx, meta, "content.publish", "content", id, stripSensitiveFields(before), stripSensitiveFields(after), reason);
      });
      return reply.send({ ok: true, status: "published" });
    },
  );

  fastify.post(
    "/admin/contents/:id/unpublish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = ZID.parse(req.params.id);
      const { reason } = ZSTATUS_ACTION.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await prisma.content.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      if (before.status !== "published") {
        return reply.status(409).send({ error: "bad_status", message: "仅已发布内容可下架" });
      }
      await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data: { status: "archived", publishedAt: null, lastEditorId: meta.adminId },
        });
        await writeAudit(tx, meta, "content.unpublish", "content", id, stripSensitiveFields(before), stripSensitiveFields(after), reason);
      });
      return reply.send({ ok: true, status: "archived" });
    },
  );

  // 解析内容对应的目标交付频道 ChannelRef（按 accessType 分派；明文 chatId 内部流转不返回）
  async function resolveContentChannelRefForPublish(contentId: string): Promise<
    | { ok: true; ref: ChannelRef; channelCode: string | null; channelLabel: string; chatFingerprint: string; chatMasked: string }
    | { ok: false; status: number; error: string; message?: string; details?: any }
  > {
    const row = await prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        accessType: true,
        freeChannelCode: true,
        packageId: true,
        channelId: true,
        channelIdCiphertext: true,
      },
    });
    if (!row) return { ok: false, status: 404, error: "not_found", message: "内容不存在" };
    let ref: ChannelRef | null = null;
    let channelCode: string | null = null;
    let channelLabel = "";
    switch (row.accessType) {
      case "public": {
        if (!row.freeChannelCode || !isValidFreeChannelCode(row.freeChannelCode)) {
          return {
            ok: false,
            status: 409,
            error: "free_channel_code_required",
            message: "公开内容发布前必须选择合法的免费频道编码。",
          };
        }
        channelCode = row.freeChannelCode;
        try {
          ref = refFreeChannelByCode(row.freeChannelCode);
        } catch (err: any) {
          emitSafetyEvent(
            {
              event: "free_channel_env_resolve_failed",
              errorClass: "business",
              note: `content=${row.id} freeChannelCode=${row.freeChannelCode}`,
            },
            err,
          );
          return {
            ok: false,
            status: 503,
            error: "free_channel_not_configured",
            message: "该免费频道服务端未配置，请稍后重试或联系管理员检查 env",
          } as const;
        }
        const entry = getFreeChannelEntry(row.freeChannelCode);
        channelLabel = entry ? entry.label : `免费:${row.freeChannelCode}`;
        break;
      }
      case "membership": {
        ref = refMembershipMain();
        channelLabel = "会员专属频道";
        break;
      }
      case "package": {
        if (!row.packageId) {
          return { ok: false, status: 409, error: "package_id_required", message: "打包内容未绑定内容包，无法发布到频道。" };
        }
        const pkg = await prisma.contentPackage.findUnique({
          where: { id: row.packageId },
          select: { id: true, title: true, status: true, channelId: true, channelIdCiphertext: true },
        });
        const ch = pkg ? resolvePackageChannelId({ channelId: pkg.channelId, channelIdCiphertext: pkg.channelIdCiphertext }) : null;
        if (!pkg || pkg.status !== "published" || ch == null) {
          return {
            ok: false,
            status: 409,
            error: "package_not_ready",
            message: "内容包未发布或未配置交付频道；需服务端完成受控映射后才能发布视频。",
          };
        }
        ref = refRawChatId(ch);
        channelLabel = `内容包:${pkg.title || pkg.id}`;
        break;
      }
      case "single":
      default:
        return {
          ok: false,
          status: 409,
          error: "single_delivery_not_enabled",
          message: "single（单篇购买）首期不支持发布视频到频道；请改为 membership 或 package 类型。",
        };
    }
    if (!ref) return { ok: false, status: 500, error: "internal", message: "解析目标频道失败" };
    // 拿 fingerprint 对账（需要解析到 chatId，但 ref 携带 rawChatId 可直接用；membership 需要 env 解析）
    let chatId: bigint | null = null;
    try {
      if (ref.kind === "membership_main") {
        const mem = process.env.TELEGRAM_CHANNEL_MEMBERSHIP ?? process.env.MEMBERSHIP_CHANNEL_ID ?? null;
        if (mem) chatId = BigInt(mem);
      } else if (ref.kind === "raw_chat_id_bigint" || ref.kind === "managed_chat_id_bigint") {
        chatId = ref.chatId;
      }
    } catch (_) {
      chatId = null;
    }
    const fingerprint = chatId ? chatIdFingerprint(chatId) : "";
    const masked = chatId ? maskChatIdSafe(chatId) : "pending";
    return { ok: true, ref, channelCode, channelLabel, chatFingerprint: fingerprint, chatMasked: masked };
  }

  async function handleRegisterTelegramPublish(
    id: string,
    reg: {
      telegramMessageId: bigint;
      telegramChatFingerprint?: string | null;
      freeChannelCode?: string | null;
      videoFileIdRemark?: string | null;
      caption?: string | null;
      reason?: string | null;
    },
    meta: ReturnType<typeof adminMeta>,
    reply: any,
  ) {
    const prismaLocal = (adminCmsPrismaHolder as any).prisma as PrismaClient;
    const before = await prismaLocal.content.findUnique({ where: { id } });
    if (!before) return reply.status(404).send({ error: "not_found", message: "内容不存在" });

    if (reg.freeChannelCode && !isValidFreeChannelCode(reg.freeChannelCode)) {
      return reply.status(400).send({
        error: "invalid_free_channel_code",
        userError: "invalid_free_channel_code",
        message: "免费频道编码不在白名单中，请从下拉选择",
      });
    }

    const tgSentAt = new Date();
    const fingerprintToUse: string | null =
      (reg.telegramChatFingerprint && reg.telegramChatFingerprint.trim().length > 0)
        ? reg.telegramChatFingerprint.trim()
        : null;
    const freeCodeToUse = (reg.freeChannelCode && reg.freeChannelCode.trim()) || null;

    let after: any;
    let channelLabelForAudit = "";
    let chatMaskedForAudit = "manual";
    try {
      await prismaLocal.$transaction(async (tx: any) => {
        const updateData: any = {
          telegramMessageId: reg.telegramMessageId,
          telegramSentAt: tgSentAt,
          telegramChatFingerprint: fingerprintToUse,
          lastEditorId: meta.adminId,
        };
        if (freeCodeToUse) updateData.freeChannelCode = freeCodeToUse;
        after = await tx.content.update({ where: { id }, data: updateData });

        const resolved = await resolveContentChannelRefForPublish(id);
        if (resolved.ok) {
          channelLabelForAudit = resolved.channelLabel || before.title || id;
          chatMaskedForAudit = resolved.chatMasked || chatMaskedForAudit;
        } else {
          channelLabelForAudit = before.title || id;
        }

        const beforeAudit = stripSensitiveFields(before);
        const afterAudit = stripSensitiveFields(after);
        const extra: any = {
          mode: "manual_register",
          channelLabel: channelLabelForAudit,
          freeChannelCode: freeCodeToUse || null,
          chatMasked: chatMaskedForAudit,
          chatFingerprint: fingerprintToUse,
          messageId: reg.telegramMessageId.toString(),
          videoFileIdRemark: reg.videoFileIdRemark || null,
          caption: reg.caption || null,
        };
        (beforeAudit as any)._publishContext = null;
        (afterAudit as any)._publishContext = extra;
        await writeAudit(
          tx,
          meta,
          "content.register_telegram_publish",
          "content",
          id,
          beforeAudit,
          afterAudit,
          reg.reason || `登记 Telegram 已发布视频（messageId=${reg.telegramMessageId.toString()}）`,
        );
      });
    } catch (err: any) {
      emitSafetyEvent(
        {
          event: "tg_publish_register_failed",
          errorClass: "business",
          adminId: meta.adminId,
          note: `content=${id} messageId=${reg.telegramMessageId.toString()}`,
        },
        err,
      );
      return reply.status(500).send({
        error: "tg_publish_register_failed",
        userError: "tg_publish_register_failed",
        message: "登记失败，请确认数据合法后重试",
      });
    }

    return reply.send({
      ok: true,
      registerMode: "manual",
      messageId: reg.telegramMessageId.toString(),
      sentAt: tgSentAt.toISOString(),
      channelLabel: channelLabelForAudit,
      freeChannelCode: freeCodeToUse,
      chatMasked: chatMaskedForAudit,
      chatFingerprint: fingerprintToUse,
      videoFileIdRemark: reg.videoFileIdRemark || null,
    });
  }

  const adminCmsPrismaHolder: any = { prisma: null };

  fastify.post(
    "/admin/contents/:id/publish-to-channel",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      adminCmsPrismaHolder.prisma = prisma;
      const rawBody = req.body || {};
      const meta = adminMeta(req);

      let messageId: bigint;
      let videoFileIdRemark: string | null = null;
      let caption: string | null = null;
      let freeChannelCode: string | null = null;
      let fingerprint: string | null = null;
      let reason: string | null = null;

      if (typeof rawBody.telegramMessageId !== "undefined") {
        const reg = ZREGISTER_TELEGRAM_PUBLISH.parse(rawBody);
        messageId = BigInt(String(reg.telegramMessageId));
        videoFileIdRemark = reg.videoFileIdRemark || null;
        caption = reg.caption || null;
        freeChannelCode = reg.freeChannelCode || null;
        fingerprint = reg.telegramChatFingerprint || null;
        reason = reg.reason || null;
      } else {
        const legacy = ZPUBLISH_VIDEO.parse(rawBody);
        return reply.status(410).send({
          error: "publish_bot_api_deprecated",
          userError: "publish_bot_api_deprecated",
          message:
            "首期发布方式已改为「运营手动上传 Telegram + 后台登记」：请在 Telegram 客户端中手动上传/转发视频至频道，获得 messageId 与频道指纹后到登记表单填写；不再支持直接调用 Bot 上传。",
        });
      }

      return handleRegisterTelegramPublish(
        id,
        {
          telegramMessageId: messageId,
          telegramChatFingerprint: fingerprint,
          freeChannelCode,
          videoFileIdRemark,
          caption,
          reason,
        },
        meta,
        reply,
      );
    },
  );

  fastify.post(
    "/admin/contents/:id/register-telegram-publish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      adminCmsPrismaHolder.prisma = prisma;
      const body = ZREGISTER_TELEGRAM_PUBLISH.parse(req.body || {});
      const meta = adminMeta(req);
      const messageId = BigInt(String(body.telegramMessageId));
      return handleRegisterTelegramPublish(
        id,
        {
          telegramMessageId: messageId,
          telegramChatFingerprint: body.telegramChatFingerprint || null,
          freeChannelCode: body.freeChannelCode || null,
          videoFileIdRemark: body.videoFileIdRemark || null,
          caption: body.caption || null,
          reason: body.reason || null,
        },
        meta,
        reply,
      );
    },
  );

  // ===========================================================================
  // CATEGORIES (Step 2 left)
  // ===========================================================================
  const ZCAT_CREATE = z.object({
    name: z.string().trim().min(1).max(100),
    slug: z.string().trim().min(1).max(80),
    iconUrl: z.string().max(500).optional().nullable(),
    sortOrder: z.number().int().min(0).optional().default(0),
    status: z.enum(["active", "inactive", "archived"]).optional().default("active"),
    reason: z.string().max(500).optional(),
  });
  const ZCAT_EDIT = ZCAT_CREATE.partial().extend({ id: z.string().uuid() });

  fastify.get(
    "/admin/categories",
    { preHandler: [requireAdmin("category:view")] },
    async (_req, reply) => {
      const rows = await prisma.category.findMany({
        orderBy: [{ sortOrder: "desc" }, { createdAt: "asc" }],
        include: { _count: { select: { contents: true } } },
      });
      return reply.send({
        data: rows.map((r: any) => ({ ...r, contentCount: r._count?.contents || 0 })),
      });
    },
  );

  fastify.post(
    "/admin/categories",
    { preHandler: [requireAdmin("category:edit")] },
    async (req: any, reply) => {
      const body = ZCAT_CREATE.parse(req.body);
      const meta = adminMeta(req);
      const { reason, ...payload } = body;
      const res = await prisma.$transaction(async (tx: any) => {
        const cr = await tx.category.create({ data: payload });
        await writeAudit(tx, meta, "category.create", "category", cr.id, null, serialize(cr), reason);
        return cr;
      });
      return reply.status(201).send({ ok: true, id: res.id });
    },
  );

  fastify.patch(
    "/admin/categories/:id",
    { preHandler: [requireAdmin("category:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZCAT_EDIT.omit({ id: true }).parse(req.body);
      const meta = adminMeta(req);
      const { reason, ...payload } = body;
      const before = await prisma.category.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      const data: any = {};
      for (const k of Object.keys(payload)) if ((payload as any)[k] !== undefined) (data as any)[k] = (payload as any)[k];
      const result = await prisma.$transaction(async (tx: any) => {
        const after = await tx.category.update({ where: { id }, data });
        await writeAudit(tx, meta, "category.update", "category", id, serialize(before), serialize(after), reason);
        return after;
      });
      return reply.send({ ok: true, id: result.id });
    },
  );

  fastify.delete(
    "/admin/categories/:id",
    { preHandler: [requireAdmin("category:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const { reason } = ZAUDIT_REASON.parse(req.query || {});
      const meta = adminMeta(req);
      const before = await prisma.category.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      const relatedCount = await prisma.contentCategory.count({ where: { categoryId: id } });
      if (relatedCount > 0) {
        return reply.status(409).send({ error: "not_empty", message: "该分类下仍有关联内容，先清空后删除" });
      }
      await prisma.$transaction(async (tx: any) => {
        await tx.category.delete({ where: { id } });
        await writeAudit(tx, meta, "category.delete", "category", id, serialize(before), null, reason);
      });
      return reply.send({ ok: true });
    },
  );

  // ===========================================================================
  // BANNERS (Step 2 right) — slot/sort/status/startsAt/endsAt + safe response
  // ===========================================================================
  const ZBAN_CREATE = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(500).optional().nullable(),
    imageUrl: z.string().trim().url().max(500).optional().nullable(),
    actionLabel: z.string().max(40).optional().default("查看"),
    slot: z.string().max(32).optional().default("home_top"),
    targetType: BannerTargetTypeZ.optional().default("none"),
    targetId: z.string().max(128).optional().nullable(),
    externalUrl: z.string().max(1000).optional().nullable(),
    status: BannerStatusZ.optional().default("draft"),
    sortOrder: z.number().int().min(0).optional().default(0),
    startsAt: z.string().datetime().optional().nullable(),
    endsAt: z.string().datetime().optional().nullable(),
    categoryId: z.string().uuid().optional().nullable(),
    reason: z.string().max(500).optional(),
  });
  const ZBAN_EDIT = ZBAN_CREATE.partial().extend({ id: z.string().uuid() });

  function stripBanner(row: any) {
    return { ...row };
  }

  fastify.get(
    "/admin/banners",
    { preHandler: [requireAdmin("homepage:view")] },
    async (_req, reply) => {
      const rows = await prisma.banner.findMany({
        orderBy: [{ slot: "asc" }, { sortOrder: "desc" }, { updatedAt: "desc" }],
      });
      return reply.send({ data: rows.map((r: any) => stripBanner(r)) });
    },
  );

  fastify.post(
    "/admin/banners",
    { preHandler: [requireAdmin("homepage:edit")] },
    async (req: any, reply) => {
      const body = ZBAN_CREATE.parse(req.body);
      const meta = adminMeta(req);
      const { reason, startsAt, endsAt, ...payload } = body;
      const res = await prisma.$transaction(async (tx: any) => {
        const cr = await tx.banner.create({
          data: {
            ...payload,
            startsAt: startsAt ? new Date(startsAt) : null,
            endsAt: endsAt ? new Date(endsAt) : null,
          },
        });
        await writeAudit(tx, meta, "banner.create", "banner", cr.id, null, serialize(cr), reason);
        return cr;
      });
      return reply.status(201).send({ ok: true, id: res.id });
    },
  );

  fastify.patch(
    "/admin/banners/:id",
    { preHandler: [requireAdmin("homepage:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZBAN_EDIT.omit({ id: true }).parse(req.body);
      const meta = adminMeta(req);
      const { reason, startsAt, endsAt, ...payload } = body;
      const before = await prisma.banner.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      const data: any = {};
      for (const k of Object.keys(payload)) {
        const v = (payload as any)[k];
        if (v === undefined) continue;
        (data as any)[k] = v;
      }
      if (startsAt !== undefined) data.startsAt = startsAt ? new Date(startsAt) : null;
      if (endsAt !== undefined) data.endsAt = endsAt ? new Date(endsAt) : null;
      const result = await prisma.$transaction(async (tx: any) => {
        const after = await tx.banner.update({ where: { id }, data });
        await writeAudit(tx, meta, "banner.update", "banner", id, serialize(before), serialize(after), reason);
        return after;
      });
      return reply.send({ ok: true, id: result.id });
    },
  );

  fastify.delete(
    "/admin/banners/:id",
    { preHandler: [requireAdmin("homepage:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const { reason } = ZAUDIT_REASON.parse(req.query || {});
      const meta = adminMeta(req);
      const before = await prisma.banner.findUnique({ where: { id } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      await prisma.$transaction(async (tx: any) => {
        await tx.banner.delete({ where: { id } });
        await writeAudit(tx, meta, "banner.delete", "banner", id, serialize(before), null, reason);
      });
      return reply.send({ ok: true });
    },
  );

  // ===========================================================================
  // HOMEPAGE PUBLISH (Step 3 BE-R4) — single version published only
  // ===========================================================================
  const ZHOME_CONFIG = z.object({
    bannerIds: z.array(z.string().uuid()).max(50).optional().default([]),
    recommendContentIds: z.array(z.string().uuid()).max(100).optional().default([]),
    featuredContentIds: z.array(z.string().uuid()).max(50).optional().default([]),
    categoryOrderIds: z.array(z.string().uuid()).max(50).optional().default([]),
  });
  const ZHOME_DRAFT_PUT = z.object({
    versionLabel: z.string().max(80).optional().nullable(),
    note: z.string().max(500).optional().nullable(),
    config: ZHOME_CONFIG,
    reason: z.string().max(500).optional(),
  });
  const ZHOME_PUBLISH = z.object({
    id: z.string().uuid(),
    versionLabel: z.string().max(80).optional().nullable(),
    publishedNote: z.string().max(500).optional().nullable(),
    reason: z.string().max(500).optional(),
  });

  fastify.get(
    "/admin/homepage/draft",
    { preHandler: [requireAdmin("homepage:view")] },
    async (_req, reply) => {
      const draft = await prisma.homepageVersion.findFirst({
        where: { status: "draft" },
        orderBy: [{ updatedAt: "desc" }],
      });
      return reply.send({ draft: draft ?? null });
    },
  );

  fastify.get(
    "/admin/homepage/published",
    { preHandler: [requireAdmin("homepage:view")] },
    async (_req, reply) => {
      const published = await prisma.homepageVersion.findFirst({
        where: { status: "published" },
        include: { publisher: { select: { id: true, displayName: true, email: true } } },
      });
      const versions = await prisma.homepageVersion.findMany({
        where: { status: { in: ["published", "archived"] } },
        take: 20,
        orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
        include: { publisher: { select: { id: true, displayName: true, email: true } } },
      });
      return reply.send({ published: published ?? null, recent: versions });
    },
  );

  fastify.put(
    "/admin/homepage/draft",
    { preHandler: [requireAdmin("homepage:edit")] },
    async (req: any, reply) => {
      const body = ZHOME_DRAFT_PUT.parse(req.body);
      const meta = adminMeta(req);
      const before = await prisma.homepageVersion.findFirst({
        where: { status: "draft" },
        orderBy: [{ updatedAt: "desc" }],
      });

      const result = await prisma.$transaction(async (tx: any) => {
        let after;
        if (!before) {
          after = await tx.homepageVersion.create({
            data: {
              status: "draft",
              versionLabel: body.versionLabel ?? null,
              note: body.note ?? null,
              config: body.config,
            },
          });
        } else {
          after = await tx.homepageVersion.update({
            where: { id: before.id },
            data: {
              versionLabel: body.versionLabel ?? null,
              note: body.note ?? null,
              config: body.config,
            },
          });
        }
        await writeAudit(
          tx, meta,
          before ? "homepage.update_draft" : "homepage.create_draft",
          "homepage", after.id,
          serialize(before?.config ?? null),
          serialize(after.config),
          body.reason,
        );
        return after;
      });
      return reply.send({ ok: true, id: result.id });
    },
  );

  fastify.post(
    "/admin/homepage/publish",
    { preHandler: [requireAdmin("homepage:publish")] },
    async (req: any, reply) => {
      const body = ZHOME_PUBLISH.parse(req.body);
      const meta = adminMeta(req);
      const beforeDraft = await prisma.homepageVersion.findUnique({ where: { id: body.id } });
      if (!beforeDraft) return reply.status(404).send({ error: "not_found" });
      if (beforeDraft.status === "published") {
        return reply.status(409).send({ error: "already_published", message: "该版本已经发布" });
      }
      const config = beforeDraft.config as any;

      const [banns, rec, feat, cats] = await Promise.all([
        config?.bannerIds?.length ? prisma.banner.count({ where: { id: { in: config.bannerIds } } }) : Promise.resolve(0),
        config?.recommendContentIds?.length ? prisma.content.count({ where: { id: { in: config.recommendContentIds } } }) : Promise.resolve(0),
        config?.featuredContentIds?.length ? prisma.content.count({ where: { id: { in: config.featuredContentIds } } }) : Promise.resolve(0),
        config?.categoryOrderIds?.length ? prisma.category.count({ where: { id: { in: config.categoryOrderIds } } }) : Promise.resolve(0),
      ]);
      const errors: string[] = [];
      if (banns !== (config?.bannerIds?.length || 0)) errors.push("banner 存在无效 ID");
      if (rec !== (config?.recommendContentIds?.length || 0)) errors.push("recommend 存在无效内容 ID");
      if (feat !== (config?.featuredContentIds?.length || 0)) errors.push("featured 存在无效内容 ID");
      if (cats !== (config?.categoryOrderIds?.length || 0)) errors.push("category 存在无效分类 ID");
      if (errors.length) return reply.status(400).send({ error: "invalid_refs", details: errors });

      const now = new Date();
      const result = await prisma.$transaction(async (tx: any) => {
        const prev = await tx.homepageVersion.findFirst({ where: { status: "published" } });
        if (prev) {
          await tx.homepageVersion.update({ where: { id: prev.id }, data: { status: "archived" } });
        }
        const published = await tx.homepageVersion.update({
          where: { id: body.id },
          data: {
            status: "published",
            publishedAt: now,
            publishedBy: meta.adminId,
            versionLabel: body.versionLabel ?? beforeDraft.versionLabel,
            publishedNote: body.publishedNote ?? null,
          },
        });
        await writeAudit(tx, meta, "homepage.publish", "homepage", published.id, serialize(beforeDraft), serialize(published), body.reason);
        if (prev) {
          await writeAudit(
            tx, meta, "homepage.archive_published", "homepage", prev.id,
            "published", "archived",
            `自动归档：被新版本 ${published.id} 替换`,
          );
        }
        return published;
      });
      return reply.send({ ok: true, id: result.id, publishedAt: result.publishedAt });
    },
  );

  // ===========================================================================
  // MEDIA ASSETS (P0 S1：上传素材封面/试看/完整视频 → 预签名 URL 浏览器直传)
  // 权限：content:edit / content:publish
  // ===========================================================================
  const ZKIND = z.enum(["cover_image", "preview_video", "full_video"]);
  const ZMEDIA_INIT = z.object({
    kind: ZKIND,
    originalFilename: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(128),
    contentLength: z.number().int().min(1),
    expectedChecksumSha256: z.string().trim().max(128).optional().nullable(),
    note: z.string().max(500).optional().nullable(),
  });
  const ZMEDIA_COMPLETE = z.object({
    ok: z.boolean(),
    etag: z.string().max(128).optional().nullable(),
    reportedContentLength: z.number().int().min(0).optional().nullable(),
    reportedChecksumSha256: z.string().max(128).optional().nullable(),
    error: z.string().max(256).optional().nullable(),
    reason: z.string().max(500).optional(),
  });
  const ZMEDIA_STATUS_DELETE_REASON = z.object({ reason: z.string().max(500).optional() });

  fastify.post(
    "/admin/media/init-upload",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const body = ZMEDIA_INIT.parse(req.body);
      const meta = adminMeta(req);
      let storage: ReturnType<typeof requireObjectStorageEnv> | null = null;
      try {
        storage = requireObjectStorageEnv();
      } catch (e) {
        emitSafetyEvent({ event: "media_init_upload_env_missing", errorClass: "exhausted", adminId: meta.adminId, retryHint: 0 });
        return reply.status(503).send({ error: "object_storage_unavailable", userError: "对象存储服务未上线，请联系技术支持" });
      }
      if (body.contentLength > 8 * 1024 * 1024 * 1024) {
        return reply.status(400).send({ error: "file_too_large", userError: "文件大小上限 8GB，请分块或压缩后再试" });
      }
      if (body.kind === "cover_image" && body.contentLength > 20 * 1024 * 1024) {
        return reply.status(400).send({ error: "cover_too_large", userError: "封面图片大小上限 20MB" });
      }
      if (body.kind === "preview_video" && body.contentLength > 800 * 1024 * 1024) {
        return reply.status(400).send({ error: "preview_too_large", userError: "试看视频大小上限 800MB（建议 30–60 秒有水印 H.264）" });
      }
      const id = cryptoRandomUuid();
      let signed: Awaited<ReturnType<typeof createPresignedPutUpload>>;
      try {
        signed = await createPresignedPutUpload({
          kind: body.kind,
          originalFilename: body.originalFilename,
          mimeType: body.mimeType,
          contentLength: body.contentLength,
          expectedChecksumSha256: body.expectedChecksumSha256 || null,
          adminId: meta.adminId,
          note: body.note || null,
        });
      } catch (e) {
        emitSafetyEvent({ event: "media_init_upload_presign_failed", errorClass: "unknown", adminId: meta.adminId, retryHint: 1, note: `kind=${body.kind} len=${body.contentLength}` });
        return reply.status(503).send({ error: "object_storage_presign_failed", userError: "对象存储服务暂不可用，请稍后重试" });
      }
      const backend = objectStorageBackend();
      const asset = await prisma.$transaction(async (tx: any) => {
        const row = await tx.mediaAsset.create({
          data: {
            id,
            kind: body.kind,
            status: "uploading",
            storageBackend: backend,
            ownerAdminId: meta.adminId,
            originalFilename: body.originalFilename,
            mimeType: body.mimeType,
            contentLength: BigInt(body.contentLength),
            checksumSha256: body.expectedChecksumSha256 || null,
            storageBucket: storage!.bucket,
            storageRegion: storage!.region,
            storageKey: signed.key,
            expiresAt: signed.expiresAt,
            note: body.note || null,
          },
        });
        await writeAudit(tx, meta, "media.init_upload", "media_asset", row.id, null, serialize({ kind: row.kind, backend, bucket: storage!.bucket, keyLen: signed.key.length }), body.note || null);
        return row;
      });
      return reply.send({
        mediaAssetId: asset.id,
        uploadUrl: signed.url,
        storageBucket: storage!.bucket,
        storageRegion: storage!.region,
        storageKey: signed.key,
        uploadExpiresAt: signed.expiresAt.toISOString(),
        expectedHttpHeaders: signed.headers,
      });
    },
  );

  fastify.post(
    "/admin/media/:id/complete",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZMEDIA_COMPLETE.parse(req.body);
      const meta = adminMeta(req);
      const asset = await prisma.mediaAsset.findUnique({ where: { id } });
      if (!asset) return reply.status(404).send({ error: "not_found" });
      if (asset.status === "deleted") return reply.status(410).send({ error: "asset_deleted" });
      if (!body.ok || body.error) {
        emitSafetyEvent({
          event: "media_upload_client_reported_failed",
          errorClass: "business",
          adminId: meta.adminId,
          productId: asset.id,
          note: `kind=${asset.kind} client_err_len=${(body.error || "").length}`,
        });
        const updated = await prisma.$transaction(async (tx: any) => {
          const after = await tx.mediaAsset.update({
            where: { id },
            data: { status: "failed", lastErrorClass: null, lastErrorNote: truncateNote(body.error || "client_reported_failed", 500) },
          });
          await writeAudit(tx, meta, "media.complete_failed", "media_asset", id, null, serialize({ status: after.status, errorLen: (body.error || "").length }), body.reason || null);
          return after;
        });
        return reply.send({ ok: false, id: updated.id, status: updated.status });
      }
      let storageEnv: ReturnType<typeof requireObjectStorageEnv>;
      try { storageEnv = requireObjectStorageEnv(); } catch {
        emitSafetyEvent({ event: "media_complete_storage_env_missing", errorClass: "exhausted", adminId: meta.adminId, retryHint: 0 });
        return reply.status(503).send({ error: "object_storage_unavailable", userError: "对象存储服务未上线，无法校验上传结果" });
      }
      if (!asset.storageBucket || !asset.storageKey) {
        return reply.status(400).send({ error: "asset_storage_uninitialized", userError: "上传记录未初始化存储 Key，请重新发起上传" });
      }
      const verify = await headObject(asset.storageBucket, asset.storageKey);
      let finalStatus: "ready" | "failed" = "failed";
      let contentLengthFinal = asset.contentLength;
      let etagFinal = body.etag || null;
      if (verify.ok && verify.head) {
        const reported = body.reportedContentLength ? Number(body.reportedContentLength) : null;
        const s3len = typeof (verify.head as any).ContentLength === "number" ? Number((verify.head as any).ContentLength) : null;
        if (reported && s3len && reported !== s3len) {
          emitSafetyEvent({ event: "media_complete_length_mismatch", errorClass: "conflict", adminId: meta.adminId, note: `reported=${reported} s3=${s3len} kind=${asset.kind}` });
        } else {
          finalStatus = "ready";
          if (s3len) contentLengthFinal = BigInt(s3len);
          const etagRaw = (verify.head as any).ETag as string | undefined;
          if (etagRaw) etagFinal = etagRaw.replace(/^"|"$/g, "");
        }
      } else {
        emitSafetyEvent({
          event: "media_complete_head_verify_failed",
          errorClass: verify.userError && /not_found/.test(verify.userError) ? "business" : "timeout",
          adminId: meta.adminId,
          retryHint: 1,
          note: `kind=${asset.kind} uerr_len=${(verify.userError || "").length}`,
        });
      }
      const publicUrl = finalStatus === "ready" ? makePublicUrl(storageEnv.bucket, storageEnv.region, asset.storageKey, storageEnv) : undefined;
      const updated = await prisma.$transaction(async (tx: any) => {
        const after = await tx.mediaAsset.update({
          where: { id },
          data: {
            status: finalStatus,
            contentLength: contentLengthFinal,
            storageEtag: etagFinal,
            storagePublicUrl: publicUrl || null,
            lastVerifiedAt: new Date(),
          },
        });
        await writeAudit(tx, meta, `media.complete_${finalStatus}`, "media_asset", id, null, serialize({ status: after.status, etagLen: (etagFinal || "").length, hasPublicUrl: !!publicUrl }), body.reason || null);
        return after;
      });
      return reply.send({ ok: finalStatus === "ready", id: updated.id, status: updated.status, publicUrl: updated.storagePublicUrl, contentLength: updated.contentLength ? String(updated.contentLength) : null });
    },
  );

  fastify.get(
    "/admin/media/:id",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const row = await prisma.mediaAsset.findUnique({ where: { id } });
      if (!row) return reply.status(404).send({ error: "not_found" });
      return reply.send({
        id: row.id,
        kind: row.kind,
        status: row.status,
        storageBackend: row.storageBackend,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        contentLength: row.contentLength ? String(row.contentLength) : null,
        storageBucket: row.storageBucket,
        storageRegion: row.storageRegion,
        storageKey: row.storageKey,
        storageEtag: row.storageEtag,
        storagePublicUrl: row.storagePublicUrl,
        durationSeconds: row.durationSeconds,
        widthPixels: row.widthPixels,
        heightPixels: row.heightPixels,
        hasWatermark: row.hasWatermark,
        note: row.note,
        expiresAt: row.expiresAt,
        lastVerifiedAt: row.lastVerifiedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    },
  );

  fastify.post(
    "/admin/media/:id/delete",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZMEDIA_STATUS_DELETE_REASON.safeParse(req.body || {}).data || {};
      const meta = adminMeta(req);
      const asset = await prisma.mediaAsset.findUnique({ where: { id } });
      if (!asset) return reply.status(404).send({ error: "not_found" });
      if (asset.storageBucket && asset.storageKey) {
        void deleteObjectSafe(asset.storageBucket, asset.storageKey, meta.adminId);
      }
      const updated = await prisma.$transaction(async (tx: any) => {
        const after = await tx.mediaAsset.update({ where: { id }, data: { status: "deleted", note: truncateNote(`软删除：${body.reason || asset.note || ""}`, 500) } });
        await writeAudit(tx, meta, "media.delete", "media_asset", id, null, serialize({ status: after.status }), body.reason || null);
        return after;
      });
      return reply.send({ ok: true, id: updated.id, status: updated.status });
    },
  );

  // ===========================================================================
  // 【P0-素材上传发布】Bot 发布任务 3 条 API
  // Security:
  //   - 前端不能提交 chatId / telegramMessageId / target_chat_*；所有目标只由服务端根据 channelKind（枚举）解析
  //   - 所有 3 条路由 requireAdmin("content:publish")（editor 及以上）
  // ===========================================================================
  fastify.post(
    "/admin/contents/:id/start-telegram-publish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const contentId = z.string().uuid().parse(req.params.id);
      const body = ZSTART_PUBLISH.parse(req.body);
      const meta = adminMeta(req);
      // 1. 查 content + 全 FK + 所属 package
      const content = await prisma.content.findUnique({
        where: { id: contentId },
        include: {
          coverAsset: true,
          previewAsset: true,
          fullVideoAsset: true,
          package: { select: { id: true, status: true, channelId: true, channelIdCiphertext: true, title: true } },
        },
      });
      if (!content) return reply.status(404).send({ error: "not_found", message: "内容不存在" });
      // 2. validateContentAccessTypeConstraints + validatePublishReady 合并（避免重复查）
      const baseOk = await validateContentAccessTypeConstraints({
        prisma,
        accessType: content.accessType as AccessTypeBound,
        packageId: content.packageId,
        productId: content.productId,
        freeChannelCode: content.freeChannelCode,
        coverAssetId: content.coverAssetId,
        previewAssetId: content.previewAssetId,
        fullVideoAssetId: content.fullVideoAssetId,
      });
      if (!baseOk.ok) return reply.status(baseOk.status).send({ error: baseOk.error, message: baseOk.message, details: baseOk.details });
      // 3. 强业务矩阵：accessType × channelKinds（服务端强制，前端 UI 会灰选但 API 侧必须二次校验）
      const kinds = Array.from(new Set(body.channelKinds));
      type K = "public_free_preview" | "membership_full" | "package_full";
      const resolvedPlans: Array<{
        kind: K;
        mediaAssetId: string;
        targetFreeChannelCode?: string | null;
        channelKindDb: "public_free_preview" | "membership_full" | "package_full";
        packageId?: string | null;
      }> = [];
      for (const raw of kinds) {
        const kind = raw as K;
        if (kind === "public_free_preview") {
          if (content.accessType !== "public" && content.accessType !== "membership" && content.accessType !== "package") {
            return reply.status(409).send({ error: "publish_kind_mismatch", message: `只有 public/membership/package 类型可发布试看到免费频道，当前 accessType=${content.accessType}` });
          }
          if (!content.freeChannelCode || !isValidFreeChannelCode(content.freeChannelCode)) {
            return reply.status(400).send({ error: "free_channel_code_required", message: "发布免费频道前必须先绑定白名单免费频道编码（freeChannelCode）。" });
          }
          if (!content.previewAsset || content.previewAsset.status !== "ready") {
            return reply.status(409).send({ error: "preview_asset_required", message: "免费预览必须先上传并校验试看视频（previewAsset.status=ready）。" });
          }
          resolvedPlans.push({ kind, mediaAssetId: content.previewAsset.id, targetFreeChannelCode: content.freeChannelCode, channelKindDb: "public_free_preview" });
        } else if (kind === "membership_full") {
          if (content.accessType !== "membership") {
            return reply.status(409).send({ error: "publish_kind_mismatch", message: "只有 membership 类型可发布完整视频至会员主频道。" });
          }
          if (!content.fullVideoAsset || content.fullVideoAsset.status !== "ready") {
            return reply.status(409).send({ error: "full_video_asset_required", message: "会员内容必须先上传并校验完整视频（fullVideoAsset.status=ready）。" });
          }
          resolvedPlans.push({ kind, mediaAssetId: content.fullVideoAsset.id, channelKindDb: "membership_full" });
        } else if (kind === "package_full") {
          if (content.accessType !== "package") {
            return reply.status(409).send({ error: "publish_kind_mismatch", message: "只有 package 类型可发布完整视频至包独立私密频道。" });
          }
          if (!content.package) {
            return reply.status(409).send({ error: "package_not_bound", message: "package 类型必须先绑定已发布的内容包。" });
          }
          if (resolvePackageChannelId({ channelId: content.package.channelId, channelIdCiphertext: content.package.channelIdCiphertext }) == null) {
            return reply.status(409).send({ error: "package_channel_not_configured", message: "绑定的内容包未配置交付频道（服务端受控映射未完成）。" });
          }
          if (!content.fullVideoAsset || content.fullVideoAsset.status !== "ready") {
            return reply.status(409).send({ error: "full_video_asset_required", message: "内容包内容必须先上传并校验完整视频（fullVideoAsset.status=ready）。" });
          }
          resolvedPlans.push({ kind, mediaAssetId: content.fullVideoAsset.id, channelKindDb: "package_full", packageId: content.package.id });
        }
      }
      if (resolvedPlans.length === 0) return reply.status(400).send({ error: "publish_plan_empty", message: "没有任何合法的发布计划；请检查 accessType 与目标频道类型是否匹配。" });
      // 4. 事务内：批量创建 TelegramPublishJob + auditLog
      const queueHandle = getPublishQueueHandle();
      const createdJobs = await prisma.$transaction(async (tx: any) => {
        const jobs: Array<any> = [];
        const now = Date.now();
        for (const plan of resolvedPlans) {
          const jobSeed = `${plan.channelKindDb}|${content.id}|${plan.mediaAssetId}|${meta.adminId}|${now}|${cryptoRandomUuid()}`;
          const jobToken = `tgj_${createHash("sha256").update(jobSeed).digest("hex").slice(0, 48)}`;
          // public_free_preview + preview 自动带 caption（HTML 模板），其他为空 caption
          let captionBundle: { captionText?: string | null; parseMode?: string | null } = {};
          if (plan.channelKindDb === "public_free_preview") {
            const { caption, parseMode } = buildPreviewVideoCaption(content);
            captionBundle = { captionText: caption, parseMode };
          }
          const job = await tx.telegramPublishJob.create({
            data: {
              contentId: content.id,
              packageId: plan.packageId ?? null,
              adminId: meta.adminId,
              mediaAssetId: plan.mediaAssetId,
              channelKind: plan.channelKindDb,
              targetFreeChannelCode: plan.targetFreeChannelCode ?? null,
              jobToken,
              queueName: "telegram-publish-default",
              botKey: "primary",
              captionText: captionBundle.captionText ?? null,
              parseMode: captionBundle.parseMode ?? null,
            },
          });
          jobs.push(job);
          await writeAudit(tx, meta, `content.publish_telegram_queue_${plan.channelKindDb}`, "content", content.id, null, serialize({ jobId: job.id, jobToken_fp: safeHexDigest(jobToken, 16) }), body.reason || null);
        }
        return jobs;
      });
      // 5. 入队（BullMQ 或 DB 轮询模式，异步）
      if (queueHandle) {
        for (const j of createdJobs) {
          try { await queueHandle.add(j.jobToken); } catch (err) {
            emitSafetyEvent({ event: "tg_publish_enqueue_failed", errorClass: "queue_error", note: truncateNote(err instanceof Error ? err.message : String(err), 80) || undefined }, err);
          }
        }
      } else {
        emitSafetyEvent({ event: "tg_publish_no_queue_handle", errorClass: "publisher_uninitialized", note: `jobs=${createdJobs.length}` });
      }
      return reply.status(201).send({
        ok: true,
        jobs: createdJobs.map((j: any) => ({
          id: j.id,
          channelKind: j.channelKind,
          status: j.status,
          jobToken: j.jobToken,
          mediaAssetId: j.mediaAssetId,
          targetFreeChannelCode: j.targetFreeChannelCode,
          createdAt: j.createdAt,
        })),
      });
    },
  );

  fastify.get(
    "/admin/contents/:id/publish-jobs",
    { preHandler: [requireAdmin("content:view")] },
    async (req: any, reply) => {
      const contentId = z.string().uuid().parse(req.params.id);
      const qp = ZPUBLISH_JOBS_QP.parse(req.query);
      const rows = await prisma.telegramPublishJob.findMany({
        where: { contentId },
        orderBy: [{ createdAt: "desc" }],
        take: qp.limit,
        include: {
          mediaAsset: { select: { id: true, kind: true, originalFilename: true, status: true, storagePublicUrl: true, contentLength: true, durationSeconds: true } },
          admin: { select: { id: true, email: true, displayName: true } },
          cancelledByAdmin: { select: { id: true, email: true, displayName: true } },
        },
      });
      // 脱敏：绝不在前端展示 fingerprint/masked 之外的任何频道明文标识
      return reply.send({
        items: rows.map((r: any) => ({
          id: r.id,
          contentId: r.contentId,
          packageId: r.packageId,
          mediaAsset: r.mediaAsset,
          admin: r.admin,
          cancelledByAdmin: r.cancelledByAdmin,
          channelKind: r.channelKind,
          targetFreeChannelCode: r.targetFreeChannelCode,
          targetChatMasked: r.targetChatMasked,
          status: r.status,
          queueName: r.queueName,
          attempt: r.attempt,
          maxAttempts: r.maxAttempts,
          lastErrorClass: r.lastErrorClass,
          lastErrorNote: r.lastErrorNote,
          lastAttemptedAt: r.lastAttemptedAt,
          nextRetryAt: r.nextRetryAt,
          telegramMessageId: r.telegramMessageId ? String(r.telegramMessageId) : null,
          telegramMethod: r.telegramMethod,
          parseMode: r.parseMode,
          sentAt: r.sentAt,
          cancelledAt: r.cancelledAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      });
    },
  );

  fastify.post(
    "/admin/telegram-publish-jobs/:id/cancel",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const body = ZAUDIT_REASON.safeParse(req.body || {}).data || {};
      const meta = adminMeta(req);
      const job = await prisma.telegramPublishJob.findUnique({ where: { id } });
      if (!job) return reply.status(404).send({ error: "not_found" });
      // 仅 queued / failed / retried_exhausted 可取消（已发送的需要走撤回/deleteMessage 另外独立 API）
      if (!["queued", "failed", "retried_exhausted"].includes(job.status)) {
        return reply.status(409).send({ error: "job_status_not_cancellable", message: `当前 status=${job.status}；仅 queued/failed/retried_exhausted 可取消。已发送内容如需撤回请调用撤回独立接口。` });
      }
      const queueHandle = getPublishQueueHandle();
      const updated = await prisma.$transaction(async (tx: any) => {
        const after = await tx.telegramPublishJob.update({
          where: { id },
          data: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledByAdminId: meta.adminId,
          },
        });
        await writeAudit(tx, meta, "telegram_publish_job.cancel", "telegram_publish_job", id, null, serialize({ status: after.status, jobToken_fp: safeHexDigest(after.jobToken, 16) }), body.reason || null);
        return after;
      });
      if (queueHandle && updated.jobToken) { try { await queueHandle.remove(updated.jobToken); } catch { /* ignore */ } }
      return reply.send({ ok: true, id: updated.id, status: updated.status, cancelledAt: updated.cancelledAt });
    },
  );

  void SENSITIVE_MASK;
}

function cryptoRandomUuid(): string {
  // 简单 UUID v4 生成（Node 14+ 无 crypto.randomUUID fallback，避免依赖 uuid 包）
  const r = randomBytes(16);
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  const hex = r.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function safeHexDigest(input: string, len = 32): string {
  return createHash("sha256").update(input).digest("hex").slice(0, Math.max(8, len));
}

function truncateNote(s: unknown, n: number): string | null {
  if (s == null) return null;
  const v = String(s);
  return v.length > n ? `${v.slice(0, Math.max(0, n - 3))}...` : v;
}

// ===========================================================================
// CONTENT PACKAGES (阶段一：只读列表，供内容卡关联选择受控内容包)
// 不暴露 channelId 明文；channelConfigured 只是一个布尔标记
// ===========================================================================
async function adminPackageRoutes(fastify: any) {
  const prisma = (fastify as any).prisma as PrismaClient;
  fastify.get(
    "/admin/packages",
    { preHandler: [requireAdmin("content:view")] },
    async (_req: any, reply: any) => {
      const rows = await prisma.contentPackage.findMany({
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
        include: {
          product: { select: { id: true, title: true, status: true } },
          _count: { select: { contents: true } },
        },
      });
      return reply.send({
        data: rows.map((r: any) => ({
          id: r.id,
          title: r.title,
          coverUrl: r.coverUrl ?? null,
          status: r.status,
          productId: r.productId ?? null,
          productTitle: r.product?.title ?? null,
          productActive: r.product?.status === "active" ? true : false,
          channelConfigured:
            resolvePackageChannelId({ channelId: r.channelId, channelIdCiphertext: r.channelIdCiphertext }) != null,
          contentsCount: r._count?.contents || 0,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      });
    },
  );
}

export { adminPackageRoutes };
