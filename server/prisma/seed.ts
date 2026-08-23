import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  encryptPackageColsFromPlain,
  encryptContentColsFromPlain,
} from "../src/services/channelCrypto.js";

const prisma = new PrismaClient();

const IS_PRODUCTION = process.env.NODE_ENV === "production";
if (IS_PRODUCTION && process.env.ADMIN_SEED_FORCE !== "1") {
  console.error(
    "[seed] FATAL: NODE_ENV=production but ADMIN_SEED_FORCE!==1. Refusing to wipe/reseed production DB.\n" +
      "Set ADMIN_SEED_FORCE=1 to explicitly confirm you want to delete production data, or run in NODE_ENV=development / staging.",
  );
  process.exit(2);
}

const DEFAULT_SUPERADMIN_PASSWORD = "ChangeMeSuperAdmin!123";
const DEFAULT_OPERATOR_PASSWORD = "ChangeMeOperator!456";
function isDefaultPassword(pw: string) {
  return pw === DEFAULT_SUPERADMIN_PASSWORD || pw === DEFAULT_OPERATOR_PASSWORD;
}

async function hashPw(pw: string) {
  return bcrypt.hash(pw, 10);
}

async function main() {
  console.log("[seed] 开始清理旧数据...");
  await prisma.$transaction([
    prisma.adminAuditLog.deleteMany(),
    prisma.telegramInvite.deleteMany(),
    prisma.entitlement.deleteMany(),
    prisma.order.deleteMany(),
    prisma.contentCategory.deleteMany(),
    prisma.content.deleteMany(),
    prisma.banner.deleteMany(),
    prisma.category.deleteMany(),
    prisma.contentPackage.deleteMany(),
    prisma.product.deleteMany(),
    prisma.adminUser.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  console.log("[seed] 创建管理员账号...");
  const superAdminEmail = process.env.SEED_SUPERADMIN_EMAIL || "superadmin@intune.local";
  const superAdminPassword = process.env.SEED_SUPERADMIN_PASSWORD || DEFAULT_SUPERADMIN_PASSWORD;
  const operatorEmail = process.env.SEED_OPERATOR_EMAIL || "operator@intune.local";
  const operatorPassword = process.env.SEED_OPERATOR_PASSWORD || DEFAULT_OPERATOR_PASSWORD;
  if (isDefaultPassword(superAdminPassword) || isDefaultPassword(operatorPassword)) {
    const msg =
      "[seed] ⚠️  仍然使用 seed 默认管理员密码。" +
      "请在 .env / 部署 secret 中明确设置 SEED_SUPERADMIN_PASSWORD / SEED_OPERATOR_PASSWORD 为唯一强密码后再重新执行 prisma:seed。";
    if (IS_PRODUCTION) {
      console.error("[seed] FATAL (production): " + msg);
      throw new Error(msg);
    } else {
      console.warn(msg);
    }
  }

  const [superAdminHash, operatorHash] = await Promise.all([
    hashPw(superAdminPassword),
    hashPw(operatorPassword),
  ]);

  const superAdmin = await prisma.adminUser.create({
    data: {
      email: superAdminEmail,
      passwordHash: superAdminHash,
      displayName: "超级管理员",
      role: "super_admin",
      status: "active",
    },
  });
  const operatorAdmin = await prisma.adminUser.create({
    data: {
      email: operatorEmail,
      passwordHash: operatorHash,
      displayName: "运营补单",
      role: "operator",
      status: "active",
    },
  });

  console.log("[seed] 创建分类...");
  const catAll = await prisma.category.create({
    data: { name: "全部", slug: "all", sortOrder: 0, status: "active" },
  });
  const catFeatured = await prisma.category.create({
    data: { name: "精选", slug: "featured", sortOrder: 1, status: "active" },
  });
  const catGuide = await prisma.category.create({
    data: { name: "导览", slug: "guide", sortOrder: 2, status: "active" },
  });
  const catInterview = await prisma.category.create({
    data: { name: "访谈", slug: "interview", sortOrder: 3, status: "active" },
  });

  console.log("[seed] 创建 Banner...");
  const now = new Date();
  const oneMonthLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await prisma.banner.createMany({
    data: [
      {
        title: "关注同频公开频道",
        description: "获取最新预告、公开样本与平台通知。",
        imageUrl: null,
        actionLabel: "前往频道",
        targetType: "external",
        targetId: "https://t.me/InTune_bdsm",
        externalUrl: "https://t.me/InTune_bdsm",
        sortOrder: 0,
        status: "active",
        startsAt: now,
        endsAt: oneMonthLater,
        categoryId: null,
      },
      {
        title: "本周精选内容",
        description: "从经过整理的主题内容开始发现。",
        imageUrl: null,
        actionLabel: "查看精选",
        targetType: "category",
        targetId: catFeatured.id,
        sortOrder: 1,
        status: "active",
        startsAt: now,
        endsAt: oneMonthLater,
        categoryId: catFeatured.id,
      },
    ],
  });

  console.log("[seed] 创建商品...");
  const productWelcome = await prisma.product.create({
    data: {
      type: "single",
      title: "新成员导览",
      priceMinor: BigInt(0),
      currency: "XTR",
      status: "active",
    },
  });
  const productFeaturedPack = await prisma.product.create({
    data: {
      type: "package",
      title: "主题精选内容包",
      priceMinor: BigInt(99),
      currency: "XTR",
      status: "active",
    },
  });
  const productMonthly = await prisma.product.create({
    data: {
      type: "membership",
      title: "月度会员",
      priceMinor: BigInt(299),
      currency: "XTR",
      durationDays: 30,
      status: "active",
    },
  });

  console.log("[seed] 创建内容包...");
  const pkgFeaturedPlainChannel = BigInt(-1000000000001);
  const pkgEnc = encryptPackageColsFromPlain(pkgFeaturedPlainChannel);
  const pkgFeatured = await prisma.contentPackage.create({
    data: {
      title: "主题内容精选",
      coverUrl: null,
      channelId: pkgFeaturedPlainChannel, // deprecated 列，过渡期保留
      channelIdCiphertext: pkgEnc.channelIdCiphertextB64,
      channelIdHmac: pkgEnc.channelIdHmac,
      productId: productFeaturedPack.id,
      status: "published",
    },
  });

  console.log("[seed] 创建内容...");
  const contentWelcome = await prisma.content.create({
    data: {
      id: "welcome",
      title: "同频 · 新成员导览",
      description: "认识社区边界、内容规则与成员权益。",
      durationSeconds: 3 * 60 + 20,
      accessType: "public",
      status: "published",
      isRecommended: true,
      isNewArrival: true,
      featuredSort: 1,
      recommendStartsAt: now,
      recommendEndsAt: oneMonthLater,
      productId: productWelcome.id,
      publishedAt: now,
    },
  });
  const contentTopic1 = await prisma.content.create({
    data: {
      id: "topic-01",
      title: "主题内容 · 第一辑",
      description: "已授权的精选内容；完整访问需拥有对应会员权益。",
      durationSeconds: 18 * 60 + 42,
      accessType: "package",
      status: "published",
      isFeatured: true,
      featuredSort: 2,
      packageId: pkgFeatured.id,
      productId: productFeaturedPack.id,
      publishedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    },
  });
  const contentTopic2 = await prisma.content.create({
    data: {
      id: "topic-02",
      title: "创作者访谈 · 真实表达",
      description: "围绕理解、尊重与个人边界展开的对话。",
      durationSeconds: 24 * 60 + 10,
      accessType: "membership",
      status: "published",
      isFeatured: true,
      featuredSort: 3,
      productId: productMonthly.id,
      publishedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
    },
  });
  const contentTopic3 = await prisma.content.create({
    data: {
      id: "topic-03",
      title: "主题内容 · 第二辑",
      description: "加入内容包后可持续查看同主题更新。",
      durationSeconds: 16 * 60 + 35,
      accessType: "package",
      status: "published",
      isRecommended: true,
      featuredSort: 4,
      recommendStartsAt: now,
      recommendEndsAt: oneMonthLater,
      packageId: pkgFeatured.id,
      productId: productFeaturedPack.id,
      publishedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
    },
  });

  console.log("[seed] 关联内容与分类...");
  await prisma.contentCategory.createMany({
    data: [
      { contentId: contentWelcome.id, categoryId: catGuide.id },
      { contentId: contentTopic1.id, categoryId: catFeatured.id },
      { contentId: contentTopic2.id, categoryId: catInterview.id },
      { contentId: contentTopic3.id, categoryId: catFeatured.id },
    ],
    skipDuplicates: true,
  });

  console.log("[seed] 创建测试用户（本地 Demo 用）...");
  const demoUser = await prisma.user.create({
    data: {
      telegramUserId: BigInt(1000000001),
      username: "demo_user",
      displayName: "Demo User",
      photoUrl: null,
      status: "active",
    },
  });

  console.log("[seed] 给 demo 用户授予会员权益...");
  await prisma.entitlement.create({
    data: {
      userId: demoUser.id,
      resourceType: "membership_channel",
      resourceId: "membership-main",
      sourceOrderId: null,
      startsAt: now,
      expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      status: "active",
    },
  });

  console.log("[seed] 完成！demo Telegram User ID:", demoUser.telegramUserId.toString());
  // 密码及邮箱都属于认证凭证，严禁进入 stdout/stderr、CI、日志或部署输出。
  console.log("[seed] 管理员账号初始化完成；凭证仅保存在受控部署密钥存储中。");
  console.log("[seed] 请在首次登录后立即轮换管理员密码，并删除临时引导凭证。");
}

main()
  .catch((e) => {
    console.error("[seed] 失败:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
