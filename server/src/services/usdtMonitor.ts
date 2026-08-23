import { hmacSha256Hex, shortFingerprint } from "../utils/crypto.js";
import { emitSafetyEvent, emitStructuredLog } from "../utils/structuredError.js";
import { verifyAndFreezePaymentAddressIntegrity } from "./paymentAddressIntegrity.js";

export const USDT_MONITOR_WORKER_NAME = "usdt_trc20_monitor_v1";
export const USDT_MONITOR_MAX_BACKOFF_MS = 120_000;
const CURSOR_OVERLAP_MS = 2 * 60 * 1000;
const DEFAULT_TRON_GRID_BASE_URL = "https://api.trongrid.io";

type FetchLike = typeof fetch;

export type UsdtMonitorConfig = {
  workerName: string;
  tronGridBaseUrl: string;
  tronGridApiKey: string;
  pollIntervalMs: number;
  lookbackMs: number;
  maxAddressesPerCycle: number;
  confirmationsTarget: number;
  acceptedTokenContracts: string[];
  workerSecret: string;
  internalBaseUrl: string;
};

export type TronGridTrc20Tx = {
  txHash: string;
  logIndex: number;
  blockTimestampMs: number;
  blockNumber: bigint;
  tokenContract: string;
  tokenDecimals: number;
  fromAddress: string;
  toAddress: string;
  amountMinor: bigint;
};

export type MonitorCycleResult = {
  ok: boolean;
  scannedAddressCount: number;
  discoveredTxCount: number;
  confirmedCount: number;
  rejectedCount: number;
  latestBlockNumber: bigint | null;
  errorClass: string | null;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

export function loadUsdtMonitorConfig(env: NodeJS.ProcessEnv = process.env): UsdtMonitorConfig {
  const missing: string[] = [];
  const tronGridApiKey = String(env.TRON_GRID_API_KEY || "").trim();
  const workerSecret = String(env.USDT_WORKER_SECRET || "").trim();
  const acceptedContracts = String(env.USDT_ACCEPTED_TOKEN_CONTRACTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!tronGridApiKey) missing.push("TRON_GRID_API_KEY");
  if (!workerSecret || workerSecret.length < 24) missing.push("USDT_WORKER_SECRET");
  if (acceptedContracts.length === 0) missing.push("USDT_ACCEPTED_TOKEN_CONTRACTS");

  if (missing.length > 0) {
    throw new Error(`Missing required USDT monitor config keys: ${missing.join(", ")}`);
  }

  return {
    workerName: USDT_MONITOR_WORKER_NAME,
    tronGridBaseUrl: String(env.TRON_GRID_BASE_URL || DEFAULT_TRON_GRID_BASE_URL).trim().replace(/\/+$/, ""),
    tronGridApiKey,
    pollIntervalMs: envInt("USDT_MONITOR_POLL_INTERVAL_MS", 15_000),
    lookbackMs: envInt("USDT_MONITOR_LOOKBACK_MS", 3_600_000),
    maxAddressesPerCycle: envInt("USDT_MONITOR_MAX_ADDRESSES_PER_CYCLE", 100),
    confirmationsTarget: envInt("USDT_CONFIRMATIONS_TARGET", 19),
    acceptedTokenContracts: acceptedContracts,
    workerSecret,
    internalBaseUrl: String(env.USDT_INTERNAL_BASE_URL || `http://127.0.0.1:${env.SERVER_PORT || "3000"}`).trim().replace(/\/+$/, ""),
  };
}

function monitorHeaders(cfg: UsdtMonitorConfig): HeadersInit {
  return {
    Accept: "application/json",
    "TRON-PRO-API-KEY": cfg.tronGridApiKey,
  };
}

function classifyProviderError(status: number): string {
  if (status === 429) return "provider_429";
  if (status >= 500) return "provider_5xx";
  if (status === 401 || status === 403) return "provider_auth_failed";
  return "provider_bad_response";
}

export function txHashFingerprint(txHash: string, logIndex?: number): string {
  return hmacSha256Hex(`usdt_monitor_tx:${String(txHash || "")}:${String(logIndex ?? 0)}`).slice(0, 16);
}

export function parseTronTx(raw: any, acceptedContracts: string[]): TronGridTrc20Tx | null {
  const txHash = String(raw?.transaction_id || raw?.txID || raw?.hash || "").trim();
  const logIndex = Number(raw?.event_index ?? raw?.log_index ?? raw?.logIndex ?? 0);
  const blockTimestampMs = Number(raw?.block_timestamp || raw?.blockTimestamp || 0);
  const blockNumRaw = raw?.block_number ?? raw?.blockNumber ?? raw?.block ?? null;
  const tokenContract = String(raw?.token_info?.address || raw?.tokenInfo?.address || raw?.contract_address || "").trim();
  const tokenDecimals = Number(raw?.token_info?.decimals ?? raw?.tokenInfo?.decimals ?? -1);
  const fromAddress = String(raw?.from || raw?.from_address || "").trim();
  const toAddress = String(raw?.to || raw?.to_address || "").trim();
  const amountRaw = raw?.value ?? raw?.amount_str ?? raw?.quant ?? null;

  if (!txHash || !Number.isFinite(logIndex) || logIndex < 0 || !Number.isFinite(blockTimestampMs) || blockTimestampMs <= 0 || blockNumRaw == null) return null;
  if (!tokenContract || !acceptedContracts.includes(tokenContract)) return null;
  if (tokenDecimals !== 6) return null;
  if (!fromAddress || !toAddress) return null;
  if (amountRaw == null || String(amountRaw).trim() === "") return null;

  try {
    const amountMinor = BigInt(String(amountRaw).trim());
    const blockNumber = BigInt(String(blockNumRaw).trim());
    if (amountMinor <= 0n || blockNumber < 0n) return null;
    return {
      txHash,
      logIndex,
      blockTimestampMs,
      blockNumber,
      tokenContract,
      tokenDecimals,
      fromAddress,
      toAddress,
      amountMinor,
    };
  } catch {
    return null;
  }
}

async function fetchJson(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<any> {
  try {
    const res = await fetchImpl(url, init);
    if (!res.ok) {
      const err: any = new Error(`HTTP ${res.status}`);
      err.errorClass = classifyProviderError(res.status);
      err.httpStatus = res.status;
      throw err;
    }
    return await res.json();
  } catch (err: any) {
    if (err?.errorClass) throw err;
    const wrapped: any = new Error(err?.message || "network_error");
    wrapped.errorClass = /timed?out/i.test(String(err?.message || "")) ? "network_timeout" : "network_error";
    throw wrapped;
  }
}

/**
 * The TRC-20 account-history endpoint does not consistently include a block
 * height.  Fetch the execution receipt only for those rows so confirmations
 * remain derived from an actual on-chain block, never from a timestamp guess.
 */
async function fetchTransactionBlockNumber(
  fetchImpl: FetchLike,
  cfg: UsdtMonitorConfig,
  txHash: string,
): Promise<bigint> {
  const json = await fetchJson(fetchImpl, `${cfg.tronGridBaseUrl}/wallet/gettransactioninfobyid`, {
    method: "POST",
    headers: { ...monitorHeaders(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ value: txHash }),
  });
  const receiptResult = String(json?.receipt?.result || json?.result || "").toUpperCase();
  const blockRaw = json?.blockNumber ?? json?.block_number ?? null;
  if (receiptResult !== "SUCCESS" || blockRaw == null) {
    const err: any = new Error("transaction_receipt_missing_confirmed_block");
    err.errorClass = "provider_bad_payload";
    throw err;
  }
  try {
    const blockNumber = BigInt(String(blockRaw));
    if (blockNumber < 0n) throw new Error("negative_block");
    return blockNumber;
  } catch {
    const err: any = new Error("transaction_receipt_invalid_block");
    err.errorClass = "provider_bad_payload";
    throw err;
  }
}

export async function fetchLatestTronBlockNumber(fetchImpl: FetchLike, cfg: UsdtMonitorConfig): Promise<bigint> {
  const json = await fetchJson(fetchImpl, `${cfg.tronGridBaseUrl}/wallet/getnowblock`, {
    method: "POST",
    headers: monitorHeaders(cfg),
  });
  const blockRaw = json?.block_header?.raw_data?.number ?? json?.blockNumber ?? json?.number;
  if (blockRaw == null) {
    const err: any = new Error("missing_block_number");
    err.errorClass = "provider_bad_payload";
    throw err;
  }
  return BigInt(String(blockRaw));
}

export async function fetchTrc20TransactionsForAddress(
  fetchImpl: FetchLike,
  cfg: UsdtMonitorConfig,
  address: string,
  minTimestampMs: number,
): Promise<TronGridTrc20Tx[]> {
  let fingerprint: string | null = null;
  const out: TronGridTrc20Tx[] = [];
  let page = 0;

  while (page < 20) {
    const params = new URLSearchParams({
      only_confirmed: "true",
      only_to: "true",
      limit: "200",
      order_by: "block_timestamp,asc",
      min_timestamp: String(Math.max(0, Math.trunc(minTimestampMs))),
    });
    for (const contract of cfg.acceptedTokenContracts) {
      params.set("contract_address", contract);
      break;
    }
    if (fingerprint) params.set("fingerprint", fingerprint);

    const url = `${cfg.tronGridBaseUrl}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params.toString()}`;
    const json = await fetchJson(fetchImpl, url, { headers: monitorHeaders(cfg) });
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      // TronGrid's /transactions/trc20 response commonly omits block_number.
      // Enrich it from the receipt before strict parsing and confirmation math.
      let enriched = row;
      if (row?.block_number == null && row?.blockNumber == null && row?.block == null) {
        const txHash = String(row?.transaction_id || row?.txID || row?.hash || "").trim();
        if (!txHash) continue;
        const blockNumber = await fetchTransactionBlockNumber(fetchImpl, cfg, txHash);
        enriched = { ...row, block_number: blockNumber.toString() };
      }
      const parsed = parseTronTx(enriched, cfg.acceptedTokenContracts);
      if (parsed) out.push(parsed);
    }
    fingerprint = typeof json?.meta?.fingerprint === "string" && json.meta.fingerprint ? json.meta.fingerprint : null;
    if (!fingerprint || rows.length === 0) break;
    page += 1;
  }

  out.sort((a, b) => {
    if (a.blockTimestampMs !== b.blockTimestampMs) return a.blockTimestampMs - b.blockTimestampMs;
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.txHash.localeCompare(b.txHash);
  });
  return out;
}

async function listAddressesForCycle(prisma: any, cfg: UsdtMonitorConfig, now: Date) {
  const recentThreshold = new Date(now.getTime() - cfg.lookbackMs);
  return prisma.paymentAddress.findMany({
    where: {
      network: "tron_trc20",
      autoCreditFrozenAt: null,
      AND: [
        {
          OR: [
            { status: "assigned" },
            { updatedAt: { gte: recentThreshold } },
          ],
        },
        {
          OR: [
            { approvedAt: { not: null } },
            { createdBy: null },
          ],
        },
      ],
    },
    orderBy: [
      { status: "asc" },
      { assignedAt: "asc" },
      { updatedAt: "desc" },
    ],
    take: cfg.maxAddressesPerCycle,
    include: { monitorCursor: true },
  });
}

async function upsertRuntimeState(
  prisma: any,
  cfg: UsdtMonitorConfig,
  patch: Partial<{
    lastCycleAt: Date | null;
    lastSuccessAt: Date | null;
    lastBlockNumber: bigint | null;
    lastScannedAddressCount: number;
    lastDiscoveredTxCount: number;
    lastConfirmedCount: number;
    lastRejectedCount: number;
    consecutiveFailures: number;
    lastErrorClass: string | null;
    lastProviderStatus: string | null;
  }>,
) {
  await prisma.usdtMonitorRuntimeState.upsert({
    where: { workerName: cfg.workerName },
    create: {
      workerName: cfg.workerName,
      lastCycleAt: patch.lastCycleAt ?? null,
      lastSuccessAt: patch.lastSuccessAt ?? null,
      lastBlockNumber: patch.lastBlockNumber ?? null,
      lastScannedAddressCount: patch.lastScannedAddressCount ?? 0,
      lastDiscoveredTxCount: patch.lastDiscoveredTxCount ?? 0,
      lastConfirmedCount: patch.lastConfirmedCount ?? 0,
      lastRejectedCount: patch.lastRejectedCount ?? 0,
      consecutiveFailures: patch.consecutiveFailures ?? 0,
      lastErrorClass: patch.lastErrorClass ?? null,
      lastProviderStatus: patch.lastProviderStatus ?? null,
    },
    update: {
      lastCycleAt: patch.lastCycleAt,
      lastSuccessAt: patch.lastSuccessAt,
      lastBlockNumber: patch.lastBlockNumber,
      lastScannedAddressCount: patch.lastScannedAddressCount,
      lastDiscoveredTxCount: patch.lastDiscoveredTxCount,
      lastConfirmedCount: patch.lastConfirmedCount,
      lastRejectedCount: patch.lastRejectedCount,
      consecutiveFailures: patch.consecutiveFailures,
      lastErrorClass: patch.lastErrorClass,
      lastProviderStatus: patch.lastProviderStatus,
    },
  });
}

async function recordCursorSuccess(
  prisma: any,
  addressId: string,
  tx: TronGridTrc20Tx,
  now: Date,
) {
  await prisma.usdtMonitorCursor.upsert({
    where: { addressId },
    create: {
      addressId,
      lastBlockTimestamp: new Date(tx.blockTimestampMs),
      lastTxHashFingerprint: txHashFingerprint(tx.txHash, tx.logIndex),
      lastSuccessAt: now,
      lastErrorClass: null,
      consecutiveFailures: 0,
    },
    update: {
      lastBlockTimestamp: new Date(tx.blockTimestampMs),
      lastTxHashFingerprint: txHashFingerprint(tx.txHash, tx.logIndex),
      lastSuccessAt: now,
      lastErrorClass: null,
      consecutiveFailures: 0,
    },
  });
}

async function recordCursorFailure(
  prisma: any,
  addressId: string,
  errorClass: string,
) {
  const current = await prisma.usdtMonitorCursor.findUnique({ where: { addressId } });
  await prisma.usdtMonitorCursor.upsert({
    where: { addressId },
    create: {
      addressId,
      lastErrorClass: errorClass,
      consecutiveFailures: 1,
    },
    update: {
      lastErrorClass: errorClass,
      consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
    },
  });
}

async function postChainEvent(
  fetchImpl: FetchLike,
  cfg: UsdtMonitorConfig,
  tx: TronGridTrc20Tx,
  latestBlockNumber: bigint,
) {
  const confirmations = Number(latestBlockNumber - tx.blockNumber + 1n);
  const payload = {
    source: "tron_listener_v1",
    network: "tron_trc20",
    txHash: tx.txHash,
    logIndex: tx.logIndex,
    tokenContract: tx.tokenContract,
    fromAddress: tx.fromAddress,
    toAddress: tx.toAddress,
    amountMinor: tx.amountMinor.toString(),
    blockNumber: tx.blockNumber.toString(),
    confirmations,
    confirmationsTarget: cfg.confirmationsTarget,
    receivedAt: new Date(tx.blockTimestampMs).toISOString(),
  };

  let res: Response;
  try {
    res = await fetchImpl(`${cfg.internalBaseUrl}/internal/usdt/chain-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-intune-usdt-worker-secret": cfg.workerSecret,
      },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    const wrapped: any = new Error(err?.message || "internal_network_error");
    wrapped.errorClass = /timed?out/i.test(String(err?.message || "")) ? "network_timeout" : "internal_network_error";
    throw wrapped;
  }

  if (res.status === 200) return { kind: "confirmed" as const };
  if (res.status === 202) return { kind: "confirming" as const };
  if (res.status === 422) return { kind: "rejected" as const };

  const err: any = new Error(`internal_http_${res.status}`);
  err.errorClass = res.status === 401 ? "internal_auth_failed" : res.status >= 500 ? "internal_5xx" : "internal_bad_response";
  throw err;
}

export async function runUsdtMonitorCycle(
  prisma: any,
  cfg: UsdtMonitorConfig,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<MonitorCycleResult> {
  const result: MonitorCycleResult = {
    ok: false,
    scannedAddressCount: 0,
    discoveredTxCount: 0,
    confirmedCount: 0,
    rejectedCount: 0,
    latestBlockNumber: null,
    errorClass: null,
  };

  try {
    const latestBlockNumber = await fetchLatestTronBlockNumber(fetchImpl, cfg);
    result.latestBlockNumber = latestBlockNumber;

    const addresses = await listAddressesForCycle(prisma, cfg, now);
    result.scannedAddressCount = addresses.length;

    for (const address of addresses) {
      const integrity = await verifyAndFreezePaymentAddressIntegrity(prisma, address, "monitor");
      if (!integrity.ok) {
        result.rejectedCount += 1;
        continue;
      }
      const cursorBaseMs = address.monitorCursor?.lastBlockTimestamp
        ? new Date(address.monitorCursor.lastBlockTimestamp).getTime() - CURSOR_OVERLAP_MS
        : now.getTime() - cfg.lookbackMs;
      const minTimestampMs = Math.max(now.getTime() - cfg.lookbackMs, cursorBaseMs);

      try {
        const txs = await fetchTrc20TransactionsForAddress(fetchImpl, cfg, address.address, minTimestampMs);
        for (const tx of txs) {
          result.discoveredTxCount += 1;
          const outcome = await postChainEvent(fetchImpl, cfg, tx, latestBlockNumber);
          if (outcome.kind === "confirmed") result.confirmedCount += 1;
          if (outcome.kind === "rejected") result.rejectedCount += 1;
          await recordCursorSuccess(prisma, address.id, tx, now);
        }
      } catch (err: any) {
        const errorClass = String(err?.errorClass || "unknown_error");
        result.errorClass = errorClass;
        await recordCursorFailure(prisma, address.id, errorClass);
        throw err;
      }
    }

    result.ok = true;
    await upsertRuntimeState(prisma, cfg, {
      lastCycleAt: now,
      lastSuccessAt: now,
      lastBlockNumber: result.latestBlockNumber,
      lastScannedAddressCount: result.scannedAddressCount,
      lastDiscoveredTxCount: result.discoveredTxCount,
      lastConfirmedCount: result.confirmedCount,
      lastRejectedCount: result.rejectedCount,
      consecutiveFailures: 0,
      lastErrorClass: null,
      lastProviderStatus: "ok",
    });

    if (result.scannedAddressCount > 0 || result.discoveredTxCount > 0) {
      emitStructuredLog({
        event: "usdt_monitor_cycle_ok",
        errorClass: "business",
        retryHint: 0,
        note: "tron_grid_poll_cycle_completed",
        counts: {
          scannedAddresses: result.scannedAddressCount,
          discoveredTx: result.discoveredTxCount,
          confirmed: result.confirmedCount,
          rejected: result.rejectedCount,
        },
      });
    }
    return result;
  } catch (err: any) {
    const errorClass = String(err?.errorClass || "unknown_error");
    result.errorClass = errorClass;
    const current = await prisma.usdtMonitorRuntimeState.findUnique({ where: { workerName: cfg.workerName } });
    const nextFailures = (current?.consecutiveFailures ?? 0) + 1;
    await upsertRuntimeState(prisma, cfg, {
      lastCycleAt: now,
      lastBlockNumber: result.latestBlockNumber,
      lastScannedAddressCount: result.scannedAddressCount,
      lastDiscoveredTxCount: result.discoveredTxCount,
      lastConfirmedCount: result.confirmedCount,
      lastRejectedCount: result.rejectedCount,
      consecutiveFailures: nextFailures,
      lastErrorClass: errorClass,
      lastProviderStatus: errorClass,
    });

    emitSafetyEvent(
      {
        event: "usdt_monitor_cycle_failed",
        errorClass: "third_party",
        retryHint: 1,
        note: "tron_grid_poll_cycle_failed",
        addressId: result.scannedAddressCount > 0 ? shortFingerprint("address_batch", String(result.scannedAddressCount)) : undefined,
        counts: {
          scannedAddresses: result.scannedAddressCount,
          discoveredTx: result.discoveredTxCount,
          consecutiveFailures: nextFailures,
        } as any,
      },
      err,
    );
    return result;
  }
}

export function nextMonitorDelayMs(cfg: UsdtMonitorConfig, failures: number): number {
  if (failures <= 0) return cfg.pollIntervalMs;
  return Math.min(cfg.pollIntervalMs * Math.pow(2, Math.min(failures, 3)), USDT_MONITOR_MAX_BACKOFF_MS);
}
