import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("h5/app.js keeps pending orders resumable from detail CTA and paywall", async () => {
  const source = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  assert.match(source, /function continuePendingOrder\(order, detail\)/);
  assert.match(source, /if \(pendingOrder\) \{\s*return \{ text: "继续支付"/);
  assert.match(source, /if \(pendingOrder\) \{\s*continuePendingOrder\(pendingOrder, detail\);\s*return;\s*\}/);
  assert.match(source, /previewUpgradeButton.*continuePendingOrder\(pendingOrder, detail\)/s);
});

test("h5/app.js auto-starts preview and enforces 50s hint plus 60s paywall", async () => {
  const source = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  assert.match(source, /const shouldAutoPreview = !detail\.unlocked/);
  assert.match(source, /trackAnalytics\("preview_upgrade_shown"/);
  assert.match(source, /current >= previewDuration - 10/);
  assert.match(source, /current >= previewDuration\) \{[\s\S]{0,240}showPreviewUpgradeGate\(detail, \{ trigger: "preview_limit"/);
});

test("h5/app.js distinguishes preview analytics from full playback analytics", async () => {
  const source = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  assert.match(source, /function getPlaybackAnalyticsEventName\(prefix\)/);
  assert.match(source, /trackAnalytics\(getPlaybackAnalyticsEventName\("started"\)/);
  assert.match(source, /trackAnalytics\("preview_completed"/);
  assert.match(source, /trackAnalytics\("playback_completed"/);
});

test("h5 back navigation synchronously stops and detaches the active video", async () => {
  const source = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  assert.match(source, /function detachActivePlayer\(reason\) \{[\s\S]{0,1000}activeVideo\.pause\(\)[\s\S]{0,700}clearManagedPlaybackState\(\)[\s\S]{0,700}activeVideo\.removeAttribute\("src"\); activeVideo\.load\(\);/);
  assert.match(source, /const leavingDetail = state\.route && state\.route\.view === "detail" && routeState\.view !== "detail";\s*if \(leavingDetail\) detachActivePlayer\("leave"\);/);
});

test("active membership uses web playback rather than mandatory channel delivery", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  const paySource = await readFile(path.join(ROOT, "telegram-mini-app/h5-pay.js"), "utf8");
  assert.match(appSource, /if \(detail\.unlocked\) \{[\s\S]{0,900}观看完整视频[\s\S]{0,900}startManagedPlayback\(detail\)/);
  assert.doesNotMatch(appSource, /detail\.unlocked && detail\.accessType !== "single"[\s\S]{0,300}前往频道观看/);
  assert.match(appSource, /开通会员后可在网页、H5 与 Mini App 观看完整内容/);
  assert.match(paySource, /会员权益已生效[\s\S]{0,160}网页、H5 与 Mini App/);
  assert.doesNotMatch(paySource, /绑定 Telegram 后领取频道/);
});

test("full playback UI hides implementation-specific delivery wording", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  assert.match(appSource, /const mediaLabel = playback && playback\.action === "play_full"\s*\? ""/);
  assert.match(appSource, /\? "你的会员权益已生效，可观看完整视频。"/);
  assert.doesNotMatch(appSource, /完整播放走服务端会话与短时鉴权/);
  assert.doesNotMatch(appSource, /已解锁，可直接受控播放/);
});

test("full playback refresh waits for the managed manifest instead of surfacing a preview abort", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  assert.match(appSource, /const initialMediaUrl = playback && playback\.action === "play_full" \? "" : detail\.previewUrl/);
  assert.match(appSource, /const waitForManifest = loadManagedVideoSource\(video, created\.manifestUrl, detail\)/);
  assert.match(appSource, /if \(!waitForManifest\) startVideoElementPlayback\(video, detail\)/);
  assert.match(appSource, /MANIFEST_PARSED[\s\S]{0,900}startVideoElementPlayback\(video, detail\)/);
  assert.doesNotMatch(appSource, /试看初始化被中断/);
});

test("h5 catalog UI uses whole-card navigation and server-backed library search", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  const htmlSource = await readFile(path.join(ROOT, "h5/index.html"), "utf8");
  assert.match(appSource, /card\.addEventListener\("click", openDetail\)/);
  assert.match(appSource, /params\.set\("keyword", String\(state\.library\.search \|\| ""\)\.trim\(\)\)/);
  assert.match(appSource, /loadLibrary\(\{ append: true \}\)/);
  assert.doesNotMatch(htmlSource, /card-action/);
  assert.match(htmlSource, /libraryLoadMoreButton/);
});

test("h5 library exposes every configured category and keeps mobile infinite scroll", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  const htmlSource = await readFile(path.join(ROOT, "h5/index.html"), "utf8");
  const cssSource = await readFile(path.join(ROOT, "h5/styles.css"), "utf8");
  assert.match(appSource, /categories\.forEach\(function \(category\) \{\s*renderCategoryChip\(category, host, false\)/);
  assert.doesNotMatch(appSource, /const primaryCategories = categories\.slice\(0, 6\)/);
  assert.doesNotMatch(appSource, /const extraCategories = categories\.slice\(6\)/);
  assert.match(appSource, /libraryCategoryMoreButton/);
  assert.match(appSource, /function shouldUseLibraryInfiniteScroll\(\)/);
  assert.match(appSource, /window\.addEventListener\("scroll", maybeLoadLibraryOnScroll/);
  assert.match(htmlSource, /libraryCategoryExtras/);
  assert.match(htmlSource, /libraryInfiniteSentinel/);
  assert.match(cssSource, /#libraryCategoryList \{\s*flex-wrap: nowrap;\s*overflow-x: auto;/);
});

test("h5 home keeps continue watching compact and safely renders channel labels", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  const htmlSource = await readFile(path.join(ROOT, "h5/index.html"), "utf8");
  const cssSource = await readFile(path.join(ROOT, "h5/styles.css"), "utf8");
  assert.match(appSource, /function escapeHtml\(value\)/);
  assert.match(appSource, /resume-card resume-card-compact/);
  assert.match(appSource, /resume-inline-actions/);
  assert.match(htmlSource, /id="homeRecentSection"[\s\S]{0,420}id="homeBannerList"/);
  assert.match(cssSource, /\.resume-card-compact \{/);
  assert.match(cssSource, /\.app-shell \{[\s\S]{0,600}calc\(152px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(cssSource, /\.bottom-nav \{[\s\S]{0,700}background: var\(--bg-surface\);[\s\S]{0,300}z-index: 1000;/);
});

test("h5 home separates a closable popup placement, popular types, and billing from custodial balance", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  const htmlSource = await readFile(path.join(ROOT, "h5/index.html"), "utf8");
  const cssSource = await readFile(path.join(ROOT, "h5/styles.css"), "utf8");
  const homeRouteSource = await readFile(path.join(ROOT, "server/src/routes/home.ts"), "utf8");

  assert.match(homeRouteSource, /slot: banner\.slot \|\| "home_primary"/);
  assert.match(appSource, /banner\.slot !== "home_popup"/);
  assert.match(appSource, /function renderHomePopup\(\)/);
  assert.match(appSource, /params\.set\("categoryId", categoryId\)/);
  assert.match(appSource, /refreshLibraryForCategory/);
  assert.match(appSource, /HOME_PROMO_DISMISS_PREFIX/);
  assert.match(appSource, /function setHashForWallet\(\)/);
  assert.match(appSource, /function renderWallet\(\)/);
  assert.match(htmlSource, /id="homePromoModal"/);
  assert.match(htmlSource, /热门类型/);
  assert.match(htmlSource, /id="walletView"/);
  assert.match(htmlSource, /平台不保存余额/);
  assert.match(cssSource, /\.popular-type-grid \{/);
  assert.match(cssSource, /\.home-promo-modal \{/);
});

test("account avatar prefers Telegram profile photos and uses a generic device-session fallback", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  const htmlSource = await readFile(path.join(ROOT, "h5/index.html"), "utf8");
  const cssSource = await readFile(path.join(ROOT, "h5/styles.css"), "utf8");
  const authSource = await readFile(path.join(ROOT, "server/src/routes/authH5.ts"), "utf8");

  assert.match(authSource, /select: \{ id: true, telegramUserId: true, displayName: true, photoUrl: true, status: true \}/);
  assert.match(authSource, /photoUrl: bound \? \(user\.photoUrl \|\| null\) : null/);
  assert.match(appSource, /const DEFAULT_ACCOUNT_AVATAR/);
  assert.match(appSource, /function accountAvatarUrl\(session\)/);
  assert.match(appSource, /session\.identity === "telegram"/);
  assert.match(appSource, /const profileName = session && session\.displayName \? session\.displayName : "同频成员"/);
  assert.match(appSource, /profileAvatar\.src = accountAvatarUrl\(session\)/);
  assert.match(appSource, /payload\.user && payload\.user\.photoUrl/);
  assert.match(htmlSource, /id="profileAvatar"/);
  assert.match(cssSource, /\.account-avatar \{/);
});

test("checkout flow preserves return target and payment success returns to content detail", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  const paySource = await readFile(path.join(ROOT, "telegram-mini-app/h5-pay.js"), "utf8");
  const serverSource = await readFile(path.join(ROOT, "server/src/index.ts"), "utf8");
  assert.match(appSource, /function getCheckoutReturnTarget\(detail\)/);
  assert.match(appSource, /openCheckoutPage\(\{ productId: product\.id, paymentMethod: "usdt", returnTo: getCheckoutReturnTarget\(detail\) \}\)/);
  assert.match(paySource, /function currentReturnToFromQs\(\)/);
  assert.match(paySource, /replaceCheckoutQuery\(\{\s*orderNo: order\.orderNo,[\s\S]{0,160}returnTo: currentReturnToFromQs\(\)/);
  assert.match(paySource, /function resolvePostPaymentTarget\(\)/);
  assert.match(paySource, /window\.location\.assign\(resolvePostPaymentTarget\(\)\)/);
  assert.match(serverSource, /function buildAliasRedirect\(targetPath: string, req: any\)/);
  assert.match(serverSource, /app\.get\("\/login\.html", async \(req, reply\) => reply\.redirect\(buildAliasRedirect\("\/mini-app\/login\.html", req\)\)\)/);
  assert.match(serverSource, /app\.get\("\/h5-pay\.html", async \(req, reply\) => reply\.redirect\(buildAliasRedirect\("\/mini-app\/h5-pay\.html", req\)\)\)/);
});

test("detail purchase layer supports optional single unlock product", async () => {
  const appSource = await readFile(path.join(ROOT, "h5/app.js"), "utf8");
  const serverSource = await readFile(path.join(ROOT, "server/src/routes/contents.ts"), "utf8");
  assert.match(serverSource, /unlockProduct:/);
  assert.match(appSource, /function getDetailUnlockProduct\(detail\)/);
  assert.match(appSource, /previewSecondaryUnlockButton/);
  assert.match(appSource, /detailSecondaryUnlockButton/);
  assert.match(appSource, /startPurchase\(detail, \{ product: unlockProduct \}\)/);
});
