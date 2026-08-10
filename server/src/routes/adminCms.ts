import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireAdmin, type AdminSession } from "./admin.js";
import { adminHasPermission } from "../services/authAdmin.js";

const ContentStatusZ = z.enum(["draft", "in_review", "published", "archived", "scheduled"]);
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

export default async function adminCmsRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma as PrismaClient;
  const SENSITIVE_MASK = "******";

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
    isRecommended: z.boolean().optional().default(false),
    isFeatured: z.boolean().optional().default(false),
    isNewArrival: z.boolean().optional().default(false),
    featuredSort: z.number().int().optional().nullable(),
    sortOrder: z.number().int().min(0).optional().default(0),
    recommendStartsAt: z.string().datetime().optional().nullable(),
    recommendEndsAt: z.string().datetime().optional().nullable(),
    scheduledAt: z.string().datetime().optional().nullable(),
    packageId: z.string().uuid().optional().nullable(),
    productId: z.string().uuid().optional().nullable(),
    categoryIds: z.array(z.string().uuid()).optional().default([]),
    reason: z.string().max(500).optional(),
  });
  const ZCONTENT_EDIT = ZCONTENT_CREATE.partial().extend({ id: z.string().uuid() });
  const ZCATEGORY_SET = z.object({ categoryIds: z.array(z.string().uuid()), reason: z.string().max(500).optional() });
  const ZSTATUS_ACTION = z.object({ reason: z.string().max(500).optional() });
  const ZCONTENT_QP = z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    status: z.string().optional(),
    categoryId: z.string().uuid().optional(),
    q: z.string().optional(),
    accessType: z.string().optional(),
  });
  const ZAUDIT_REASON = z.object({ reason: z.string().max(500).optional() });

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
      const id = z.string().uuid().parse(req.params.id);
      const row = await prisma.content.findUnique({
        where: { id },
        include: {
          categories: { orderBy: { displayOrder: "asc" }, include: { category: true } },
          product: true, package: true,
          lastEditor: { select: { id: true, email: true, displayName: true } },
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
      const { reason, categoryIds, ...payload } = body;
      const parseDates = (d: any) => (d ? new Date(d) : null);
      const data: any = {
        title: payload.title,
        coverUrl: payload.coverUrl ?? null,
        thumbnailUrl: payload.thumbnailUrl ?? null,
        description: payload.description ?? null,
        tags: payload.tags ?? [],
        previewUrl: payload.previewUrl ?? null,
        durationSeconds: payload.durationSeconds ?? null,
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
        await writeAudit(tx, meta, "content.create", "content", created.id, null, serialize(created), reason);
        return created;
      });
      return reply.status(201).send({ ok: true, id: result.id });
    },
  );

  fastify.patch(
    "/admin/contents/:id",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
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
        await writeAudit(tx, meta, "content.update", "content", id, serialize(before), serialize(after), reason);
        return after;
      });
      return reply.send({ ok: true, id: result.id });
    },
  );

  fastify.put(
    "/admin/contents/:id/categories",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
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

  fastify.post(
    "/admin/contents/:id/submit_for_review",
    { preHandler: [requireAdmin("content:edit")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const { reason } = ZSTATUS_ACTION.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await prisma.content.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      if (!["draft", "archived"].includes(before.status)) {
        return reply.status(409).send({ error: "bad_status", message: "仅草稿或归档可提交审核" });
      }
      await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data: { status: "in_review", lastEditorId: meta.adminId },
        });
        await writeAudit(tx, meta, "content.submit_review", "content", id, before.status, after.status, reason);
      });
      return reply.send({ ok: true, status: "in_review" });
    },
  );

  fastify.post(
    "/admin/contents/:id/publish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const { reason } = ZSTATUS_ACTION.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await prisma.content.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      if (!["draft", "in_review", "archived", "scheduled"].includes(before.status)) {
        return reply.status(409).send({ error: "bad_status", message: "当前状态不允许发布" });
      }
      await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data: { status: "published", publishedAt: new Date(), lastEditorId: meta.adminId },
        });
        await writeAudit(tx, meta, "content.publish", "content", id, before.status, after.status, reason);
      });
      return reply.send({ ok: true, status: "published" });
    },
  );

  fastify.post(
    "/admin/contents/:id/unpublish",
    { preHandler: [requireAdmin("content:publish")] },
    async (req: any, reply) => {
      const id = z.string().uuid().parse(req.params.id);
      const { reason } = ZSTATUS_ACTION.parse(req.body || {});
      const meta = adminMeta(req);
      const before = await prisma.content.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!before) return reply.status(404).send({ error: "not_found" });
      if (before.status !== "published") {
        return reply.status(409).send({ error: "bad_status", message: "仅已发布内容可下架" });
      }
      await prisma.$transaction(async (tx: any) => {
        const after = await tx.content.update({
          where: { id },
          data: { status: "archived", publishedAt: null, lastEditorId: meta.adminId },
        });
        await writeAudit(tx, meta, "content.unpublish", "content", id, before.status, after.status, reason);
      });
      return reply.send({ ok: true, status: "archived" });
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

  void SENSITIVE_MASK;
}
