import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const prisma = new PrismaClient();
const user = await prisma.user.findFirstOrThrow({ where: { telegramUserId: 1000000001n } });
const membershipProduct = await prisma.product.findFirstOrThrow({ where: { type: "membership", status: "active" } });
console.log("demo user:", user.id, "membership product:", membershipProduct.id, "price:", membershipProduct.priceMinor.toString(), membershipProduct.currency);
function genOrderNo() {
  const d = new Date();
  const pad = n => String(n).padStart(2,"0");
  const datePart = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const rnd = crypto.randomBytes(6).toString("hex");
  return `ORD${datePart}${rnd.toUpperCase()}`;
}
const orderNo = genOrderNo();
const order = await prisma.order.create({
  data: {
    orderNo,
    userId: user.id,
    productId: membershipProduct.id,
    amountMinor: membershipProduct.priceMinor,
    currency: membershipProduct.currency || "XTR",
    status: "pending",
    paymentProvider: "manual",
  },
  include: { product: true, entitlements: true },
});
console.log("CREATED_PENDING_ORDER_NO=", order.orderNo);
console.log("status=", order.status, "amountMinor=", order.amountMinor.toString(), "product=", order.product.title, "entitlements count=", order.entitlements.length);
console.log("USER_ID_FOR_DIRECT_API_TEST=", user.id);
await prisma.$disconnect();
