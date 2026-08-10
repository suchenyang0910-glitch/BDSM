import type { PrismaClient } from "@prisma/client";
import { randomInt } from "node:crypto";
import { emitSafetyEvent } from "../utils/structuredError.js";

export const USDT_ORDER_EXPIRES_MS = 20 * 60 * 1000;
export const USDT_CONFIRMATIONS_TARGET_DEFAULT = 19;
export const USDT_TRON_TOKEN_CONTRACT_DEFAULT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

export type AssignUsdtAddressResult =
  | { ok: true; address: string; addressId: string; releaseAt: Date; assignedOrderId?: never }
  | { ok: false; errorClass: "pool_empty" | "db_error"; reason: string };

export type GenerateUsdtUniqueAmountResult = {
  finalAmountMinor: bigint;
  actualTailMinor: bigint;
  uniqueDeltaMinor: bigint;
  /** @deprecated 兼容旧调用方；= actualTailMinor，后续逐步移除 */
  tailMinor: bigint;
  /** @deprecated 兼容旧调用方；= finalAmountMinor，后续逐步移除 */
  amountMinor: bigint;
  baseAmountMinor: bigint;
};

// Prisma 5 未导出 TransactionClient；用 DBClient 允许外部直接传 interactive transaction 的 tx 对象，保持 DB 调用在同一事务内原子化
export type PrismaDBClient = PrismaClient | any;

/**
 * 分配 USDT 地址。
 * - 若传入 tx（interactive transaction）：直接复用同一事务，不再嵌套开 $transaction，保证与后续业务操作原子提交。
 * - 若传入全局 PrismaClient：按原有行为开启独立 interactive transaction。
 * - 可选 skipAddressIds：尾数耗尽或其他原因已确定不可再分配的地址 ID 集合，SQL 层直接排除，避免白读已占满的 takenActualTails 浪费 IO。
 */
export async function assignUsdtTrc20Address(
  client: PrismaDBClient,
  forOrderId: string,
  releaseAt: Date,
  skipAddressIds?: string[] | null,
): Promise<AssignUsdtAddressResult> {
  if (!forOrderId) return { ok: false, errorClass: "pool_empty", reason: "forOrderId_required" };
  const skipArr = Array.isArray(skipAddressIds) && skipAddressIds.length > 0 ? skipAddressIds : null;
  const runOne = async (tx: any) => {
    const now = new Date();
    let row: any[];
    if (skipArr && skipArr.length > 0) {
      // 使用 ANY($3) 参数化 WHERE id NOT IN (...)，skipArr 长度为 0 时走无 skip 分支避免空数组 ANY 语法问题
      const placeholders = skipArr.map((_, i) => `$${i + 3}`).join(",");
      const sql = `SELECT id, address FROM "payment_addresses"
       WHERE network = $1 AND status = 'available' AND ("release_at" IS NULL OR "release_at" < $2)
       AND id NOT IN (${placeholders})
       ORDER BY "assigned_at" ASC NULLS FIRST, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`;
      row = await tx.$queryRawUnsafe(sql, "tron_trc20", now, ...skipArr);
    } else {
      row = await tx.$queryRawUnsafe(
        `SELECT id, address FROM "payment_addresses"
       WHERE network = $1 AND status = 'available' AND ("release_at" IS NULL OR "release_at" < $2)
       ORDER BY "assigned_at" ASC NULLS FIRST, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
        "tron_trc20",
        now,
      );
    }
    if (!row || row.length === 0) return null;
    const id = String(row[0].id);
    const address = String(row[0].address);
    await tx.paymentAddress.update({
      where: { id },
      data: {
        status: "assigned",
        assignedOrderId: forOrderId,
        assignedAt: now,
        releaseAt,
      },
    });
    return { id, address };
  };
  try {
    // 判断是否为 interactive tx：如果 client.$transaction 被「当前已在事务中」跳过，则直接 runOne(client)
    // 简化：用 isPrismaTransactionClient heuristic —— 有 $transaction 但没有 $connect。PrismaClient 才有 $connect/$disconnect/$on。
    const isTx = typeof (client as any).$connect !== "function";
    const picked = isTx ? await runOne(client) : await (client as PrismaClient).$transaction(runOne);
    if (!picked) return { ok: false, errorClass: "pool_empty", reason: "no_available_address_in_pool" };
    return { ok: true, address: picked.address, addressId: picked.id, releaseAt };
  } catch (e: any) {
    // PRD §4.4 P0：stdout/stderr 禁止输出原始 DB reason/SQL/列名；仅写安全结构化事件到 stderr（prismaCode=Pxxxx + 脱敏
    try {
      emitSafetyEvent(
        {
          event: "usdt_assign_db_error",
          errorClass: "db_error",
          orderNo: undefined, // caller 会在路由层补充 orderFingerprint，这里只有 forOrderId 也尽量不传明文，改用结构化工具里转 fp:
          note: "assignUsdtTrc20Address: db_exception",
          counts: undefined as any
        },
        e,
      );
    } catch {}
    // 保留结构化分类，不保留原始 reason。（reason 字段存在仅用于调用栈内部走分支用传内部识别，不再包含明文原始错误）
    return { ok: false, errorClass: "db_error", reason: "assign_db_exception" };
  }
}

/**
 * 生成唯一尾数。**要求外部已在 prisma.$transaction 内调用并传入 tx（或至少同一地址行 FOR UPDATE 已锁定，直到事务 commit 才释放）**。
 * 函数内部不再自己开 $transaction，避免两段式（锁释放→写订单）带来 takenTails 快照冲突。
 *
 * 新算法（P0-A 修复真实路由尾数≠显示尾数 bug）：
 *   baseTail = baseAmountMinor % 100
 *   选未占用的「实际尾数」targetTail ∈ [0,99]（takenTails 是 orders.amountMinor % 100 的真实值，不是 delta）
 *   delta = (targetTail - baseTail + 100) % 100        → delta ∈ [0,99]，保证 finalAmount = base + delta ≥ base（不低于标价）
 *   actualTail = (baseTail + delta) % 100 = targetTail
 * 返回 4 组字段：
 *   finalAmountMinor, actualTailMinor, uniqueDeltaMinor （新标准）
 *   amountMinor = finalAmountMinor, tailMinor = actualTailMinor （旧兼容字段，@deprecated 后续清理）
 */
export async function generateUsdtUniqueAmountForAddress(
  client: PrismaDBClient,
  addressId: string,
  baseAmountMinor: bigint,
): Promise<GenerateUsdtUniqueAmountResult> {
  if (baseAmountMinor <= 0n) baseAmountMinor = 0n;
  const baseTail = Number(baseAmountMinor % 100n);
  const now = new Date();
  const windowStart = new Date(now.getTime() - USDT_ORDER_EXPIRES_MS);
  // 同地址并发串行化：悲观锁 payment_addresses 行（若上游已锁则为重入，但锁可重入不会死锁）
  await client.$queryRawUnsafe(`SELECT id FROM "payment_addresses" WHERE id = $1 FOR UPDATE`, addressId);
  const takenActualTails = new Set<number>();
  const rows: any[] = await client.order.findMany({
    where: {
      usdtPaymentAddressId: addressId,
      paymentMethod: "usdt_trc20_external",
      status: { in: ["pending", "processing", "paid"] as any },
      OR: [{ expiresAt: null }, { expiresAt: { gte: windowStart } }],
    },
    select: { amountMinor: true },
  });
  for (const r of rows) {
    const am = BigInt(String(r.amountMinor));
    const actualTail = Number(am % 100n);
    takenActualTails.add(actualTail);
  }
  let targetTail = -1;
  if (takenActualTails.size >= 100) {
    // PRD §4.3 P0：100 个实际尾数全部占满时，**不得静默复用 0 尾数**；直接抛「尾数空间耗尽」业务错 → 外层事务整体回滚；路由层按 PRD 再决定「尝试另一个可用地址」还是返回 503。
    try {
      emitSafetyEvent({
        event: "usdt_tail_exhausted",
        errorClass: "exhausted",
        addressId,
        retryHint: 1,
        note: "100_actual_tails_all_taken_try_next_address",
        counts: { takenActualTails: takenActualTails.size },
      });
    } catch {}
    const err = new Error("usdt_tail_exhausted") as Error & { _class?: "tail_exhausted"; taken?: number; addressId?: string };
    (err as any)._class = "tail_exhausted";
    (err as any).taken = takenActualTails.size;
    (err as any).addressId = addressId;
    throw err;
  }
  // 尾数未满 100：先随机 200 次（避免冲突密集区），仍冲突再顺序扫
  {
    let tries = 0;
    while (tries < 200) {
      const candidate = randomInt(0, 100);
      if (!takenActualTails.has(candidate)) {
        targetTail = candidate;
        break;
      }
      tries++;
    }
    if (targetTail < 0) {
      for (let i = 0; i < 100; i++) {
        if (!takenActualTails.has(i)) {
          targetTail = i;
          break;
        }
      }
    }
  }
  // 防 double check：理论不会再满，但保险处理
  if (targetTail < 0) {
    try {
      emitSafetyEvent({
        event: "usdt_tail_exhausted_fallback",
        errorClass: "exhausted",
        addressId,
        retryHint: 1,
        note: "tail_scan_also_fully_taken",
        counts: { takenActualTails: takenActualTails.size },
      });
    } catch {}
    const err = new Error("usdt_tail_exhausted") as Error & { _class?: "tail_exhausted"; taken?: number; addressId?: string };
    (err as any)._class = "tail_exhausted";
    (err as any).taken = takenActualTails.size;
    (err as any).addressId = addressId;
    throw err;
  }
  const delta = BigInt((targetTail - baseTail + 100) % 100); // 0n..99n
  const finalAmountMinor = baseAmountMinor + delta;
  const actualTailMinor = BigInt(targetTail);
  return {
    finalAmountMinor,
    actualTailMinor,
    uniqueDeltaMinor: delta,
    tailMinor: actualTailMinor, // deprecated compat
    amountMinor: finalAmountMinor, // deprecated compat
    baseAmountMinor,
  };
}

/**
 * 手动/定时 释放已过期分配的 USDT 地址。
 * 支持传入 tx（interactive transaction），与外层 adminAuditLog 等同一事务提交；异常向外冒泡而非静默吞掉，保证失败时整体回滚。
 */
export async function releaseExpiredUsdtAddresses(client: PrismaDBClient): Promise<{ released: number; errors: number }> {
  let released = 0;
  let errors = 0;
  const now = new Date();
  const r = await client.$executeRawUnsafe(
    `UPDATE "payment_addresses"
     SET status = 'available',
         assigned_order_id = NULL,
         assigned_at = NULL,
         release_at = NULL,
         updated_at = NOW()
     WHERE status = 'assigned'
       AND assigned_order_id IN (
         SELECT o.id FROM "orders" o
         WHERE o.status IN ('pending','processing')
           AND o.expires_at IS NOT NULL
           AND o.expires_at < $1
       )`,
    now,
  );
  released = typeof r === "number" ? r : 0;
  const r2 = await client.$executeRawUnsafe(
    `UPDATE "payment_addresses"
     SET status = 'available',
         assigned_order_id = NULL,
         assigned_at = NULL,
         release_at = NULL,
         updated_at = NOW()
     WHERE status = 'assigned'
       AND release_at IS NOT NULL
       AND release_at < $1`,
    now,
  );
  if (typeof r2 === "number") released += r2;
  return { released, errors };
}

export function addressMasked(address: string): string {
  if (!address) return "";
  if (address.length <= 10) return address.slice(0, 4);
  return address.slice(0, 4) + "…" + address.slice(-4);
}

export function rawEventHashForUsdtTx(chainListenerSource: string, network: string, txHash: string): string {
  return `usdt:${chainListenerSource || "default"}:${network || "tron_trc20"}:${txHash}`;
}
