import assert from "node:assert/strict";
import test from "node:test";
import { runEntitlementSweep } from "../src/services/entitlementsCron.js";
import {
  setupTestHarness,
  teardownTestHarness,
  seedTestData,
} from "./_testHarness.js";

const harness = await setupTestHarness();
const prisma = harness.prisma;
await seedTestData(prisma);

test.after(async () => {
  await teardownTestHarness(prisma);
});

test("entitlements-sweep: mark-expired updateMany idempotent + status transition only for active+expired rows", async () => {
  const now = Date.now();
  const tgid = BigInt(7000000000 + (now % 100_000_000));
  const user = await prisma.user.create({
    data: { telegramUserId: tgid, displayName: `Cron Test ${tgid.toString()}` },
  });
  const t1 = new Date(now - 10 * 60 * 1000); // 10min ago — should expire
  const t2 = new Date(now + 2 * 24 * 3600 * 1000); // 2d from now — not yet
  const t3 = new Date(now - 60 * 60 * 1000); // 1h ago — already expired below

  const entExpired1 = await prisma.entitlement.create({
    data: { userId: user.id, resourceType: "membership_channel", resourceId: "membership-main", status: "active", startsAt: new Date(now - 60 * 24 * 3600 * 1000), expiresAt: t1 },
  });
  const entNotYet = await prisma.entitlement.create({
    data: { userId: user.id, resourceType: "package", resourceId: "pkg-test-future", status: "active", startsAt: new Date(), expiresAt: t2 },
  });
  const entAlreadyExpired = await prisma.entitlement.create({
    data: { userId: user.id, resourceType: "content", resourceId: "topic-old", status: "expired", startsAt: new Date(now - 90 * 24 * 3600 * 1000), expiresAt: t3 },
  });

  const r1 = await runEntitlementSweep(prisma);
  assert.ok(r1.markedExpired >= 1, `expected at least 1 expired row, got ${r1.markedExpired}`);

  const ent1 = await prisma.entitlement.findUniqueOrThrow({ where: { id: entExpired1.id } });
  assert.equal(ent1.status, "expired", "entExpired1 must become expired after sweep");
  const ent2 = await prisma.entitlement.findUniqueOrThrow({ where: { id: entNotYet.id } });
  assert.equal(ent2.status, "active", "entNotYet must remain active");
  const ent3 = await prisma.entitlement.findUniqueOrThrow({ where: { id: entAlreadyExpired.id } });
  assert.equal(ent3.status, "expired", "entAlreadyExpired stayed expired");

  const r2 = await runEntitlementSweep(prisma);
  const afterSweep2 = await prisma.entitlement.findMany({
    where: { id: { in: [entExpired1.id, entNotYet.id, entAlreadyExpired.id] } },
    select: { id: true, status: true },
  });
  const stillExpiredIds = afterSweep2.filter((e) => e.status === "expired").map((e) => e.id).sort();
  assert.deepEqual(stillExpiredIds, [entAlreadyExpired.id, entExpired1.id].sort(), "idempotent: 2nd sweep didn't re-change statuses");
  void r2;
});
