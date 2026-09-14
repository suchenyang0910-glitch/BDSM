import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmUsdtChainEvent,
  deliverStarsSuccessfulPayment,
  rawEventHashForTelegram,
  starsPaymentPayloadForOrder,
} from "../src/services/orders.js";
import { userIdIndexKey } from "../src/utils/crypto.js";
import {
  setupTestHarness,
  teardownTestHarness,
} from "./_testHarness.js";

const harness = await setupTestHarness();
const prisma = harness.prisma;

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("Stars successful payment writes trusted server-side payment analytics", async () => {
  const user = await prisma.user.create({
    data: { telegramUserId: 882200000001n, displayName: "payment analytics stars" },
  });
  const product = await prisma.product.create({
    data: {
      title: "Stars analytics membership",
      type: "membership",
      priceMinor: 99n,
      currency: "XTR",
      durationDays: 30,
      status: "active",
    },
  });
  const orderNo = `INTPAYSTARS${Date.now().toString().slice(-8)}`;
  const { payloadPlain, payloadHmac } = starsPaymentPayloadForOrder({
    orderNo,
    userId: user.id,
    amountMinor: 99n,
  });
  await prisma.order.create({
    data: {
      orderNo,
      userId: user.id,
      productId: product.id,
      amountMinor: 99n,
      currency: "XTR",
      paymentMethod: "telegram_stars",
      paymentProvider: "telegram_stars",
      paymentPayloadHmac: payloadHmac,
      telegramUserIdHmac: userIdIndexKey(882200000001n),
      status: "pending",
    },
  });

  const result = await deliverStarsSuccessfulPayment(prisma, {
    telegramPaymentChargeId: `CHG_ANALYTICS_${Date.now()}`,
    rawEventHash: rawEventHashForTelegram("test", Date.now(), `CHG_ANALYTICS_${Date.now()}`),
    payloadPlain,
    telegramUserIdPlain: 882200000001n,
    amountMinor: 99n,
    currency: "XTR",
    botKey: "test",
  });
  assert.equal(result.delivered, true, JSON.stringify(result));

  const event = await prisma.analyticsEvent.findFirst({
    where: { eventName: "payment_confirmed", userId: user.id, platform: "server" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(event);
  const props = event.propertiesJson as Record<string, unknown>;
  assert.equal(props.paymentMethod, "telegram_stars");
  assert.equal(typeof props.orderNoHmac, "string");
  assert.equal("orderNo" in props, false);
});

test("USDT chain confirmation writes trusted server-side payment analytics", async () => {
  const address = await prisma.paymentAddress.create({
    data: {
      network: "tron_trc20",
      address: "TAnalyticsPayment00000000001",
      addressMasked: "TAn...001",
      status: "assigned",
      assignedAt: new Date(),
      releaseAt: new Date(Date.now() + 20 * 60 * 1000),
    },
  });
  const user = await prisma.user.create({
    data: { telegramUserId: 882200000002n, displayName: "payment analytics usdt" },
  });
  const product = await prisma.product.create({
    data: {
      title: "USDT analytics membership",
      type: "membership",
      priceMinor: 990000n,
      currency: "USDT",
      durationDays: 30,
      status: "active",
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNo: `INTPAYUSDT${Date.now().toString().slice(-8)}`,
      userId: user.id,
      productId: product.id,
      amountMinor: 990042n,
      currency: "USDT",
      paymentMethod: "usdt_trc20_external",
      paymentProvider: "tron_trc20_external",
      status: "pending",
      expiresAt: new Date(Date.now() + 20 * 60 * 1000),
      usdtPaymentAddressId: address.id,
    },
  });
  await prisma.paymentAddress.update({
    where: { id: address.id },
    data: { assignedOrderId: order.id },
  });

  const result = await confirmUsdtChainEvent(prisma, {
    source: "unit_test",
    network: "tron_trc20",
    txHash: `USDT_ANALYTICS_${Date.now()}`,
    tokenContract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    fromAddress: "TFromAnalyticsPayment001",
    toAddress: address.address,
    amountMinor: 990042n,
    blockNumber: 70000001n,
    confirmations: 25,
    confirmationsTarget: 19,
  });
  assert.equal(result.status, "confirmed", JSON.stringify(result));

  const event = await prisma.analyticsEvent.findFirst({
    where: { eventName: "payment_confirmed", userId: user.id, platform: "server" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(event);
  const props = event.propertiesJson as Record<string, unknown>;
  assert.equal(props.paymentMethod, "usdt_trc20");
  assert.equal(typeof props.orderNoHmac, "string");
  assert.equal("orderNo" in props, false);
});
