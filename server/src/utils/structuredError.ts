import { shortFingerprint } from "./crypto.js";

/**
 * 【PRD §4.4 P0 红线】
 * 禁止将数据库原始 reason / SQL / 堆栈 / 列名 / 完整业务标识 输出到 stdout/stderr。
 * 仅允许通过本模块的 emitSafetyEvent / emitStructuredLog 输出结构化事件：
 *   event         = 事件短名（如 usdt_assign_failed, usdt_tail_exhausted）
 *   errorClass    = db_error | business | timeout | auth ...
 *   prismaCode    = Pxxxx (仅 Prisma 错误，去掉 clientVersion / meta)
 *   orderFingerprint / userFingerprint / addressFingerprint = 16hex HMAC (短指纹)
 *   retryHint     = 0|1 可选
 *   note          = 人工可理解的短原因，不得包含任何 DB 原始文本或 SQL
 */

export type SafetyAttrs = {
  event: string;
  errorClass?: "db_error" | "business" | "timeout" | "auth" | "exhausted" | "conflict" | "unknown" | string;
  prismaCode?: string;
  orderNo?: string | null;
  userId?: string | number | bigint | null;
  addressId?: string | null;
  productId?: string | null;
  adminId?: string | null;
  retryHint?: 0 | 1;
  /** 仅允许纯业务语义的短 note，严禁 DB raw / SQL / 堆栈 / 列名 / 行 UUID */
  note?: string;
  /** 自由的数值计数（如 takenActualTails, addressRetries） */
  counts?: Record<string, number>;
};

export function extractPrismaCodeOnly(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as any;
  const code = typeof e.code === "string" ? e.code : undefined;
  if (code && /^P[0-9]{4}$/.test(code)) return code;
  return undefined;
}

function buildStructured(attrs: SafetyAttrs): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {
    event: attrs.event,
    errorClass: attrs.errorClass,
    prismaCode: attrs.prismaCode,
    orderFingerprint: attrs.orderNo ? shortFingerprint("order", attrs.orderNo) : undefined,
    userFingerprint: attrs.userId ? shortFingerprint("user", attrs.userId) : undefined,
    addressFingerprint: attrs.addressId ? shortFingerprint("address", attrs.addressId) : undefined,
    productFingerprint: attrs.productId ? shortFingerprint("product", attrs.productId) : undefined,
    adminFingerprint: attrs.adminId ? shortFingerprint("admin", attrs.adminId) : undefined,
    retryHint: attrs.retryHint,
    note: attrs.note,
  };
  if (attrs.counts) {
    for (const [k, v] of Object.entries(attrs.counts)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        out[`cnt_${k}`] = v;
      }
    }
  }
  return out;
}

/**
 * 【唯一允许】将 DB 相关异常转换为安全结构化事件写入 stderr（通过 process.stderr.write，不使用 console.error 以免把 Error 对象 stack 展开）。
 * 所有「数据库错误」场景必须调用本函数，绝不能直接 console.error(e) / console.error(e.message)。
 */
export function emitSafetyEvent(attrs: SafetyAttrs, rawErr?: unknown): void {
  try {
    const prismaCode = attrs.prismaCode ?? extractPrismaCodeOnly(rawErr);
    const line: Record<string, string | number | undefined> = buildStructured({ ...attrs, prismaCode });
    const serialized = Object.entries(line)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    // 用 stderr 写一行，避免 console.error 的颜色 / 堆栈 / Error 对象自动展开
    const payload = `[safety] ${serialized}\n`;
    try { process.stderr.write(payload); } catch { /* stdout/stderr 本身不可用时静默 */ }
  } catch {
    // 自身出错也静默，避免任何原始错误意外泄露
  }
}

/** 结构化非 DB 级事件（如地址池 retry 次数），写 stdout，同样不包含敏感明文或 DB raw。 */
export function emitStructuredLog(attrs: SafetyAttrs): void {
  try {
    const line: Record<string, string | number | undefined> = buildStructured(attrs);
    const serialized = Object.entries(line)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    const payload = `[event] ${serialized}\n`;
    try { process.stdout.write(payload); } catch { /* noop */ }
  } catch {
    // 静默
  }
}

/** 把 Prisma / DB 错误映射到用户侧结构化错误码；绝不透传原始 message。返回 errorClass (用于 emit) 和用户错误码。 */
export function classifyDbErrorForUser(err: unknown): {
  userError: "usdt_assign_failed" | "usdt_unique_tail_query_failed" | "usdt_address_pool_exhausted" | "conflict" | "internal_server_error";
  errorClass: "db_error" | "business" | "conflict" | "exhausted";
  prismaCode?: string;
  note: string;
} {
  const prismaCode = extractPrismaCodeOnly(err);
  if (prismaCode === "P2002") {
    return { userError: "conflict", errorClass: "conflict", prismaCode, note: "unique_constraint_conflict_retry" };
  }
  return { userError: "usdt_unique_tail_query_failed", errorClass: "db_error", prismaCode, note: "db_operation_failed_later" };
}
