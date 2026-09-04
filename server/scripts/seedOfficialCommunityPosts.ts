import { PrismaClient } from "@prisma/client";

const CONFIRM_FLAG = "--confirm-official-ai-seed";
const OFFICIAL_TELEGRAM_USER_ID = BigInt("9000000000001");

const POSTS = [
  {
    body: "欢迎来到同频社区。这里用于交流成年人之间的沟通、边界、兴趣与复盘。请尊重他人、保护隐私；图文投稿会先经过审核后再公开。",
    topics: ["社区公告", "边界", "沟通"],
    seoTitle: "同频社区使用说明：尊重、边界与隐私",
    seoDescription: "同频社区的成年人交流说明：尊重他人、明确边界、保护隐私，投稿先审核后公开。",
    seoKeywords: ["同频社区", "边界", "沟通", "隐私"],
    geoKeywords: ["成年人沟通", "边界协商"],
  },
  {
    body: "第一次参与讨论时，可以从“我期待什么、哪些事情不舒服、需要怎样的确认”开始表达。清晰表达不是扫兴，而是让彼此更安心。",
    topics: ["新手", "沟通", "安全"],
    seoTitle: "初次沟通从哪里开始：把期待与边界说清楚",
    seoDescription: "面向成年人的沟通提示：从期待、不适与确认方式开始，建立更清晰的互动边界。",
    seoKeywords: ["初次沟通", "安全", "边界"],
    geoKeywords: ["成人关系沟通", "同意"],
  },
  {
    body: "每次交流结束后，也值得留一点时间复盘：哪些部分感觉舒适，哪些地方下次需要调整。持续反馈能让关系更稳定，也让边界保持鲜明。",
    topics: ["复盘", "照护", "反馈"],
    seoTitle: "互动后的复盘与照护：让反馈成为习惯",
    seoDescription: "成年人互动后的复盘提示：记录舒适与需要调整之处，以持续反馈维护关系和边界。",
    seoKeywords: ["复盘", "照护", "反馈"],
    geoKeywords: ["关系维护", "边界反馈"],
  },
  {
    body: "如果你想分享经验，请避免发布任何能识别他人的信息。用概括性的场景、自己的感受和可执行的沟通建议，会让讨论对更多人有帮助。",
    topics: ["隐私", "经验分享", "社区规则"],
    seoTitle: "分享经验时如何保护隐私",
    seoDescription: "同频社区经验分享提示：避免可识别信息，以自己的感受和可执行建议参与讨论。",
    seoKeywords: ["隐私保护", "经验分享", "社区规则"],
    geoKeywords: ["线上社区安全", "隐私"],
  },
  {
    body: "社区不会替代专业支持。如果你感到被施压、被威胁，或无法安全地表达拒绝，请优先离开不安全的环境，并向可信赖的人或专业机构求助。",
    topics: ["安全提醒", "支持", "边界"],
    seoTitle: "安全提醒：拒绝、离开与寻求支持",
    seoDescription: "当无法安全表达拒绝或感到被施压时，优先离开不安全环境，并向可信赖的人或专业机构求助。",
    seoKeywords: ["安全提醒", "拒绝", "求助"],
    geoKeywords: ["人身安全", "边界支持"],
  },
] as const;

if (!process.argv.includes(CONFIRM_FLAG)) {
  throw new Error(`Refusing to seed production data without ${CONFIRM_FLAG}`);
}

const prisma = new PrismaClient();

try {
  const author = await prisma.user.upsert({
    where: { telegramUserId: OFFICIAL_TELEGRAM_USER_ID },
    update: {
      displayName: "Samewave 官方 · AI 协助",
      status: "active",
    },
    create: {
      telegramUserId: OFFICIAL_TELEGRAM_USER_ID,
      displayName: "Samewave 官方 · AI 协助",
      status: "active",
    },
  });
  const auditAdmin = await prisma.adminUser.findFirst({
    where: { status: "active" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!auditAdmin) throw new Error("No active admin is available for the official seed audit log");

  let createdCount = 0;
  for (const post of POSTS) {
    const existing = await prisma.communityPost.findFirst({
      where: { authorId: author.id, body: post.body },
      select: { id: true },
    });
    if (existing) continue;
    const created = await prisma.communityPost.create({
      data: {
        authorId: author.id,
        body: post.body,
        topics: [...post.topics],
        seoTitle: post.seoTitle,
        seoDescription: post.seoDescription,
        seoKeywords: [...post.seoKeywords],
        geoKeywords: [...post.geoKeywords],
        searchIndexable: true,
        isOfficial: true,
        aiAssisted: true,
        status: "published",
        publishedAt: new Date(),
      },
    });
    await prisma.adminAuditLog.create({
      data: {
        adminId: auditAdmin.id,
        action: "community.post.seed_official_ai",
        objectType: "community_post",
        objectId: created.id,
        afterValue: {
          isOfficial: true,
          aiAssisted: true,
          searchIndexable: true,
          source: "seedOfficialCommunityPosts",
        },
        reason: "官方 AI 协助首批社区内容；未创建点赞、评论或伪造用户互动。",
      },
    });
    createdCount += 1;
  }
  console.log(JSON.stringify({ ok: true, createdCount, total: POSTS.length }));
} finally {
  await prisma.$disconnect();
}
