import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { constantTimeEqual } from "../utils/crypto.js";
import { confirmUsdtChainEvent, rawEventHashForUsdt } from "../services/orders.js";
import { USDT_CONFIRMATIONS_TARGET_DEFAULT, USDT_TRON_TOKEN_CONTRACT_DEFAULT } from "../services/usdtPool.js";

export const USDT_INTERNAL_HEADER = "x-intune-usdt-worker-secret";
const DEFAULT_ALLOWED_CONTRACTS = [USDT_TRON_TOKEN_CONTRACT_DEFAULT];

const chainEventSchema = z.object({
  source: z.string().min(1).max(64).default("tron_listener_v1"),
  network: z.string().min(1).max(32),
  txHash: z.string().min(1).max(256),
  tokenContract: z.string().min(1).max(128),
  fromAddress: z.string().min(1).max(64),
  toAddress: z.string().min(1).max(64),
  amountMinor: z.union([z.string(), z.bigint(), z.number().int()]),
  blockNumber: z.union([z.string(), z.bigint(), z.number().int()]),
  confirmations: z.coerce.number().int().min(0),
  confirmationsTarget: z.coerce.number().int().min(1).optional(),
  receivedAt: z.coerce.date().optional(),
});

export default async function usdtInternalRoutes(fastify: FastifyInstance) {
  // 前置 Gate：header 恒时比较
  fastify.addHook("onRequest", async (req: any, reply: any) => {
    const expected = process.env.USDT_WORKER_SECRET;
    if (!expected || expected.length < 24) {
      return reply.status(500).send({ error: "misconfigured", reason: "USDT_WORKER_SECRET_missing" });
    }
    const given = (req.headers as any)[USDT_INTERNAL_HEADER.toLowerCase()] || (req.headers as any)[USDT_INTERNAL_HEADER];
    if (!given || typeof given !== "string") {
      return reply.status(401).send({ error: "unauthorized", reason: "missing_worker_secret" });
    }
    if (!constantTimeEqual(expected, given)) {
      return reply.status(401).send({ error: "unauthorized", reason: "bad_worker_secret" });
    }
  });

  fastify.post("/internal/usdt/chain-event", async (req: any, reply: any) => {
    const parsed = chainEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "bad_request", details: parsed.error.issues });
    }
    const body = parsed.data;
    const acceptedTokens = process.env.USDT_ACCEPTED_TOKEN_CONTRACTS
      ? process.env.USDT_ACCEPTED_TOKEN_CONTRACTS.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ALLOWED_CONTRACTS;
    const confirmationsTarget = body.confirmationsTarget ??
      (process.env.USDT_CONFIRMATIONS_TARGET ? Number(process.env.USDT_CONFIRMATIONS_TARGET) : null) ??
      USDT_CONFIRMATIONS_TARGET_DEFAULT;

    const result = await confirmUsdtChainEvent(req.prisma || (fastify as any).prisma, {
      source: body.source,
      network: body.network,
      txHash: body.txHash,
      tokenContract: body.tokenContract,
      fromAddress: body.fromAddress,
      toAddress: body.toAddress,
      amountMinor: body.amountMinor,
      blockNumber: body.blockNumber,
      confirmations: body.confirmations,
      confirmationsTarget,
      receivedAt: body.receivedAt,
      acceptedTokenContracts: acceptedTokens,
    });

    // 语义化 HTTP 状态码（不影响幂等）
    if (result.status === "rejected" && result.errorClass?.startsWith("tx_")) {
      return reply.status(502).send({ ok: false, ...result, eventHash: rawEventHashForUsdt(body.source, body.network, body.txHash).slice(0, 16) });
    }
    if (result.status === "rejected") {
      return reply.status(422).send({ ok: false, ...result });
    }
    if (result.status === "confirming") {
      return reply.status(202).send({ ok: true, ...result });
    }
    // confirmed / idempotent
    return reply.status(200).send({ ok: true, ...result });
  });

  fastify.get("/internal/usdt/status", async (_req: any, reply: any) => {
    return reply.status(200).send({
      ok: true,
      authRequiredHeader: USDT_INTERNAL_HEADER,
      acceptedTokenContractsDefault: DEFAULT_ALLOWED_CONTRACTS,
      confirmationsTargetDefault: USDT_CONFIRMATIONS_TARGET_DEFAULT,
      endpoint: "/internal/usdt/chain-event",
    });
  });
}
