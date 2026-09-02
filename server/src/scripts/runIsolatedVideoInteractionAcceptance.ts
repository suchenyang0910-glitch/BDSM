import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";

import authH5Routes from "../routes/authH5.js";
import contentRoutes from "../routes/contents.js";
import homeRoutes from "../routes/home.js";
import interactionRoutes from "../routes/interactions.js";
import adminInteractionRoutes from "../routes/adminInteractions.js";
import orderRoutes from "../routes/orders.js";
import resourcesRoutes from "../routes/resources.js";
import watchProgressRoutes from "../routes/watchProgress.js";

type CookieJar = Map<string, string>;
let injectedApp: any = null;

type ClientPage = {
  window: any;
  jar: CookieJar;
  destroy: () => Promise<void>;
};

type DemoFixture = {
  publishedId: string;
  publishedTitle: string;
  coverAssetId: string;
  draftId: string;
};

type ShellAcceptanceResult = {
  shell: string;
  viewportWidth: number;
  publishedId: string;
  likedCountAfterClick: number;
  pendingCommentId: string;
  pendingSummaryCount: number;
  approvedSummaryCount: number;
  deletedSummaryCount: number;
};

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const serverRoot = path.resolve(scriptDir, "../..");
const repoRoot = path.resolve(serverRoot, "..");

async function loadTestHarnessModule() {
  const modulePath = path.resolve(serverRoot, "tests/_testHarness.ts");
  return import(pathToFileURL(modulePath).href) as Promise<any>;
}

function stripRuntimeScripts(html: string) {
  return html
    .replace(/<script\b(?:(?!id="videoObjectJsonLd")[^>])*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b(?:(?!id="videoObjectJsonLd")[^>])*\/>/gi, "");
}

function parseCount(node: any) {
  return Number(String(node?.textContent || "0").trim() || "0");
}

function createCookieJar(): CookieJar {
  return new Map<string, string>();
}

function cookieHeaderFromJar(jar: CookieJar) {
  return Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join("; ");
}

function updateCookieJar(jar: CookieJar, response: Response) {
  const rawCookies = typeof (response.headers as any).getSetCookie === "function"
    ? (response.headers as any).getSetCookie()
    : [];
  for (const raw of rawCookies) {
    const first = String(raw || "").split(";")[0] || "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    jar.set(first.slice(0, eq), first.slice(eq + 1));
  }
}

async function injectFetch(url: URL, init: RequestInit, headers: Headers) {
  if (!injectedApp) {
    throw new Error("acceptance_inject_app_missing");
  }
  const response = await injectedApp.inject({
    method: init.method || "GET",
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(headers.entries()),
    payload: init.body,
  });
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(response.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(key, String(item));
    } else if (value !== undefined) {
      responseHeaders.append(key, String(value));
    }
  }
  const rawSetCookie = (response.headers || {})["set-cookie"];
  const setCookies = Array.isArray(rawSetCookie)
    ? rawSetCookie.map((item) => String(item))
    : rawSetCookie
      ? [String(rawSetCookie)]
      : [];
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    statusText: "",
    headers: {
      get(name: string) {
        return responseHeaders.get(name);
      },
      getSetCookie() {
        return setCookies;
      },
    },
    text: async () => response.body,
    json: async () => JSON.parse(response.body || "null"),
  } as Response;
}

function createHttpClient(baseUrl: string, jar = createCookieJar()) {
  async function doFetch(input: string, init: RequestInit = {}) {
    const url = new URL(input, baseUrl);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const headers = new Headers(init.headers || {});
        const cookieHeader = cookieHeaderFromJar(jar);
        if (cookieHeader) headers.set("cookie", cookieHeader);
        const response = injectedApp
          ? await injectFetch(url, init, headers)
          : await fetch(url, {
              ...init,
              headers,
              redirect: init.redirect || "follow",
            });
        updateCookieJar(jar, response);
        return response;
      } catch (error: any) {
        lastError = error;
        if (error?.cause?.code !== "ECONNREFUSED" || attempt === 4) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    }
    throw lastError;
  }

  async function json<T = any>(input: string, init: RequestInit = {}) {
    const response = await doFetch(input, init);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = payload?.message || payload?.error || response.statusText;
      throw Object.assign(new Error(message), { status: response.status, payload });
    }
    return payload as T;
  }

  return {
    jar,
    fetch: doFetch,
    json,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout_waiting_for:${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function loadHappyDomWindow(url: string) {
  const modulePath = path.resolve(repoRoot, "admin/node_modules/happy-dom/lib/index.js");
  const mod = await import(pathToFileURL(modulePath).href);
  return new mod.Window({ url });
}

function installWindowStubs(window: any, baseUrl: string, jar: CookieJar, viewportWidth: number, telegramMode: boolean) {
  const pointerCoarse = viewportWidth <= 768;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewportWidth });
  Object.defineProperty(window, "outerWidth", { configurable: true, value: viewportWidth });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: pointerCoarse ? 844 : 900 });
  Object.defineProperty(window.navigator, "standalone", { configurable: true, value: false });

  window.matchMedia = (query: string) => ({
    matches:
      (query.includes("pointer: coarse") && pointerCoarse) ||
      (query.includes("display-mode: standalone") && false),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });

  window.scrollTo = () => {};
  window.open = () => null;
  window.confirm = () => true;
  window.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  window.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout);
  window.gtag = () => {};
  window.Hls = function HlsMock(this: any) {
    this.loadSource = () => {};
    this.attachMedia = () => {};
    this.destroy = () => {};
    this.on = () => {};
    this.off = () => {};
  };
  window.Hls.isSupported = () => false;
  window.Telegram = {
    WebApp: telegramMode
      ? {
          initData: "acceptance=1",
          initDataUnsafe: { user: { id: 90000001 } },
          ready() {},
          expand() {},
          setHeaderColor() {},
          setBackgroundColor() {},
          showPopup(_: any, callback?: (buttonId: string) => void) { callback?.("usdt"); return Promise.resolve("usdt"); },
          openInvoice(_: string, callback?: (status: string) => void) { callback?.("cancelled"); },
          openTelegramLink() {},
        }
      : {
          initData: "",
          initDataUnsafe: {},
          ready() {},
          expand() {},
          setHeaderColor() {},
          setBackgroundColor() {},
          showPopup(_: any, callback?: (buttonId: string) => void) { callback?.("usdt"); return Promise.resolve("usdt"); },
          openTelegramLink() {},
        },
  };

  if (window.HTMLMediaElement?.prototype) {
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.HTMLMediaElement.prototype.pause = () => {};
    window.HTMLMediaElement.prototype.load = () => {};
  }

  const client = createHttpClient(baseUrl, jar);
  window.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const target = typeof input === "string" || input instanceof URL
      ? String(input)
      : String((input as Request).url);
    return client.fetch(target, init);
  };
}

async function bootClientPage(input: {
  baseUrl: string;
  htmlPath: string;
  appJsPath: string;
  contentId: string;
  viewportWidth: number;
  telegramMode: boolean;
  jar?: CookieJar;
}) : Promise<ClientPage> {
  const jar = input.jar || createCookieJar();
  const pageUrl = `${input.baseUrl}/#view=content&id=${encodeURIComponent(input.contentId)}&from=home`;
  const window = await loadHappyDomWindow(pageUrl);
  installWindowStubs(window, input.baseUrl, jar, input.viewportWidth, input.telegramMode);

  const html = stripRuntimeScripts(await fs.readFile(input.htmlPath, "utf8"));
  window.document.write(html);
  window.document.close();

  const appJs = await fs.readFile(input.appJsPath, "utf8");
  window.eval(appJs);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));

  try {
    await waitFor(() => {
      const detailView = window.document.getElementById("detailView");
      const commentInput = window.document.getElementById("detailCommentInput");
      const title = window.document.querySelector("#detailContent h2");
      return !!detailView && !detailView.classList.contains("is-hidden") && !!commentInput && !!title;
    }, `detail_shell_ready:${path.basename(input.appJsPath)}`);
  } catch (error: any) {
    const detailHtml = String(window.document.getElementById("detailContent")?.innerHTML || "").slice(0, 500);
    const homeHtml = String(window.document.getElementById("homeBannerList")?.innerHTML || "").slice(0, 120);
    const globalError = String(window.document.getElementById("globalErrorMessage")?.textContent || "");
    const inlineToast = String(window.document.getElementById("inlineToast")?.textContent || "");
    throw new Error(`${String(error?.message || error)}|hash=${window.location.hash}|home=${homeHtml}|detail=${detailHtml}|global=${globalError}|toast=${inlineToast}`);
  }

  return {
    window,
    jar,
    destroy: async () => {
      try { window.happyDOM?.abort?.(); } catch {}
      try { window.close?.(); } catch {}
    },
  };
}

async function click(window: any, selector: string) {
  const node = window.document.querySelector(selector) as HTMLButtonElement | null;
  assert.ok(node, `missing node: ${selector}`);
  if (typeof node.click === "function") node.click();
  node.dispatchEvent(new window.Event("click", { bubbles: true }));
  if (typeof (node as any).onclick === "function") (node as any).onclick(new window.Event("click"));
}

async function setTextareaValue(window: any, selector: string, value: string) {
  const node = window.document.querySelector(selector) as HTMLTextAreaElement | null;
  assert.ok(node, `missing textarea: ${selector}`);
  node.value = value;
  node.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function createAcceptanceApp(prisma: any) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(session, {
    secret: "isolated-video-interaction-acceptance-session-secret-123456",
    cookie: { secure: false, sameSite: "lax" },
  });
  app.decorate("prisma", prisma);
  app.decorateRequest("userId", null);
  app.decorateRequest("telegramUserId", null);
  app.addHook("preHandler", async (req) => {
    const sess = req.session as any;
    if (sess?.userId) {
      (req as any).userId = sess.userId;
      (req as any).telegramUserId = sess.telegramUserId || null;
    }
  });
  app.post("/__test/login-admin/:role", async (req) => {
    const role = String((req.params as any).role || "");
    const admin = await prisma.adminUser.findFirst({ where: { role }, select: { id: true, email: true, role: true } });
    if (!admin) throw new Error(`missing_admin_role:${role}`);
    (req.session as any).admin = { adminId: admin.id, email: admin.email, role: admin.role };
    return { ok: true };
  });
  app.post("/__test/login-user/:id", async (req) => {
    const userId = String((req.params as any).id || "");
    (req.session as any).userId = userId;
    (req.session as any).telegramUserId = null;
    return { ok: true };
  });

  await app.register(authH5Routes, { prefix: "/api" });
  await app.register(homeRoutes, { prefix: "/api" });
  await app.register(contentRoutes, { prefix: "/api" });
  await app.register(orderRoutes, { prefix: "/api" });
  await app.register(resourcesRoutes, { prefix: "/api" });
  await app.register(watchProgressRoutes, { prefix: "/api" });
  await app.register(interactionRoutes, { prefix: "/api" });
  await app.register(adminInteractionRoutes, { prefix: "/api" });
  return app;
}

async function seedVideoFixture(prisma: any, label: string): Promise<DemoFixture> {
  const coverAsset = await prisma.mediaAsset.create({
    data: {
      kind: "cover_image",
      status: "ready",
      storageBackend: "local_disk",
      originalFilename: `${label}-cover.jpg`,
      mimeType: "image/jpeg",
      contentLength: BigInt(1024),
      storagePublicUrl: `https://example.com/${label}-cover.jpg`,
      widthPixels: 1280,
      heightPixels: 720,
      lastVerifiedAt: new Date(),
      note: `isolated_acceptance_${label}`,
    },
  });

  const published = await prisma.content.create({
    data: {
      id: `accept-video-${label}-published`,
      title: `隔离验收视频 ${label.toUpperCase()}`,
      description: `仅用于隔离测试库的视频详情互动验收：${label}`,
      accessType: "public",
      status: "published",
      platformPlaybackEnabled: true,
      previewEnabled: false,
      durationSeconds: 321,
      publishedAt: new Date(),
      coverAssetId: coverAsset.id,
      coverUrl: null,
      sortOrder: 90,
      tags: ["acceptance", label],
    },
  });

  const draft = await prisma.content.create({
    data: {
      id: `accept-video-${label}-draft`,
      title: `隔离验收草稿视频 ${label.toUpperCase()}`,
      description: "用于验证未发布内容拒绝互动。",
      accessType: "public",
      status: "draft",
      platformPlaybackEnabled: false,
      previewEnabled: false,
      durationSeconds: 123,
      coverAssetId: coverAsset.id,
      coverUrl: null,
      sortOrder: 0,
      tags: ["acceptance", "draft", label],
    },
  });

  const allCategory = await prisma.category.findFirst({ where: { slug: "all" }, select: { id: true } });
  if (allCategory) {
    await prisma.contentCategory.createMany({
      data: [
        { contentId: published.id, categoryId: allCategory.id },
        { contentId: draft.id, categoryId: allCategory.id },
      ],
      skipDuplicates: true,
    });
  }

  return {
    publishedId: published.id,
    publishedTitle: published.title,
    coverAssetId: coverAsset.id,
    draftId: draft.id,
  };
}

async function loginAdminClient(baseUrl: string) {
  const adminClient = createHttpClient(baseUrl);
  try {
    await adminClient.json("/__test/login-admin/customer_service", { method: "POST" });
  } catch (error: any) {
    if (error?.status !== 500 || !String(error?.message || "").includes("missing_admin_role")) throw error;
    await adminClient.json("/__test/login-admin/super_admin", { method: "POST" });
  }
  return adminClient;
}

async function createTrustedUserClient(baseUrl: string, prisma: any, label: string, approvedTargetId = "topic-00-pub") {
  const user = await prisma.user.create({
    data: {
      displayName: `隔离验收用户 ${label}`,
      status: "active",
      telegramUserId: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 100000)),
    },
  });
  await prisma.interactionComment.create({
    data: {
      targetType: "video_content",
      targetId: approvedTargetId,
      userId: user.id,
      body: `隔离验收历史通过评论 ${label}`,
      status: "approved",
    },
  });
  const client = createHttpClient(baseUrl);
  await client.json(`/__test/login-user/${encodeURIComponent(user.id)}`, { method: "POST" });
  return { client, user };
}

async function acceptShellFlow(input: {
  shell: string;
  viewportWidth: number;
  htmlPath: string;
  appJsPath: string;
  baseUrl: string;
  fixture: DemoFixture;
  telegramMode: boolean;
  adminClient: ReturnType<typeof createHttpClient>;
  prisma: any;
}) : Promise<ShellAcceptanceResult> {
  const firstLoad = await bootClientPage({
    baseUrl: input.baseUrl,
    htmlPath: input.htmlPath,
    appJsPath: input.appJsPath,
    contentId: input.fixture.publishedId,
    viewportWidth: input.viewportWidth,
    telegramMode: input.telegramMode,
  });
  try {
    const shellClient = createHttpClient(input.baseUrl, firstLoad.jar);
    try {
      await shellClient.json("/api/auth/h5/session");
    } catch (error: any) {
      if (error?.status !== 401) throw error;
      await shellClient.json("/api/auth/h5/guest-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    }
  } finally {
    await firstLoad.destroy();
  }

  const actionLoad = await bootClientPage({
    baseUrl: input.baseUrl,
    htmlPath: input.htmlPath,
    appJsPath: input.appJsPath,
    contentId: input.fixture.publishedId,
    viewportWidth: input.viewportWidth,
    telegramMode: input.telegramMode,
    jar: firstLoad.jar,
  });
  try {
    await waitFor(() => parseCount(actionLoad.window.document.getElementById("detailCommentCount")) === 0, `initial_comment_count:${input.shell}`);

    await click(actionLoad.window, "#detailLikeButton");
    await waitFor(() => actionLoad.window.document.getElementById("detailLikeButton")?.classList.contains("is-active"), `target_like_active:${input.shell}`);
    const likedCountAfterClick = parseCount(actionLoad.window.document.getElementById("detailLikeCount"));

    const commentBody = `隔离验收 ${input.shell} 评论待审`;
    const shellClient = createHttpClient(input.baseUrl, actionLoad.jar);
    await shellClient.json("/api/interactions/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetType: "video_content",
        targetId: input.fixture.publishedId,
        body: commentBody,
      }),
    });

    await waitFor(
      async () => {
        const row = await input.prisma.interactionComment.findFirst({
          where: {
            targetType: "video_content",
            targetId: input.fixture.publishedId,
            body: commentBody,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        return !!row?.id;
      },
      `pending_comment_created:${input.shell}`,
    );

    const pendingSummary = await shellClient.json<any>(`/api/interactions/summary?targetType=video_content&targetId=${encodeURIComponent(input.fixture.publishedId)}`);
    const pendingList = await shellClient.json<any>(`/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(input.fixture.publishedId)}&sort=hot&pageSize=10`);
    assert.equal(pendingSummary.summary.commentCount, 0, `${input.shell} pending comments must stay hidden`);
    assert.equal(Array.isArray(pendingList.items) ? pendingList.items.length : 0, 0, `${input.shell} pending list must stay empty`);
    assert.equal(parseCount(actionLoad.window.document.getElementById("detailCommentCount")), 0, `${input.shell} detail count must stay zero while pending`);

    const pendingRow = await input.prisma.interactionComment.findFirst({
      where: {
        targetType: "video_content",
        targetId: input.fixture.publishedId,
        body: commentBody,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    assert.ok(pendingRow?.id, `${input.shell} pending comment row must exist`);
    assert.equal(pendingRow.status, "pending", `${input.shell} comment must be pending before moderation`);

    await input.adminClient.json(`/api/admin/interactions/comments/${encodeURIComponent(pendingRow.id)}/moderate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", reason: `隔离验收放行 ${input.shell}` }),
    });

    const approvedLoad = await bootClientPage({
      baseUrl: input.baseUrl,
      htmlPath: input.htmlPath,
      appJsPath: input.appJsPath,
      contentId: input.fixture.publishedId,
      viewportWidth: input.viewportWidth,
      telegramMode: input.telegramMode,
      jar: actionLoad.jar,
    });
    try {
      await waitFor(
        () => parseCount(approvedLoad.window.document.getElementById("detailCommentCount")) === 1,
        `approved_comment_count:${input.shell}`,
      );
      await waitFor(
        () => approvedLoad.window.document.querySelectorAll(".interaction-comment").length === 1,
        `approved_comment_visible:${input.shell}`,
      );
      const approvedSummary = await shellClient.json<any>(`/api/interactions/summary?targetType=video_content&targetId=${encodeURIComponent(input.fixture.publishedId)}`);
      const approvedList = await shellClient.json<any>(`/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(input.fixture.publishedId)}&sort=hot&pageSize=10`);
      assert.equal(approvedSummary.summary.commentCount, 1, `${input.shell} approved count must become visible`);
      assert.equal(Array.isArray(approvedList.items) ? approvedList.items.length : 0, 1, `${input.shell} approved list must contain one item`);
      assert.ok(approvedLoad.window.document.querySelector('[data-interaction-delete-comment]'), `${input.shell} detail list must expose delete action after approval`);

      await click(approvedLoad.window, '[data-interaction-delete-comment]');
      await waitFor(
        () => parseCount(approvedLoad.window.document.getElementById("detailCommentCount")) === 0,
        `deleted_comment_count:${input.shell}`,
      );
      await waitFor(
        () => approvedLoad.window.document.querySelectorAll(".interaction-comment").length === 0,
        `deleted_comment_hidden:${input.shell}`,
      );

      const deletedSummary = await shellClient.json<any>(`/api/interactions/summary?targetType=video_content&targetId=${encodeURIComponent(input.fixture.publishedId)}`);
      const deletedList = await shellClient.json<any>(`/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(input.fixture.publishedId)}&sort=hot&pageSize=10`);
      assert.equal(deletedSummary.summary.commentCount, 0, `${input.shell} deleted comment count must rollback`);
      assert.equal(Array.isArray(deletedList.items) ? deletedList.items.length : 0, 0, `${input.shell} deleted comment must disappear from list`);

      return {
        shell: input.shell,
        viewportWidth: input.viewportWidth,
        publishedId: input.fixture.publishedId,
        likedCountAfterClick,
        pendingCommentId: pendingRow.id,
        pendingSummaryCount: pendingSummary.summary.commentCount,
        approvedSummaryCount: approvedSummary.summary.commentCount,
        deletedSummaryCount: deletedSummary.summary.commentCount,
      };
    } finally {
      await approvedLoad.destroy();
    }
  } finally {
    await actionLoad.destroy();
  }
}

async function verifyDraftRejects(baseUrl: string, prisma: any, draftId: string) {
  const { client } = await createTrustedUserClient(baseUrl, prisma, "draft-reject");
  try {
    await client.json("/api/interactions/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetType: "video_content",
        targetId: draftId,
        body: "草稿内容不应允许互动。",
      }),
    });
    throw new Error("draft_interaction_unexpected_success");
  } catch (error: any) {
    assert.equal(error?.status, 404, "draft content interactions must be rejected");
  }
}

async function verifyCursorPagination(baseUrl: string, prisma: any, publishedId: string) {
  const { client } = await createTrustedUserClient(baseUrl, prisma, "cursor");
  const bodies = ["cursor-1", "cursor-2", "cursor-3"];
  const createdIds: string[] = [];
  for (const body of bodies) {
    const created = await client.json<any>("/api/interactions/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetType: "video_content",
        targetId: publishedId,
        body,
      }),
    });
    createdIds.push(created.comment.id);
  }
  const page1 = await client.json<any>(`/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(publishedId)}&sort=new&pageSize=2`);
  assert.equal(page1.items.length, 2, "cursor page1 must contain two comments");
  assert.ok(page1.nextCursor, "cursor page1 must expose nextCursor");
  const page2 = await client.json<any>(`/api/interactions/comments?targetType=video_content&targetId=${encodeURIComponent(publishedId)}&sort=new&pageSize=2&cursor=${encodeURIComponent(page1.nextCursor)}`);
  assert.equal(page2.items.length, 1, "cursor page2 must contain remaining comment");
  return {
    page1Count: page1.items.length,
    page2Count: page2.items.length,
    nextCursorPresent: !!page1.nextCursor,
    commentIds: createdIds,
  };
}

async function verifyTargetReportRestriction(
  baseUrl: string,
  prisma: any,
  adminClient: ReturnType<typeof createHttpClient>,
  publishedId: string,
) {
  const { client } = await createTrustedUserClient(baseUrl, prisma, "target-report");
  const created = await client.json<any>("/api/interactions/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetType: "video_content",
      targetId: publishedId,
      reasonCode: "other",
      detailText: "隔离验收：目标级举报。",
    }),
  });
  try {
    await adminClient.json(`/api/admin/interactions/reports/${encodeURIComponent(created.report.id)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "actioned", resolutionNote: "不应成功" }),
    });
    throw new Error("target_level_actioned_unexpected_success");
  } catch (error: any) {
    assert.equal(error?.status, 409, "target-level actioned must be rejected");
    assert.equal(error?.payload?.error, "target_level_action_not_supported");
  }
  return { reportId: created.report.id };
}

async function verifyNoForbiddenJobs(prisma: any, contentIds: string[]) {
  const [uploadSessions, transcodeJobs, publishJobs, playbackSessions] = await Promise.all([
    prisma.uploadSession.count({ where: { contentId: { in: contentIds } } }),
    prisma.transcodeJob.count({ where: { contentId: { in: contentIds } } }),
    prisma.telegramPublishJob.count({ where: { contentId: { in: contentIds } } }),
    prisma.playbackSession.count({ where: { contentId: { in: contentIds } } }),
  ]);
  assert.equal(uploadSessions, 0, "acceptance must not create upload sessions");
  assert.equal(transcodeJobs, 0, "acceptance must not trigger transcode jobs");
  assert.equal(publishJobs, 0, "acceptance must not create Telegram publish jobs");
  assert.equal(playbackSessions, 0, "acceptance must not create playback sessions");
  return { uploadSessions, transcodeJobs, publishJobs, playbackSessions };
}

async function runBootstrapPreflight(baseUrl: string, fixture: DemoFixture) {
  const client = createHttpClient(baseUrl);
  const guest = await client.json<any>("/api/auth/h5/guest-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const home = await client.json<any>("/api/home");
  const detail = await client.json<any>(`/api/contents/${encodeURIComponent(fixture.publishedId)}`);
  return {
    guestIdentity: guest.identity,
    homeLatestCount: Array.isArray(home.latest) ? home.latest.length : Array.isArray(home.contents) ? home.contents.length : 0,
    detailId: detail.id,
    detailStatus: detail.playbackStatus?.action || null,
  };
}

async function main() {
  const testHarness = await loadTestHarnessModule();
  const harness = await testHarness.setupTestHarness();
  const prisma = harness.prisma;
  let app: any = null;
  try {
    await testHarness.seedTestData(prisma);
    const fixtures = {
      h5: await seedVideoFixture(prisma, "h5"),
      pc: await seedVideoFixture(prisma, "pc"),
      mini: await seedVideoFixture(prisma, "mini"),
    };

    app = await createAcceptanceApp(prisma);
    injectedApp = app;
    await app.ready();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = typeof address === "string"
      ? address.replace(/\/+$/, "")
      : `http://127.0.0.1:${(app.server.address() as any).port}`;
    const adminClient = await loginAdminClient(baseUrl);

    const htmlH5 = path.resolve(repoRoot, "h5/index.html");
    const appH5 = path.resolve(repoRoot, "h5/app.js");
    const htmlMini = path.resolve(repoRoot, "telegram-mini-app/index.html");
    const appMini = path.resolve(repoRoot, "telegram-mini-app/app.js");

    await Promise.all([
      fs.access(htmlH5),
      fs.access(appH5),
      fs.access(htmlMini),
      fs.access(appMini),
    ]);
    const preflight = await runBootstrapPreflight(baseUrl, fixtures.h5);
    const shellResults = [
      await acceptShellFlow({
        shell: "h5",
        viewportWidth: 390,
        htmlPath: htmlH5,
        appJsPath: appH5,
        baseUrl,
        fixture: fixtures.h5,
        telegramMode: false,
        adminClient,
        prisma,
      }),
      await acceptShellFlow({
        shell: "pc",
        viewportWidth: 1280,
        htmlPath: htmlH5,
        appJsPath: appH5,
        baseUrl,
        fixture: fixtures.pc,
        telegramMode: false,
        adminClient,
        prisma,
      }),
      await acceptShellFlow({
        shell: "mini_app",
        viewportWidth: 390,
        htmlPath: htmlMini,
        appJsPath: appMini,
        baseUrl,
        fixture: fixtures.mini,
        telegramMode: true,
        adminClient,
        prisma,
      }),
    ];

    await verifyDraftRejects(baseUrl, prisma, fixtures.h5.draftId);
    const cursor = await verifyCursorPagination(baseUrl, prisma, fixtures.h5.publishedId);
    const targetReport = await verifyTargetReportRestriction(baseUrl, prisma, adminClient, fixtures.pc.publishedId);
    const jobCounts = await verifyNoForbiddenJobs(prisma, [
      fixtures.h5.publishedId,
      fixtures.pc.publishedId,
      fixtures.mini.publishedId,
      fixtures.h5.draftId,
      fixtures.pc.draftId,
      fixtures.mini.draftId,
    ]);

    console.log(JSON.stringify({
      ok: true,
      isolatedTestDbOnly: true,
      autoCleanup: true,
      preflight,
      shellResults,
      cursor,
      targetReport,
      jobCounts,
      notes: [
        "Demo 视频内容仅写入隔离测试库。",
        "已验证已发布+平台播放开启+带封面+带时长内容可互动，草稿内容拒绝互动。",
        "已验证 pending -> approved 后列表、详情、计数同步变化。",
        "脚本 finally 会关闭服务并清空隔离测试库中的测试数据、会话与审核记录。",
      ],
    }, null, 2));
  } finally {
    injectedApp = null;
    if (app) {
      try { await app.close(); } catch {}
    }
    await testHarness.teardownTestHarness(prisma);
  }
}

await main();
