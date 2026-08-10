import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { verifyAdminPassword, adminHasPermission } from "../services/authAdmin.js";
import { emitSafetyEvent } from "../utils/structuredError.js";

const adminLoginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export type AdminSession = {
  adminId: string;
  role: string;
  email: string;
};

export function requireAdmin(permission?: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = (req.session as any).admin as AdminSession | undefined;
    if (!sess?.adminId) {
      return reply.status(401).send({ error: "admin_unauthorized", message: "请先登录管理员账号" });
    }
    if (permission && !adminHasPermission(sess.role, permission)) {
      return reply.status(403).send({ error: "forbidden", message: `权限不足，需要 ${permission}` });
    }
    (req as any).admin = sess;
  };
}

export default async function adminRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  fastify.post("/admin/login", async (req, reply) => {
    const parse = adminLoginSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({ error: "bad_request", details: parse.error.issues });
    }
    const { email, password } = parse.data;

    const admin = await prisma.adminUser.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!admin) {
      await verifyAdminPassword(password, "$2a$10$invalid.invalid.invalid.invalid.invalid.invalid.i");
      return reply.status(401).send({ error: "admin_unauthorized", message: "邮箱或密码错误" });
    }
    if (admin.status !== "active") {
      return reply.status(403).send({ error: "admin_disabled", message: "管理员账号已停用" });
    }
    const ok = await verifyAdminPassword(password, admin.passwordHash);
    if (!ok) {
      return reply.status(401).send({ error: "admin_unauthorized", message: "邮箱或密码错误" });
    }

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const sessData: AdminSession = {
      adminId: admin.id,
      role: admin.role,
      email: admin.email,
    };
    (req.session as any).admin = sessData;

    try {
      await prisma.adminAuditLog.create({
        data: {
          adminId: admin.id,
          action: "admin.auth.login",
          objectType: "admin",
          objectId: admin.id,
          ipAddress: (req.ip as string) || null,
          userAgent: (req.headers["user-agent"] as string) || null,
        },
      });
    } catch (e) {
      emitSafetyEvent(
        {
          event: "admin_login_audit_write_failed",
          errorClass: "db_error",
          adminId: admin.id,
          retryHint: 0,
          note: "admin_auth_login_audit_insert_failed_best_effort",
        },
        e,
      );
    }

    return {
      ok: true,
      admin: {
        id: admin.id,
        email: admin.email,
        displayName: admin.displayName,
        role: admin.role,
      },
    };
  });

  fastify.get("/admin/me", { preHandler: [requireAdmin()] }, async (req) => {
    const a = (req as any).admin as AdminSession;
    return {
      id: a.adminId,
      email: a.email,
      role: a.role,
    };
  });

  fastify.post("/admin/logout", async (req, reply) => {
    (req.session as any).admin = null;
    await req.session.destroy();
    return { ok: true };
  });
}
