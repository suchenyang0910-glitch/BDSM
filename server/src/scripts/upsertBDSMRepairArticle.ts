/**
 * Creates an original, non-promotional adult-consent education article.
 * It deliberately does not translate or reproduce third-party article text.
 */
import { PrismaClient } from "@prisma/client";
import { htmlToPlainText, sanitizeArticleHtml } from "../lib/articleHtml.js";

const slug = "bdsm-boundaries-repair-and-aftercare";
const prisma = new PrismaClient();
const publicOrigin = (process.env.PUBLIC_WEB_ORIGIN || "https://samewave.cc").replace(/\/+$/, "");
// Version the URLs so an earlier SPA fallback response cannot be reused by an edge cache.
const coverImageUrl = `${publicOrigin}/article-assets/bdsm-boundaries-repair-cover.png?v=20260831`;
const flowImageUrl = `${publicOrigin}/article-assets/bdsm-boundaries-repair-flow.png?v=20260831`;

const bodyHtml = sanitizeArticleHtml(`
  <p>在成年人自愿参与的亲密场景中，任何“纠偏”都不应以伤害、羞辱或迫使对方服从为目的。更稳妥的做法，是把它理解为一次共同回到边界、节奏与照护的机会：先暂停，再确认，最后决定是否继续。</p>
  <blockquote>同意是持续进行的过程；任何一方改变想法，都可以立即停止，不需要解释或证明理由。</blockquote>
  <h2>先区分：协商，不是惩罚</h2>
  <p>健康的互动不靠猜测，也不靠一方忍耐来证明关系。开始前应明确哪些行为可接受、哪些绝不进行、哪些必须先询问。若出现不适、误会或边界被碰触，目标不是“让谁付出代价”，而是让双方重新获得安全感和选择权。</p>
  <ul>
    <li><strong>可以约定的：</strong>暂停、降低强度、改为聊天或拥抱、重新确认边界、事后复盘。</li>
    <li><strong>不应合理化的：</strong>胁迫、贬损、隔离、剥夺睡眠或饮食、经济控制，以及任何让人无法自由离开的做法。</li>
    <li><strong>永远优先：</strong>身体不适、情绪失控、呼吸或意识异常时立即停止，并在需要时寻求专业帮助。</li>
  </ul>
  <h2>规则被碰触后，怎样回应才合适？</h2>
  <p>先判断这是不是误会、沟通遗漏，还是某一方已经不舒服。没有事先协商、没有清楚理解、或者在压力下作出的“同意”，都不能被当成可以追责的规则。即使规则已经约定，回应也应当与事件的影响相称，目标是修复信任，而不是制造恐惧。</p>
  <ul>
    <li><strong>轻微偏差：</strong>停下来说明发生了什么，重申约定，必要时把规则写得更具体。</li>
    <li><strong>需要调整：</strong>结束当次场景，改在双方平静后复盘；下一次从更低强度、更短时长重新开始。</li>
    <li><strong>出现红线：</strong>立即结束，优先照护与安全支持。任何人都可以离开，不应因此被责难或挽留。</li>
  </ul>
  <blockquote>不能自由拒绝的“规则”不是共同约定；让人害怕失去关系、资源或基本照护的“后果”也不是安全实践。</blockquote>
  <h2>不应被包装成纠偏的做法</h2>
  <p>避免把限制饮食、睡眠、医疗需求、工作学习、对外联络或经济资源当作关系中的后果。也不要把公开羞辱、孤立、临时取消照护、未经同意的疼痛或任何身体风险包装成“教育”。这些做法会放大权力不对等，损害信任，并可能带来真实伤害。</p>
  <h2>一套可执行的三步响应</h2>
  <p>提前把流程约定得越简单，真正需要时越容易被执行。双方可以把它记成“暂停—确认—选择”。</p>
  <ol>
    <li><strong>暂停：</strong>任何停止或放慢信号出现后，立即停下动作，给彼此安静和空间。</li>
    <li><strong>确认：</strong>用简短、没有压力的问题了解状态，例如“你还好吗？”“需要喝水、休息，还是想结束？”</li>
    <li><strong>选择：</strong>只有在双方都清楚、舒适且明确愿意的情况下才继续；否则结束当次场景，并把照护放在第一位。</li>
  </ol>
  <figure><img src="${flowImageUrl}" alt="暂停、确认与共同选择的照护流程插图"><figcaption>把回应流程写成简单步骤，能减少紧张时的误解与猜测。</figcaption></figure>
  <h2>如何把复盘变成关系修复</h2>
  <p>复盘不该变成追责会议。选择双方都平静的时候，用具体体验而非评价对方人格的方式表达：什么地方舒服、什么地方让人迟疑、下次希望怎样提醒、哪些信号应该更明确。把结论记录成下一次的边界清单，会比临场依赖记忆更可靠。</p>
  <h2>开始前的一分钟检查</h2>
  <ul>
    <li>确认双方都是自愿、清醒、可随时退出的成年人。</li>
    <li>确认停止信号、放慢信号和备用沟通方式。</li>
    <li>确认谁负责观察状态，以及暂停后怎样照护。</li>
    <li>确认没有任何人因关系、金钱、身份或情绪压力而被迫同意。</li>
  </ul>
  <hr>
  <p>本文为成年人亲密关系中的安全沟通导读，不构成医疗、心理或法律建议。若出现持续疼痛、麻木、呼吸困难、意识异常，或感到被胁迫、害怕而无法拒绝，请立即停止并寻求可信赖的专业支持。</p>
`);

async function main() {
  const existing = await prisma.article.findUnique({ where: { slug } });
  const data = {
    title: "BDSM 场景中的纠偏与照护：把边界落实为可执行的约定",
    summary: "面向成年人的安全沟通导读：用暂停、确认与共同选择，处理边界被碰触或需要调整的时刻。",
    bodyHtml,
    bodyMarkdown: htmlToPlainText(bodyHtml),
    coverImageUrl,
    sourceName: null,
    sourceUrl: null,
    topics: ["明确同意", "边界", "安全沟通", "照护", "关系修复"],
    seoTitle: "BDSM 场景中的纠偏与照护：边界、暂停与复盘｜同频文章",
    seoDescription: "面向成年人的安全沟通导读：当场景需要调整时，如何用暂停、确认、共同选择和事后复盘维护明确同意与边界。",
    seoKeywords: ["BDSM 安全", "明确同意", "边界沟通", "暂停信号", "事后照护", "关系修复"],
    geoKeywords: ["成年人亲密关系", "安全沟通", "明确同意", "边界", "照护"],
    status: "published" as const,
    publishedAt: existing?.publishedAt || new Date(),
    updatedBy: "system-original-article-import",
  };
  const article = await prisma.article.upsert({
    where: { slug },
    create: { slug, ...data, createdBy: "system-original-article-import" },
    update: data,
  });
  console.log(JSON.stringify({ ok: true, articleId: article.id, slug: article.slug }));
}

main().catch((error) => {
  console.error("article_upsert_failed", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
