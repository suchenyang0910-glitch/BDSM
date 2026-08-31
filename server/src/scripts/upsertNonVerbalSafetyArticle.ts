/**
 * Idempotently places the first rich-HTML safety guide into the editable CMS.
 * Run after migration 0038; subsequent edits belong in /admin/articles.
 */
import { PrismaClient } from "@prisma/client";
import { htmlToPlainText, sanitizeArticleHtml } from "../lib/articleHtml.js";

const slug = "bdsm-safe-signals-hand-gestures";
const prisma = new PrismaClient();
const publicOrigin = (process.env.PUBLIC_WEB_ORIGIN || "https://samewave.cc").replace(/\/+$/, "");
const coverImageUrl = `${publicOrigin}/article-assets/non-verbal-safe-signals-cover.png`;
const diagramImageUrl = `${publicOrigin}/article-assets/non-verbal-safe-signals-system.png`;

const bodyHtml = sanitizeArticleHtml(`
  <p>在亲密互动中，语言并不是唯一的沟通方式。当说话不方便、环境嘈杂，或任何一方不想继续表达时，事先约定的非语言安全信号能让“暂停、放慢、结束”仍然清楚可见。</p>
  <blockquote>安全信号不是考验忍耐的规则，而是让每个人都能随时被听见的退出机制。</blockquote>
  <h2>先把信号约定得简单、可见、可重复</h2>
  <p>优先选择双方都能辨认、不会与普通动作混淆的方式。不要把复杂手势当作记忆测试；真正有效的系统应当在紧张或疲劳时也能执行。</p>
  <ul>
    <li><strong>继续：</strong>用明确的点头、拇指向上，或双方约定的轻触回应，表示当前状态可以继续。</li>
    <li><strong>放慢／确认：</strong>用连续轻拍、举起手掌或指向约定物件，表示需要降低强度、调整姿势或再次确认。</li>
    <li><strong>立即停止：</strong>使用更清晰的双击、掉落软物件或手掌朝外等动作。看到停止信号的一方，应当马上停止并先确认安全。</li>
  </ul>
  <figure><img src="${diagramImageUrl}" alt="继续、放慢与停止的非语言安全信号示意图"><figcaption>将信号分成“继续、确认、停止”三个等级，比只记一个动作更容易在现场使用。</figcaption></figure>
  <h2>把“物件信号”准备成备用通道</h2>
  <p>握住或松开一个轻软物件、轻敲床沿或桌面，都可以作为备用信号。选择不会造成伤害、不会滚远、容易拿到的物件；每次开始前确认它仍在触手可及的位置。</p>
  <h2>开始前的三分钟检查</h2>
  <ol>
    <li>双方各自演示一次“继续、放慢、停止”。</li>
    <li>确认停止后要做什么：松开、退开、补水、安静陪伴，还是先问一句“你现在需要什么？”</li>
    <li>约定任何人都可以在任何时刻改变想法，无需解释或证明理由。</li>
  </ol>
  <h2>信号出现后，先照顾状态再讨论原因</h2>
  <p>停止或放慢信号出现后，不追问、不辩论，也不把对方的反应解释成“扫兴”。先停下、确认呼吸与身体舒适度，再决定是否结束、休息或改做其他事情。事后用平静的语气复盘：什么信号最有效、哪里容易误解、下次怎样更舒服。</p>
  <hr>
  <p>这是一篇面向成年人的安全沟通导读，不替代医疗、心理或紧急援助建议。若出现持续疼痛、呼吸困难、麻木、意识异常或无法自行缓解的不适，应立即停止并寻求专业帮助。</p>
`);

async function main() {
  const existing = await prisma.article.findUnique({ where: { slug } });
  const data = {
    title: "非语言 BDSM 安全信号：无法说话时怎样清晰表达",
    summary: "当说话不方便时，事先约定的手势和物件信号能帮助双方及时暂停、放慢或确认状态。",
    bodyHtml,
    bodyMarkdown: htmlToPlainText(bodyHtml),
    coverImageUrl,
    sourceName: "Lovense Sex Blog",
    sourceUrl: "https://www.lovense.com/sex-blog/bdsm-safe-signals-hand-gestures",
    topics: ["安全词", "非语言信号", "沟通", "边界", "事后照护"],
    seoTitle: "非语言 BDSM 安全信号：无法说话时怎样清晰表达｜同频文章",
    seoDescription: "面向成年人的 BDSM 安全沟通导读：如何在不便说话时，用简单、可见、可重复的非语言信号表达继续、放慢与停止。",
    seoKeywords: ["BDSM 安全", "非语言安全信号", "安全词", "明确同意", "边界", "沟通"],
    geoKeywords: ["BDSM", "成人亲密关系", "安全沟通", "明确同意", "边界", "事后照护"],
    status: "published" as const,
    publishedAt: existing?.publishedAt || new Date(),
    updatedBy: "system-article-import",
  };
  const article = await prisma.article.upsert({
    where: { slug },
    create: { slug, ...data, createdBy: "system-article-import" },
    update: data,
  });
  console.log(JSON.stringify({ ok: true, articleId: article.id, slug: article.slug }));
}

main().catch((error) => {
  console.error("article_upsert_failed", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
