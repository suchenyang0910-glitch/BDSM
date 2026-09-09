import { PrismaClient } from "@prisma/client";

/**
 * 14 日社区冷启动实验。
 *
 * 只发布清晰标注为“Samewave 官方 · AI 协助”的审核后引导帖；不创建或模拟
 * 用户账号、点赞、评论、阅读、举报等互动。默认 dry-run，生产写入必须显式确认。
 */
const CONFIRM_FLAG = "--confirm-official-ai-experiment";
const DRY_RUN_FLAG = "--dry-run";
const CAMPAIGN_ID = "official-ai-guided-interaction-2026-09";
const OFFICIAL_TELEGRAM_USER_ID = BigInt("9000000000001");
const CAMPAIGN_START_AT = new Date("2026-09-09T14:00:00.000Z");

type Prompt = {
  day: number;
  hourUtc?: number;
  body: string;
  topics: string[];
  seoTitle: string;
  seoDescription: string;
};

const PROMPTS: Prompt[] = [
  { day: 0, body: "14 天真实互动实验现在开始。你希望这里先多出现哪一类讨论：沟通、边界、复盘，还是新手入门？请只分享自己愿意公开的想法。", topics: ["官方引导", "社区实验", "沟通"], seoTitle: "同频社区真实互动实验启动", seoDescription: "同频官方 AI 协助发起 14 天透明互动实验，邀请成年用户选择最需要的讨论主题。" },
  { day: 1, hourUtc: 3, body: "讨论题：在一段关系或互动开始前，你最希望先确认的一件事是什么？可以是一句话、一个规则，或一种更舒服的沟通方式。", topics: ["官方引导", "沟通", "边界"], seoTitle: "互动开始前最重要的确认是什么", seoDescription: "围绕互动开始前的确认方式，邀请成年人分享可公开的沟通经验。" },
  { day: 1, hourUtc: 13, body: "新手提问箱：如果你第一次参与相关话题，最担心不知道怎样开口的是什么？不需要讲经历，只需留下一个问题。", topics: ["官方引导", "新手", "提问"], seoTitle: "新手如何开始表达问题", seoDescription: "同频社区的新手提问引导，鼓励以安全、可公开的方式提出困惑。" },
  { day: 2, hourUtc: 3, body: "一个小练习：把“我都可以”换成更具体的一句话。你会怎样表达自己的偏好、暂时不确定，或需要慢一点？", topics: ["官方引导", "表达", "边界"], seoTitle: "把模糊回应变成清晰表达", seoDescription: "通过具体表达偏好与不确定性，帮助成年人建立更清晰的沟通边界。" },
  { day: 3, hourUtc: 3, body: "复盘不是挑错。你觉得一次愉快的复盘应该包含哪些内容：感受、节奏、规则，还是下次的调整？", topics: ["官方引导", "复盘", "反馈"], seoTitle: "一次愉快复盘包含什么", seoDescription: "邀请社区讨论互动后的复盘、反馈与下一次调整。" },
  { day: 3, hourUtc: 13, body: "边界讨论：当你暂时不想继续一个话题时，什么样的回应会让你感到被尊重？", topics: ["官方引导", "尊重", "边界"], seoTitle: "如何尊重对方暂不继续的话题", seoDescription: "围绕暂停话题时的尊重回应，发起成年人沟通讨论。" },
  { day: 4, hourUtc: 3, body: "今天的主题是隐私。分享经验时，你认为最容易被忽略的一条隐私保护原则是什么？请不要包含任何可识别他人的信息。", topics: ["官方引导", "隐私", "社区规则"], seoTitle: "分享经验时的隐私保护原则", seoDescription: "同频社区讨论公开分享中的隐私保护与可识别信息风险。" },
  { day: 5, hourUtc: 3, body: "关系中的节奏需要协商。对你来说，“慢一点”通常意味着时间、信息量，还是需要更多确认？", topics: ["官方引导", "节奏", "协商"], seoTitle: "关系互动中的节奏如何协商", seoDescription: "围绕时间、信息量与确认方式，讨论怎样协商更舒适的节奏。" },
  { day: 5, hourUtc: 13, body: "如果你愿意给刚加入社区的人一句建议，你会说什么？请保持具体、友善，也不要替别人做决定。", topics: ["官方引导", "新手", "建议"], seoTitle: "给新加入社区成员的一句建议", seoDescription: "邀请成员分享友善、具体且尊重自主性的社区建议。" },
  { day: 6, hourUtc: 3, body: "沟通工具箱：你更喜欢文字确认、当面交流，还是约定一个简单信号？为什么这种方式对你更有效？", topics: ["官方引导", "沟通工具", "确认"], seoTitle: "哪种沟通确认方式更适合你", seoDescription: "讨论文字、当面交流和简单信号等不同确认方式的适用场景。" },
  { day: 7, hourUtc: 3, body: "一周小结：这周哪一条讨论最有帮助？也欢迎提出你希望下周看到的主题。", topics: ["官方引导", "一周小结", "主题征集"], seoTitle: "同频社区第一周主题小结", seoDescription: "官方 AI 协助汇集第一周讨论反馈，并征集下一周主题。" },
  { day: 7, hourUtc: 13, body: "当你听到与自己不同的偏好或经验时，怎样回应能让对话继续保持尊重？", topics: ["官方引导", "尊重", "倾听"], seoTitle: "面对不同经验时如何保持尊重", seoDescription: "围绕倾听与尊重差异，发起成年人社区交流。" },
  { day: 8, hourUtc: 3, body: "今天聊“确认”。你希望确认发生在开始前、过程中、结束后，还是这三个阶段都需要？", topics: ["官方引导", "确认", "沟通"], seoTitle: "确认应出现在哪些互动阶段", seoDescription: "讨论开始前、过程中与结束后的确认需求。" },
  { day: 9, hourUtc: 3, body: "如果一个安排让你感到犹豫，你更需要的是更多信息、更多时间，还是可以轻松说“不”的空间？", topics: ["官方引导", "自主", "边界"], seoTitle: "犹豫时需要什么支持", seoDescription: "围绕犹豫、更多信息和拒绝空间展开尊重自主性的讨论。" },
  { day: 9, hourUtc: 13, body: "经验分享不必很长。用一句不涉及隐私的话，描述一个让你感到被认真倾听的时刻。", topics: ["官方引导", "倾听", "经验分享"], seoTitle: "被认真倾听是什么感受", seoDescription: "邀请成员以不泄露隐私的方式分享被认真倾听的体验。" },
  { day: 10, hourUtc: 3, body: "讨论题：哪些社区规则会让你更愿意发言？例如清晰的举报入口、审核说明、还是反骚扰原则？", topics: ["官方引导", "社区规则", "反馈"], seoTitle: "哪些社区规则能提升发言意愿", seoDescription: "收集关于举报、审核和反骚扰规则的真实用户反馈。" },
  { day: 11, hourUtc: 3, body: "“照护”可以很简单：一句确认、一次复盘或一次尊重暂停。你认为最容易坚持的是哪一种？", topics: ["官方引导", "照护", "复盘"], seoTitle: "日常互动中的简单照护方式", seoDescription: "讨论确认、复盘与尊重暂停等可持续的照护方式。" },
  { day: 11, hourUtc: 13, body: "匿名提问征集：你希望官方文章或社区导读解释哪个沟通概念？只写主题，不要写他人的个人信息。", topics: ["官方引导", "主题征集", "文章"], seoTitle: "征集下一篇社区导读主题", seoDescription: "同频征集用户希望了解的沟通与边界主题。" },
  { day: 12, hourUtc: 3, body: "如果一段对话让你感觉不舒服，什么样的退出方式最清晰也最尊重彼此？", topics: ["官方引导", "退出", "尊重"], seoTitle: "如何清晰且尊重地退出对话", seoDescription: "讨论不舒服时怎样安全、清晰地结束对话。" },
  { day: 13, hourUtc: 3, body: "14 天实验即将结束。你希望同频继续保留哪些主题、减少哪些内容？你的真实反馈会决定下一阶段是否开放授权创作者投稿。", topics: ["官方引导", "实验总结", "反馈"], seoTitle: "同频社区互动实验总结与反馈", seoDescription: "邀请用户为同频下一阶段的授权创作者投稿计划提供真实反馈。" },
];

function plannedAt(prompt: Prompt): Date {
  if (prompt.day === 0) return CAMPAIGN_START_AT;
  const startDate = new Date(CAMPAIGN_START_AT);
  return new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate() + prompt.day, prompt.hourUtc ?? 3, 0, 0));
}

const prisma = new PrismaClient();

async function run() {
  const now = new Date();
  const dryRun = process.argv.includes(DRY_RUN_FLAG);
  if (!dryRun && !process.argv.includes(CONFIRM_FLAG)) {
    throw new Error(`Refusing to write campaign data without ${CONFIRM_FLAG}; use ${DRY_RUN_FLAG} to inspect.`);
  }
  const author = await prisma.user.upsert({
    where: { telegramUserId: OFFICIAL_TELEGRAM_USER_ID },
    update: { displayName: "Samewave 官方 · AI 协助", status: "active" },
    create: { telegramUserId: OFFICIAL_TELEGRAM_USER_ID, displayName: "Samewave 官方 · AI 协助", status: "active" },
  });
  const auditAdmin = await prisma.adminUser.findFirst({ where: { status: "active" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!auditAdmin) throw new Error("No active admin is available for campaign audit logging");

  const missing = [] as Array<{ prompt: Prompt; scheduledAt: Date }>;
  for (const prompt of PROMPTS) {
    const existing = await prisma.communityPost.findFirst({ where: { authorId: author.id, body: prompt.body }, select: { id: true } });
    if (!existing) missing.push({ prompt, scheduledAt: plannedAt(prompt) });
  }
  const due = PROMPTS.filter((prompt) => plannedAt(prompt).getTime() <= now.getTime()).length;
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, campaignId: CAMPAIGN_ID, now: now.toISOString(), totalPrompts: PROMPTS.length, existing: PROMPTS.length - missing.length, missing: missing.length, due }));
    return;
  }

  let created = 0;
  let published = 0;
  for (const { prompt, scheduledAt } of missing) {
    const shouldPublish = scheduledAt.getTime() <= now.getTime();
    const post = await prisma.communityPost.create({
      data: {
        authorId: author.id,
        body: prompt.body,
        topics: prompt.topics,
        seoTitle: prompt.seoTitle,
        seoDescription: prompt.seoDescription,
        seoKeywords: prompt.topics,
        geoKeywords: ["成年人沟通", "尊重", "边界"],
        searchIndexable: true,
        isOfficial: true,
        aiAssisted: true,
        status: shouldPublish ? "published" : "pending",
        publishedAt: scheduledAt,
        moderationReason: `${CAMPAIGN_ID}; scheduled=${scheduledAt.toISOString()}`,
      },
    });
    await prisma.adminAuditLog.create({
      data: {
        adminId: auditAdmin.id,
        action: "community.post.seed_official_ai_experiment",
        objectType: "community_post",
        objectId: post.id,
        afterValue: { campaignId: CAMPAIGN_ID, isOfficial: true, aiAssisted: true, scheduledAt: scheduledAt.toISOString(), status: shouldPublish ? "published" : "pending" },
        reason: "14 天官方 AI 协助互动实验；未创建用户、点赞、评论、阅读或举报等任何虚假互动。",
      },
    });
    created += 1;
    if (shouldPublish) published += 1;
  }

  const released = await prisma.communityPost.updateMany({
    where: {
      authorId: author.id,
      status: "pending",
      moderationReason: { startsWith: CAMPAIGN_ID },
      publishedAt: { lte: now },
    },
    data: { status: "published" },
  });
  published += released.count;
  const campaignComplete = await prisma.communityPost.count({
    where: { authorId: author.id, moderationReason: { startsWith: CAMPAIGN_ID }, status: "published" },
  });
  console.log(JSON.stringify({ ok: true, campaignId: CAMPAIGN_ID, created, published, releasedFromQueue: released.count, campaignComplete: campaignComplete === PROMPTS.length }));
}

run().finally(() => prisma.$disconnect());
