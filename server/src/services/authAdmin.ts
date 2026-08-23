import bcrypt from "bcryptjs";

export const ADMIN_ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: ["*"],
  operator: [
    "order:view",
    "order:cancel",
    "content:view",
    "content:edit",
    "category:view",
    "category:edit",
    "homepage:view",
    "homepage:edit",
    "user:view",
    "entitlement:view",
    "dashboard:view",
    "settings:view",
  ],
  finance: [
    "order:view",
    "order:mark_paid",
    "order:refund",
    "finance:view_report",
    "finance.view",
    "finance.manage_pools",
    "entitlement:view",
    "dashboard:view",
    "settings:view",
  ],
  customer_service: [
    "user:view",
    "user:edit",
    "order:view",
    "entitlement:view",
    "entitlement:resend_invite",
    "entitlement:retry_removal",
    "ticket:view",
    "ticket:assign_self",
    "ticket:note",
    "ticket:resolve",
    "ticket:close",
  ],
  editor: [
    "content:view",
    "content:edit",
    "content:publish",
    "category:view",
    "category:edit",
    "homepage:view",
    "homepage:edit",
    "homepage:publish",
    "entitlement:view",
    "ticket:view",
    "dashboard:view",
    "settings:view",
  ],
  auditor: [
    "content:view",
    "category:view",
    "homepage:view",
    "order:view",
    "user:view",
    "entitlement:view",
    "audit:view",
    "ticket:view",
    "dashboard:view",
    "settings:view",
  ],
};

const BCRYPT_ROUNDS = 10;

export async function hashAdminPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error("admin password must be at least 8 characters");
  }
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyAdminPassword(password: string, hash: string): Promise<boolean> {
  if (!password || !hash) return false;
  return bcrypt.compare(password, hash);
}

export function adminHasPermission(role: string, permission: string): boolean {
  const perms = ADMIN_ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.includes("*")) return true;
  return perms.includes(permission);
}

export async function generateSuperAdminSecrets() {
  const email = process.env.SEED_SUPERADMIN_EMAIL || "superadmin@intune.local";
  const password = process.env.SEED_SUPERADMIN_PASSWORD || "ChangeMeSuperAdmin!123";
  const hash = await hashAdminPassword(password);
  return { email, password, hash };
}

export async function generateOperatorSecrets() {
  const email = process.env.SEED_OPERATOR_EMAIL || "operator@intune.local";
  const password = process.env.SEED_OPERATOR_PASSWORD || "ChangeMeOperator!456";
  const hash = await hashAdminPassword(password);
  return { email, password, hash };
}
