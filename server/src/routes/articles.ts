import type { FastifyInstance } from "fastify";

type Article = {
  slug: string;
  title: string;
  summary: string;
  publishedAt: string;
  sourceUrl: string;
  sourceName: string;
  readingMinutes: number;
  topics: string[];
  seo: { title: string; description: string; keywords: string[]; geoKeywords: string[]; robots: string };
  sections: Array<{ heading: string; body: string }>;
};

const GEO = ["BDSM", "成人亲密关系", "安全沟通", "明确同意", "边界", "事后照护"];
const SOURCE = "https://www.lovense.com/sex-blog/";
const raw: Array<[string, string, string, string, string[]]> = [
  ["bdsm-safe-signals-hand-gestures", "非语言 BDSM 安全信号：无法说话时怎样清晰表达", "当说话不方便时，事先约定的手势和物件信号能帮助双方及时暂停、放慢或确认状态。", "2026-03-23T17:55:05+00:00", ["安全词", "沟通", "边界"]],
  ["kink-bdsm/bdsm-punishments", "BDSM 惩罚与规则：把协商放在玩法之前", "规则、后果与修复应由参与者共同协商；任何安排都不能替代持续同意与身体安全。", "2026-04-10T00:00:00+00:00", ["规则", "协商", "事后照护"]],
  ["femdom-ideas", "女王主导玩法：从沟通和节奏开始", "主导不等于忽略反馈。好的主导体验依赖清晰沟通、可随时退出的约定与循序渐进的节奏。", "2026-04-06T00:00:00+00:00", ["主导", "新手", "沟通"]],
  ["kink-bdsm/hentai-terms", "成人漫画术语入门：看懂标签，也看懂边界", "标签能帮助读者筛选内容，但不能替代年龄限制、内容提示和个人边界判断。", "2026-04-04T00:00:00+00:00", ["成人内容", "标签", "内容提示"]],
  ["best-kink-sex-toys", "BDSM 情趣用品指南：从材质、清洁与安全选购", "选择用品时，优先考虑材质、清洁方式、强度可控性和使用说明，而不是单纯追求刺激。", "2026-04-02T00:00:00+00:00", ["用品", "清洁", "安全"]],
  ["diy-bdsm-flogger-guide", "DIY BDSM 皮鞭：制作前先理解材料与风险", "自制用品需要额外关注材料安全、边缘处理和可控性；缺乏把握时应选择合规成品。", "2026-03-30T00:00:00+00:00", ["DIY", "用品", "风险评估"]],
  ["kink-bdsm/what-are-extreme-sex-practices-guide", "高强度亲密玩法：沟通、风险与停止机制", "强度越高，越需要事前协商、风险评估、随时停止的机制和充分的事后照护。", "2026-03-27T00:00:00+00:00", ["风险评估", "安全词", "照护"]],
  ["kink-bdsm/bdsm-checklist-tips", "BDSM 清单指南：用“可以、不要、再考虑”开启对话", "清单的意义不是给偏好打分，而是让双方用可理解的方式讨论想尝试、明确拒绝和需要更多信息的内容。", "2026-03-25T00:00:00+00:00", ["清单", "同意", "沟通"]],
  ["kink-bdsm/nipple-bondage-torture-guide", "敏感部位用品：了解限制、风险与停止条件", "涉及敏感部位的用品应格外谨慎，必须控制时长和强度，并提前约定异常感受的停止条件。", "2026-03-22T00:00:00+00:00", ["敏感部位", "用品", "安全"]],
  ["kink-bdsm/lgbtq-pleasure-dom-guide", "多元身份下的主导体验：尊重称呼、身份与边界", "角色和偏好不应被刻板印象定义。尊重对方的称呼、身份表达和协商结果，是亲密关系的基础。", "2026-03-20T00:00:00+00:00", ["多元", "尊重", "主导"]],
  ["kink-bdsm/vibrating-nipple-clamps-tips-guide", "敏感部位器具使用提示：可控、可停、可沟通", "器具使用需要关注强度、时长和身体反应；任何不适都应优先处理。", "2026-03-18T00:00:00+00:00", ["器具", "强度控制", "沟通"]],
  ["kink-bdsm/bdsm-afterare-kit-ideas", "BDSM 事后照护工具包：恢复、连接与复盘", "照护不是流程的附属项。休息、补水、情绪确认和复盘能帮助参与者平稳回到日常。", "2026-03-15T00:00:00+00:00", ["事后照护", "复盘", "关系"]],
  ["kink-bdsm/best-free-vr-porn-games-vs-paid", "VR 成人内容选择：设备安全、内容提示与付费判断", "选择 VR 成人内容前应先确认年龄限制、设备舒适度、隐私设置和内容提示，再比较服务规则。", "2026-03-12T00:00:00+00:00", ["VR", "隐私", "内容提示"]],
  ["kink-bdsm/sissification-shopping-guide-tips", "风格与角色扮演选购：以自我表达和安全为先", "服装和角色扮演应建立在自愿、隐私和尊重之上；购买时注意尺码、材质与个人信息保护。", "2026-03-10T00:00:00+00:00", ["角色扮演", "隐私", "自我表达"]],
  ["kink-bdsm/extreme-sex-communication-guide", "高强度玩法沟通指南：把确认变成持续动作", "从事前协商到过程确认和事后复盘，持续沟通比一次性同意更能保护双方体验。", "2026-03-08T00:00:00+00:00", ["持续同意", "沟通", "风险"]],
  ["kink-bdsm/forced-orgasm-bdsm-guide-safety-tips", "高潮控制玩法：尊重身体信号与退出权", "涉及高潮控制的玩法应以自愿、舒适与可随时停止为基础，不应把忍耐或不适当作目标。", "2026-03-06T00:00:00+00:00", ["高潮控制", "同意", "身体反馈"]],
  ["kink-bdsm/extreme-edging", "边缘控制玩法：节奏、沟通与舒适感", "边缘控制需要清晰的节奏与反馈，不适合用竞争或强迫的方式推进。", "2026-03-04T00:00:00+00:00", ["边缘控制", "节奏", "沟通"]],
  ["kink-bdsm/are-kinks-hereditary", "偏好会遗传吗：从好奇到尊重个体差异", "亲密偏好受到多种因素影响，不能用单一原因解释，更不应据此评判或给他人贴标签。", "2026-03-01T00:00:00+00:00", ["偏好", "尊重", "心理健康"]],
  ["kink-bdsm/bdsm-humiliation", "羞辱与贬低角色扮演：先确认边界与禁区", "语言和角色扮演具有很强的个人差异。先明确哪些词、主题和情境绝不触碰，才能降低伤害风险。", "2026-04-08T00:00:00+00:00", ["角色扮演", "协商", "情绪安全"]],
];

export const STATIC_ARTICLES: Article[] = raw.map(function ([path, title, summary, publishedAt, topics]) {
  const slug = path.replace(/^kink-bdsm\//, "");
  return {
    slug,
    title,
    summary,
    publishedAt,
    sourceUrl: SOURCE + path,
    sourceName: "Lovense Sex Blog",
    readingMinutes: 4,
    topics,
    seo: { title: title + "｜同频文章", description: summary, keywords: topics.concat(["BDSM", "安全", "沟通", "同意"]), geoKeywords: GEO, robots: "index,follow,max-snippet:-1" },
    sections: [
      { heading: "核心提醒", body: summary },
      { heading: "同频建议", body: "把明确同意、随时暂停、尊重个人边界与事后沟通放在任何体验之前。具体做法应以参与者的实际状态和共同协商为准。" },
    ],
  };
});

function toSections(bodyMarkdown: string): Array<{ heading: string; body: string }> {
  const paragraphs = String(bodyMarkdown || "").split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean);
  return paragraphs.map((body, index) => ({ heading: index === 0 ? "正文" : "继续阅读", body }));
}

function dbArticleToPublic(row: any): Article {
  const publishedAt = row.publishedAt ? new Date(row.publishedAt).toISOString() : new Date(row.updatedAt || Date.now()).toISOString();
  const topics = Array.isArray(row.topics) ? row.topics : [];
  const summary = row.summary || "";
  return {
    slug: row.slug,
    title: row.title,
    summary,
    publishedAt,
    sourceUrl: row.sourceUrl || "",
    sourceName: row.sourceName || "同频文章",
    readingMinutes: Math.max(1, Math.ceil(String(row.bodyMarkdown || "").length / 420)),
    topics,
    seo: {
      title: row.seoTitle || `${row.title}｜同频文章`,
      description: row.seoDescription || summary,
      keywords: Array.isArray(row.seoKeywords) && row.seoKeywords.length ? row.seoKeywords : topics,
      geoKeywords: Array.isArray(row.geoKeywords) && row.geoKeywords.length ? row.geoKeywords : GEO,
      robots: "index,follow,max-snippet:-1",
    },
    sections: toSections(row.bodyMarkdown),
  };
}

async function publishedDbArticles(fastify: FastifyInstance): Promise<Article[] | null> {
  try {
    const rows = await (fastify as any).prisma.article.findMany({
      where: { status: "published" },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
    });
    return rows.map(dbArticleToPublic);
  } catch (error) {
    // The static guide remains available during a rolling migration or on a read-only preview database.
    fastify.log.warn({ err: error }, "published article query unavailable; using static article guide only");
    return null;
  }
}

async function visibleArticles(fastify: FastifyInstance): Promise<Article[]> {
  const managed = await publishedDbArticles(fastify);
  // 发布后的 Article CMS 是前台唯一正式来源：后台的上架、编辑、下线必须立刻
  // 一一反映到用户端。静态导读仅用于迁移失败或数据库暂不可读时的应急降级，
  // 不能再与 CMS 数据按 slug 混合，否则会出现后台和前台文章对不上的情况。
  return managed ?? STATIC_ARTICLES;
}

export default async function articleRoutes(fastify: FastifyInstance) {
  fastify.get("/articles", async () => {
    const items = await visibleArticles(fastify);
    return {
      items: items.map(function ({ sections: _sections, ...item }) { return item; }),
      total: items.length,
    };
  });

  fastify.get<{ Params: { slug: string } }>("/articles/:slug", async (request, reply) => {
    const item = (await visibleArticles(fastify)).find((article) => article.slug === request.params.slug);
    if (!item) return reply.code(404).send({ error: "article_not_found", message: "文章不存在或已下线。" });
    return item;
  });
}
