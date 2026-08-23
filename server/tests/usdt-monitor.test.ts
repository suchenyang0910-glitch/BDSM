import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { setupTestHarness, teardownTestHarness, seedTestData } from "./_testHarness.js";
import { loadUsdtMonitorConfig, parseTronTx, runUsdtMonitorCycle } from "../src/services/usdtMonitor.js";

const harness = await setupTestHarness();
const prisma: PrismaClient = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

function makeConfig() {
  process.env.TRON_GRID_API_KEY = "test-trongrid-key";
  process.env.USDT_WORKER_SECRET = "test-usdt-worker-secret-1234567890";
  process.env.USDT_ACCEPTED_TOKEN_CONTRACTS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  process.env.SERVER_PORT = "3000";
  return loadUsdtMonitorConfig(process.env);
}

test("USDT monitor parses valid TRC20 tx and rejects wrong decimals", () => {
  const valid = parseTronTx(
    {
      transaction_id: "tx1",
      block_timestamp: Date.now(),
      block_number: 123,
      from: "TA1111111111111111111111111111111111",
      to: "TB1111111111111111111111111111111111",
      value: "1234567",
      token_info: { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
    },
    ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"],
  );
  assert.ok(valid);
  assert.equal(valid?.amountMinor.toString(), "1234567");

  const invalid = parseTronTx(
    {
      transaction_id: "tx2",
      block_timestamp: Date.now(),
      block_number: 123,
      from: "TA1111111111111111111111111111111111",
      to: "TB1111111111111111111111111111111111",
      value: "1234567",
      token_info: { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 18 },
    },
    ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"],
  );
  assert.equal(invalid, null);
});

test("USDT monitor cycle posts discovered tx and records runtime status", async () => {
  const cfg = makeConfig();
  const address = await prisma.paymentAddress.create({
    data: {
      network: "tron_trc20",
      address: "TMonitorAddress111111111111111111111111111",
      addressMasked: "TMon...1111",
      status: "assigned",
    },
  });

  const calls: Array<{ url: string; body?: any }> = [];
  const fakeFetch: typeof fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("/wallet/getnowblock")) {
      return new Response(JSON.stringify({ block_header: { raw_data: { number: 120 } } }), { status: 200 });
    }
    if (url.includes("/transactions/trc20")) {
      return new Response(JSON.stringify({
        data: [
          {
            transaction_id: "tx-monitor-1",
            block_timestamp: Date.now(),
            block_number: 100,
            from: "TFrom111111111111111111111111111111111",
            to: address.address,
            value: "2000000",
            token_info: { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
          },
        ],
        meta: {},
      }), { status: 200 });
    }
    if (url.includes("/internal/usdt/chain-event")) {
      return new Response(JSON.stringify({ ok: true, status: "confirmed" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as any;

  const result = await runUsdtMonitorCycle(prisma, cfg, fakeFetch, new Date());
  assert.equal(result.ok, true);
  assert.equal(result.scannedAddressCount, 1);
  assert.equal(result.discoveredTxCount, 1);
  assert.equal(result.confirmedCount, 1);
  const internalCall = calls.find((c) => c.url.includes("/internal/usdt/chain-event"));
  assert.ok(internalCall);
  assert.equal(internalCall?.body?.network, "tron_trc20");
  assert.equal(internalCall?.body?.txHash, "tx-monitor-1");

  const runtime = await prisma.usdtMonitorRuntimeState.findUnique({ where: { workerName: cfg.workerName } });
  assert.ok(runtime);
  assert.equal(runtime?.lastConfirmedCount, 1);
  const cursor = await prisma.usdtMonitorCursor.findUnique({ where: { addressId: address.id } });
  assert.ok(cursor?.lastTxHashFingerprint);
});

test("USDT monitor keeps cursor on internal 202 and marks failure on provider 429", async () => {
  const cfg = makeConfig();
  const address = await prisma.paymentAddress.create({
    data: {
      network: "tron_trc20",
      address: "TMonitorAddress222222222222222222222222222",
      addressMasked: "TMon...2222",
      status: "assigned",
    },
  });

  const confirmingFetch: typeof fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.includes("/wallet/getnowblock")) {
      return new Response(JSON.stringify({ block_header: { raw_data: { number: 118 } } }), { status: 200 });
    }
    if (url.includes("/transactions/trc20")) {
      return new Response(JSON.stringify({
        data: [{
          transaction_id: "tx-monitor-2",
          block_timestamp: Date.now(),
          block_number: 110,
          from: "TFrom222222222222222222222222222222222",
          to: address.address,
          value: "3000000",
          token_info: { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
        }],
        meta: {},
      }), { status: 200 });
    }
    if (url.includes("/internal/usdt/chain-event")) {
      return new Response(JSON.stringify({ ok: true, status: "confirming" }), { status: 202 });
    }
    return new Response("not found", { status: 404 });
  }) as any;

  const confirming = await runUsdtMonitorCycle(prisma, cfg, confirmingFetch, new Date());
  assert.equal(confirming.ok, true);

  const failingFetch: typeof fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.includes("/wallet/getnowblock")) {
      return new Response(JSON.stringify({ block_header: { raw_data: { number: 118 } } }), { status: 200 });
    }
    if (url.includes("/transactions/trc20")) {
      return new Response(JSON.stringify({ error: "too many requests" }), { status: 429 });
    }
    return new Response("not found", { status: 404 });
  }) as any;

  const failed = await runUsdtMonitorCycle(prisma, cfg, failingFetch, new Date());
  assert.equal(failed.ok, false);
  assert.equal(failed.errorClass, "provider_429");
  const cursor = await prisma.usdtMonitorCursor.findUnique({ where: { addressId: address.id } });
  assert.equal(cursor?.lastErrorClass, "provider_429");
  assert.ok((cursor?.consecutiveFailures || 0) >= 1);
});
