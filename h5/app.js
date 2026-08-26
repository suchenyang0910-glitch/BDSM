(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  const CLIENT_ERRORS = {
    unauthorized: "请先完成会话建立后再继续。",
    forbidden: "你当前没有对应权益，请先完成购买。",
    method_not_allowed: "当前入口只允许 POST 交付，页面已按新方式修复。",
    content_unavailable: "该内容暂时不可用。",
    delivery_channel_not_configured: "交付频道尚未配置，请稍后再试。",
    bot_not_configured: "服务端邀请 Bot 尚未配置完成，请联系管理员。",
    auth_h5_guest_unavailable: "自动登录创建失败，请稍后重试。",
    auth_h5_session_internal: "会话读取失败，请稍后重试。",
    auth_h5_guest_internal: "系统暂时无法建立登录会话，请稍后重试。",
    stars_invoice_service_unavailable: "Stars 发票暂时不可用，请稍后重试。",
    stars_continue_expired: "Stars 续付窗口已过期，请重新下单。",
    single_delivery_not_available: "当前内容暂不支持单条购买，请选择内容包或月度会员。",
  };

  const state = {
    env: {
      // Telegram 会在普通 H5 页面也注入 WebApp SDK 对象，甚至可能留下空的
      // initData。只有真实 Mini App 同时具备已注入的 Telegram 用户与 initData，
      // 才允许走 Stars / Popup；其余所有网页访问统一走 H5 + USDT。
      isTelegram: !!(tg && tg.initData && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id),
      hasInitData: !!(tg && tg.initData && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id),
    },
    session: null,
    booting: false,
    home: null,
    detailCache: {},
    detailLoading: false,
    library: {
      loading: false,
      items: [],
      loaded: false,
      categoryId: "all",
      search: "",
      sort: "newest",
    },
    orders: {
      loading: false,
      items: [],
    },
    entitlements: {
      loading: false,
      loaded: false,
      data: null,
    },
    channels: {
      loading: false,
      loaded: false,
      items: [],
    },
    watch: {
      loading: false,
      loaded: false,
      recent: null,
      history: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    },
    player: {
      contentId: "",
      video: null,
      lastProgressSecond: -1,
      started: false,
    },
    resumeIntent: null,
    route: {
      tab: "home",
      view: "tab",
      id: "",
      fromTab: "home",
    },
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function imageTag(url, className, alt, eager) {
    if (!url) return "";
    return '<img class="' + className + '" src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt || "") + '"' +
      (eager ? ' loading="eager" decoding="async"' : ' loading="lazy" decoding="async"') + " />";
  }

  function apiText(err) {
    const payload = err && err.payload ? err.payload : {};
    const code = payload.userError || payload.error || payload.errorClass || "";
    if (code && CLIENT_ERRORS[code]) return CLIENT_ERRORS[code];
    return payload.message || err.message || "请稍后重试。";
  }

  function requestWithCompatibility(url, opts) {
    if (typeof window.fetch === "function") return window.fetch(url, opts);
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open(opts.method || "GET", url, true);
      xhr.withCredentials = opts.credentials === "include";
      Object.keys(opts.headers || {}).forEach(function (key) {
        xhr.setRequestHeader(key, opts.headers[key]);
      });
      xhr.onload = function () {
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          text: function () { return Promise.resolve(xhr.responseText || ""); },
        });
      };
      xhr.onerror = function () { reject(new Error("network_request_failed")); };
      xhr.send(opts.body || null);
    });
  }

  async function apiCall(url, options) {
    const opts = options || {};
    const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const res = await requestWithCompatibility(url, {
      credentials: "include",
      method: opts.method || "GET",
      body: opts.body,
      headers: headers,
    });
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }
    if (!res.ok) {
      const err = new Error((payload && (payload.message || payload.error)) || ("HTTP " + res.status));
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  function trackAnalytics(eventName, payload) {
    // 仅发送白名单事件与最小业务字段；服务端会再次校验、哈希化并丢弃未知字段。
    requestWithCompatibility("/api/analytics/events", {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ events: [{ eventName: eventName, payload: Object.assign({ platform: state.env.isTelegram ? "telegram_mini_app" : "h5" }, payload || {}) }] }),
    }).catch(function () {});
  }

  function isStarsProduct(product) {
    return product && String(product.currency || "").toUpperCase() === "XTR";
  }

  function normalizeXtrMinor(minor) {
    try {
      const value = BigInt(minor == null || minor === "" ? "0" : String(minor));
      if (value > 0n && value >= 1000000n && value % 1000000n === 0n) return value / 1000000n;
      return value;
    } catch (_) {
      return null;
    }
  }

  function formatPriceMinor(minor, currency) {
    if (minor == null || minor === "") return "未配置价格";
    if (String(currency || "").toUpperCase() === "XTR") {
      const starsMinor = normalizeXtrMinor(minor);
      return starsMinor == null ? String(minor) + " XTR" : starsMinor.toString() + " Stars";
    }
    const numeric = Number(minor);
    if (!Number.isFinite(numeric)) return String(minor) + " " + (currency || "");
    if (String(currency || "").toUpperCase() === "USDT") {
      return (numeric / 1000000).toFixed(2).replace(/\.?0+$/, "") + " USDT";
    }
    return numeric + " " + (currency || "");
  }

  function formatAvailablePrices(item) {
    const primary = formatPriceMinor(item && item.priceMinor, item && item.priceCurrency);
    if (!item || item.usdtPriceMinor == null || item.usdtPriceMinor === "") return primary;
    const usdt = formatPriceMinor(item.usdtPriceMinor, "USDT");
    return primary + " · " + usdt;
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function formatDateShort(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function formatSecondsClock(seconds) {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = safe % 60;
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return h > 0 ? (h + ":" + pad(m) + ":" + pad(s)) : (pad(m) + ":" + pad(s));
  }

  function ensureMetaTag(selector, attrs) {
    let element = document.head.querySelector(selector);
    if (!element) {
      element = document.createElement("meta");
      Object.keys(attrs).forEach(function (key) { element.setAttribute(key, attrs[key]); });
      document.head.appendChild(element);
    }
    return element;
  }

  function setMetaContent(selector, attrs, value) {
    const element = ensureMetaTag(selector, attrs);
    element.setAttribute("content", String(value || ""));
  }

  function updatePageSeo(seo) {
    const fallbackTitle = "同频 · H5 点播";
    const fallbackDescription = "同频 H5 点播：免费试看、单条购买、内容包与月度会员。";
    const title = seo && seo.title ? seo.title : fallbackTitle;
    const description = seo && seo.description ? seo.description : fallbackDescription;
    const keywords = seo && Array.isArray(seo.keywords) ? seo.keywords.join(",") : "";
    document.title = title;
    setMetaContent('meta[name="description"]', { name: "description" }, description);
    setMetaContent('meta[name="keywords"]', { name: "keywords" }, keywords);
    setMetaContent('meta[name="robots"]', { name: "robots" }, "noindex,nofollow");
    setMetaContent('meta[property="og:title"]', { property: "og:title" }, title);
    setMetaContent('meta[property="og:description"]', { property: "og:description" }, description);
  }

  function updateOgImage(imageUrl) {
    setMetaContent('meta[property="og:image"]', { property: "og:image" }, imageUrl || "");
  }

  function updateJsonLd(jsonLd) {
    const el = $("videoObjectJsonLd");
    if (el) el.textContent = jsonLd ? JSON.stringify(jsonLd) : "";
  }

  function parseHash() {
    // Telegram 免费频道/H5 外链使用 ?content=<UUID>；查询参数优先于首页 hash，
    // 确保用户点击推广链接时直接进入对应内容详情，而不是落回首页。
    const queryContentId = new URLSearchParams(window.location.search).get("content");
    if (queryContentId) {
      return { view: "detail", id: queryContentId, tab: "home", fromTab: "home" };
    }
    const raw = String(window.location.hash || "").replace(/^#/, "");
    const params = new URLSearchParams(raw);
    if (params.get("view") === "history") {
      return {
        view: "history",
        id: "",
        tab: "me",
        fromTab: params.get("from") || "me",
      };
    }
    if (params.get("view") === "content" && params.get("id")) {
      return {
        view: "detail",
        id: params.get("id") || "",
        tab: params.get("from") || "home",
        fromTab: params.get("from") || "home",
      };
    }
    const tab = params.get("tab") || "home";
    return { view: "tab", id: "", tab: tab, fromTab: tab };
  }

  function setHashForTab(tab) {
    const url = new URL(window.location.href);
    url.searchParams.delete("content");
    window.history.replaceState(null, "", url.pathname + (url.search || ""));
    const params = new URLSearchParams();
    params.set("tab", tab);
    window.location.hash = params.toString();
  }

  function setHashForDetail(id, fromTab) {
    const params = new URLSearchParams();
    params.set("view", "content");
    params.set("id", id);
    params.set("from", fromTab || "home");
    window.location.hash = params.toString();
  }

  function setHashForHistory(fromTab) {
    const params = new URLSearchParams();
    params.set("view", "history");
    params.set("from", fromTab || "me");
    window.location.hash = params.toString();
  }

  function openContentDetail(id, fromTab, options) {
    const opts = options || {};
    state.resumeIntent = {
      contentId: id,
      resumePositionSec: Math.max(0, Math.floor(Number(opts.resumePositionSec) || 0)),
      autoplay: !!opts.autoplay,
    };
    setHashForDetail(id, fromTab);
  }

  function showBootError(title, message) {
    $("globalErrorTitle").textContent = title;
    $("globalErrorMessage").textContent = message;
    $("globalError").classList.remove("is-hidden");
  }

  function clearBootError() {
    $("globalError").classList.add("is-hidden");
  }

  function showInlineMessage(message) {
    if (state.env.isTelegram && tg && tg.showPopup) {
      tg.showPopup({ title: "提示", message: message, buttons: [{ type: "ok" }] }).catch(function () {});
      return;
    }
    window.alert(message);
  }

  function createSkeletonCards(count) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push('<div class="skeleton"></div>');
    return out.join("");
  }

  function getAccessLabel(item) {
    if (item.unlocked) return "已解锁";
    if (item.accessType === "public") return "公开预览";
    if (item.accessType === "membership") return "会员内容";
    if (item.accessType === "package") return "内容包内容";
    return "查看详情";
  }

  function getLastPlayedSubtitle(item) {
    if (!item) return "暂无播放记录";
    if (item.isFinished) return "已看完，下次从头播放";
    return "上次看到 " + formatSecondsClock(item.positionSec || 0);
  }

  function applyWatchProgressItem(item, options) {
    if (!item || !item.contentId) return;
    const opts = options || {};
    const existed = (state.watch.history || []).some(function (entry) { return entry.contentId === item.contentId; });
    const history = (state.watch.history || []).filter(function (entry) { return entry.contentId !== item.contentId; });
    history.unshift(item);
    state.watch.history = history;
    state.watch.recent = history[0] || null;
    if (!existed) {
      const total = Number(state.watch.pagination.total || 0) + 1;
      state.watch.pagination.total = total;
      state.watch.pagination.totalPages = Math.max(1, Math.ceil(total / (state.watch.pagination.pageSize || 20)));
    }
    if (!opts.skipRender) {
      renderHomeResume();
      renderMeResume();
      if (state.route.view === "history") renderWatchHistory();
    }
  }

  function removeWatchProgressItem(contentId) {
    state.watch.history = (state.watch.history || []).filter(function (item) { return item.contentId !== contentId; });
    state.watch.recent = state.watch.history[0] || null;
    const nextTotal = Math.max(0, Number(state.watch.pagination.total || 0) - 1);
    state.watch.pagination.total = nextTotal;
    state.watch.pagination.totalPages = Math.max(1, Math.ceil(nextTotal / (state.watch.pagination.pageSize || 20)));
    renderHomeResume();
    renderMeResume();
    if (state.route.view === "history") renderWatchHistory();
  }

  function clearWatchProgressState() {
    state.watch.history = [];
    state.watch.recent = null;
    state.watch.pagination = { page: 1, pageSize: 20, total: 0, totalPages: 1 };
    renderHomeResume();
    renderMeResume();
    if (state.route.view === "history") renderWatchHistory();
  }

  function renderContentCards(hostId, items, fromTab) {
    const host = $(hostId);
    host.innerHTML = "";
    const template = $("contentCardTemplate");
    items.forEach(function (item) {
      const node = template.content.cloneNode(true);
      const coverImage = node.querySelector(".cover-image");
      if (item.coverUrl && coverImage) {
        coverImage.src = item.coverUrl;
        coverImage.alt = item.title || "内容封面";
        coverImage.classList.remove("is-hidden");
      }
      node.querySelector(".cover-duration").textContent = item.duration || "—";
      node.querySelector(".card-tag").textContent = (item.tags || []).join(" · ") || getAccessLabel(item);
      node.querySelector(".card-title").textContent = item.title || "未命名内容";
      node.querySelector(".card-desc").textContent = item.description || "暂无描述";
      node.querySelector(".card-price").textContent = item.accessType === "public"
        ? "公开预览"
        : formatAvailablePrices(item);
      node.querySelector(".card-access").textContent = getAccessLabel(item);
      node.querySelector(".cover-button").addEventListener("click", function () {
        openContentDetail(item.id, fromTab, { autoplay: false, resumePositionSec: 0 });
      });
      const action = node.querySelector(".card-action");
      action.textContent = item.unlocked ? "查看详情" : "查看并了解权益";
      action.addEventListener("click", function () {
        openContentDetail(item.id, fromTab, { autoplay: false, resumePositionSec: 0 });
      });
      host.appendChild(node);
    });
  }

  function renderBannerList() {
    const home = state.home;
    const host = $("homeBannerList");
    host.innerHTML = "";
    if (!home || !home.banners || home.banners.length === 0) {
      host.innerHTML = '<div class="inline-state">当前没有 Banner 配置。</div>';
      return;
    }
    home.banners.forEach(function (banner) {
      const card = document.createElement("article");
      card.className = "banner-card" + (banner.imageUrl ? " has-image" : "");
      card.innerHTML =
        imageTag(banner.imageUrl, "banner-image", banner.title || "首页 Banner", true) +
        '<h3>' + escapeHtml(banner.title || "") + '</h3>' +
        '<button class="banner-action" type="button">' + escapeHtml(banner.actionLabel || "查看") + '</button>';
      card.addEventListener("click", function () {
        handleBannerAction(banner);
      });
      host.appendChild(card);
    });
  }

  function renderFeaturedCard() {
    const host = $("homeFeaturedCard");
    const featured = state.home && state.home.featuredContent ? state.home.featuredContent : null;
    if (!featured) {
      host.innerHTML = '<div class="inline-state">当前还没有配置今日精选。</div>';
      return;
    }
    host.innerHTML = "";
    renderContentCards("homeFeaturedCard", [featured], "home");
  }

  function renderHomeResume() {
    const section = $("homeRecentSection");
    const host = $("homeRecentCard");
    const recent = state.watch.recent;
    if (!recent) {
      section.classList.add("is-hidden");
      host.innerHTML = "";
      return;
    }
    section.classList.remove("is-hidden");
    host.innerHTML =
      '<article class="resume-card">' +
      '<button class="resume-cover-button" type="button" aria-label="继续播放 ' + escapeHtml(recent.title) + '">' +
      '<div class="resume-cover">' +
      imageTag(recent.coverUrl, "resume-cover-image", recent.title || "上次播放封面", true) +
      '<span class="cover-duration">' + escapeHtml(recent.duration || "—") + "</span>" +
      "</div>" +
      "</button>" +
      '<div class="resume-body">' +
      '<div class="resume-title-row"><strong>' + escapeHtml(recent.title || "未命名内容") + '</strong><span class="resume-time">' + escapeHtml(formatDateShort(recent.lastPlayedAt)) + "</span></div>" +
      '<div class="resume-progress-track"><span class="resume-progress-value" style="width:' + escapeHtml(String(Math.max(0, Math.min(100, recent.progressPercent || 0)))) + '%"></span></div>' +
      '<div class="resume-meta"><span>' + escapeHtml(getLastPlayedSubtitle(recent)) + '</span><button class="primary-button" type="button">继续播放</button></div>' +
      "</div>" +
      "</article>";
    host.querySelector(".resume-cover-button").addEventListener("click", function () {
      openContentDetail(recent.contentId, "home", { autoplay: true, resumePositionSec: recent.resumePositionSec || 0 });
    });
    host.querySelector(".resume-meta .primary-button").addEventListener("click", function () {
      openContentDetail(recent.contentId, "home", { autoplay: true, resumePositionSec: recent.resumePositionSec || 0 });
    });
  }

  function renderDesktopRail() {
    const host = $("desktopRailContent");
    if (!host) return;
    const recent = state.watch.recent;
    const membership = state.entitlements.data && state.entitlements.data.summary
      ? state.entitlements.data.summary.membership
      : { status: "none", expiresAt: null };
    const featured = state.home && state.home.featuredContent ? state.home.featuredContent : null;
    const profileName = state.session && state.session.displayName ? state.session.displayName : "同频成员";
    const membershipActive = membership.status === "active";

    host.innerHTML =
      '<section class="desktop-rail-card desktop-profile-card">' +
        '<p class="eyebrow">MY ACCOUNT</p>' +
        '<strong>' + escapeHtml(profileName) + '</strong>' +
        '<span class="desktop-rail-muted">' + escapeHtml(membershipActive
          ? (membership.expiresAt ? "会员有效至 " + formatDateShort(membership.expiresAt) : "会员已开通")
          : "尚未开通会员") + '</span>' +
        '<button id="desktopMembershipButton" class="ghost-button" type="button">' + (membershipActive ? "管理权益" : "查看会员") + '</button>' +
      '</section>' +
      '<section class="desktop-rail-card">' +
        '<div class="desktop-rail-head"><div><p class="eyebrow">CONTINUE</p><h3>上次播放</h3></div></div>' +
        (recent
          ? '<button id="desktopResumeButton" class="desktop-resume-button" type="button">' +
              '<span class="desktop-resume-cover">' + imageTag(recent.coverUrl, "desktop-resume-image", recent.title || "上次播放封面", true) + '</span>' +
              '<span class="desktop-resume-copy"><strong>' + escapeHtml(recent.title || "未命名内容") + '</strong><small>' + escapeHtml(getLastPlayedSubtitle(recent)) + '</small></span>' +
            '</button>'
          : '<p class="desktop-rail-empty">打开一条内容后，可在这里继续观看。</p>') +
      '</section>' +
      (featured
        ? '<section class="desktop-rail-card desktop-featured-rail">' +
            '<div class="desktop-rail-head"><div><p class="eyebrow">CURATED</p><h3>今日精选</h3></div></div>' +
            '<button id="desktopFeaturedButton" class="desktop-featured-button" type="button">' +
              '<span class="desktop-featured-cover">' + imageTag(featured.coverUrl, "desktop-featured-image", featured.title || "今日精选封面", true) + '</span>' +
              '<span>' + escapeHtml(featured.title || "查看今日精选") + '</span>' +
            '</button>' +
          '</section>'
        : "");

    const membershipButton = $("desktopMembershipButton");
    if (membershipButton) membershipButton.addEventListener("click", function () { setHashForTab("membership"); });
    const resumeButton = $("desktopResumeButton");
    if (resumeButton && recent) resumeButton.addEventListener("click", function () {
      openContentDetail(recent.contentId, "home", { autoplay: true, resumePositionSec: recent.resumePositionSec || 0 });
    });
    const featuredButton = $("desktopFeaturedButton");
    if (featuredButton && featured) featuredButton.addEventListener("click", function () {
      openContentDetail(featured.id, "home", { autoplay: false, resumePositionSec: 0 });
    });
  }

  function renderThemeCards() {
    const themes = (state.home && state.home.themeCategories ? state.home.themeCategories : [])
      .filter(function (theme) {
        return Number(theme.publishedContentCount || 0) > 0 && String(theme.name || "") !== "全部";
      })
      .slice(0, 4);
    const section = $("homeThemesSection");
    const host = $("homeThemesList");
    host.innerHTML = "";
    // Themes are a secondary navigation aid, never a blank or dominant block.
    // Require at least two useful choices; otherwise the library filter is clearer.
    if (themes.length < 2) {
      section.classList.add("is-hidden");
      return;
    }
    section.classList.remove("is-hidden");
    themes.forEach(function (theme) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "topic-chip";
      card.innerHTML = '<strong>' + escapeHtml(theme.name) + '</strong>';
      card.addEventListener("click", function () {
        state.library.categoryId = theme.id;
        setHashForTab("library");
      });
      host.appendChild(card);
    });
  }

  function renderHome() {
    if (!state.home) {
      $("homeBannerList").innerHTML = createSkeletonCards(1);
      $("homeFeaturedCard").innerHTML = createSkeletonCards(1);
      $("homeLatestGrid").innerHTML = createSkeletonCards(4);
      return;
    }
    renderBannerList();
    renderFeaturedCard();
    renderHomeResume();
    renderThemeCards();
    renderContentCards("homeLatestGrid", state.home.latestContents || [], "home");
    renderDesktopRail();
    updatePageSeo(state.home.seo || null);
    updateOgImage("");
    updateJsonLd(null);
  }

  function renderLibraryCategories() {
    const host = $("libraryCategoryList");
    const categories = (state.home && state.home.categories) || [];
    host.innerHTML = "";
    categories.forEach(function (category) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip" + (state.library.categoryId === category.id ? " is-active" : "");
      btn.textContent = category.name;
      btn.addEventListener("click", function () {
        state.library.categoryId = category.id;
        loadLibrary();
      });
      host.appendChild(btn);
    });
  }

  function renderLibrary() {
    renderLibraryCategories();
    if (state.library.loading) {
      $("libraryState").textContent = "片库加载中…";
      $("libraryGrid").innerHTML = createSkeletonCards(6);
      return;
    }
    const items = state.library.items.filter(function (item) {
      const keyword = String(state.library.search || "").trim().toLowerCase();
      return !keyword
        || String(item.title || "").toLowerCase().includes(keyword)
        || String(item.description || "").toLowerCase().includes(keyword);
    });
    $("libraryState").textContent = items.length ? "共 " + items.length + " 条内容" : "没有匹配结果。";
    if (!items.length) {
      $("libraryGrid").innerHTML = '<div class="inline-state">当前没有匹配内容。</div>';
      return;
    }
    renderContentCards("libraryGrid", items, "library");
  }

  function groupPackageItems(items) {
    const map = new Map();
    items.forEach(function (item) {
      const packageId = item.packageId || "package:" + item.id;
      if (!map.has(packageId)) {
        map.set(packageId, {
          id: packageId,
          title: item.packageTitle || item.title,
          count: 0,
          priceMinor: item.priceMinor,
          priceCurrency: item.priceCurrency,
          usdtPriceMinor: item.usdtPriceMinor,
          unlocked: false,
          sampleContentId: item.id,
        });
      }
      const target = map.get(packageId);
      target.count += 1;
      target.unlocked = target.unlocked || !!item.unlocked;
    });
    return Array.from(map.values());
  }

  function findMembershipEntry() {
    const items = state.library.items || [];
    return items.find(function (item) { return item.accessType === "membership"; }) || null;
  }

  function renderMembership() {
    const summary = state.entitlements.data && state.entitlements.data.summary
      ? state.entitlements.data.summary.membership
      : { status: "none", expiresAt: null };
    const badge = $("membershipStatusBadge");
    if (summary.status === "active") {
      badge.textContent = summary.expiresAt ? "有效至 " + formatDateShort(summary.expiresAt) : "已开通";
      badge.className = "status-badge";
      $("membershipHeadline").textContent = "会员主频道与内容包";
      $("membershipCopy").textContent = "支付成功后，只会进入你实际拥有权益对应的频道。";
    } else {
      badge.textContent = "未开通";
      badge.className = "status-badge status-warning";
      $("membershipHeadline").textContent = "理解权益，再决定购买方式";
      $("membershipCopy").textContent = state.env.isTelegram
        ? "Telegram 内默认优先使用 Stars，同时提供 USDT。"
        : "H5 默认使用 USDT；若需 Stars，请在 Telegram 内打开。";
    }

    const membershipEntry = findMembershipEntry();
    const membershipHost = $("membershipPrimaryCard");
    if (!membershipEntry) {
      membershipHost.innerHTML = '<div class="inline-state">当前还没有配置会员主频道入口。</div>';
    } else {
      membershipHost.innerHTML = "";
      renderContentCards("membershipPrimaryCard", [membershipEntry], "membership");
    }

    const packageHost = $("membershipPackagesList");
    const packages = groupPackageItems((state.library.items || []).filter(function (item) { return item.accessType === "package"; }));
    packageHost.innerHTML = "";
    if (!packages.length) {
      packageHost.innerHTML = '<div class="inline-state">当前没有在售内容包。</div>';
      return;
    }
    packages.forEach(function (item) {
      const card = document.createElement("article");
      card.className = "stack-card";
      card.innerHTML =
        '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(item.title) + '</div>' +
        '<div class="stack-subtitle">共 ' + escapeHtml(String(item.count)) + ' 条内容</div></div>' +
        '<div class="status-badge' + (item.unlocked ? "" : " status-warning") + '">' + escapeHtml(item.unlocked ? "已解锁" : "内容包") + "</div></div>" +
        '<div class="stack-meta"><span>' + escapeHtml(formatAvailablePrices(item)) + '</span><span>' + escapeHtml(item.unlocked ? "可直接进入对应频道" : "购买后解锁该包频道") + "</span></div>" +
        '<div class="channel-actions" style="margin-top:12px;"><button class="primary-button" type="button">' + escapeHtml(item.unlocked ? "查看已解锁内容" : "查看内容包") + "</button></div>";
      card.querySelector("button").addEventListener("click", function () {
        openContentDetail(item.sampleContentId, "membership", { autoplay: false, resumePositionSec: 0 });
      });
      packageHost.appendChild(card);
    });
  }

  function renderUnlockedList() {
    const host = $("meUnlockedList");
    const items = (state.library.items || []).filter(function (item) { return item.unlocked; }).slice(0, 8);
    host.innerHTML = "";
    if (!items.length) {
      host.innerHTML = '<div class="inline-state">暂无已解锁内容。</div>';
      return;
    }
    items.forEach(function (item) {
      const card = document.createElement("article");
      card.className = "stack-card";
      card.innerHTML =
        '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(item.title) + '</div>' +
        '<div class="stack-subtitle">' + escapeHtml(getAccessLabel(item)) + '</div></div>' +
        '<div class="status-badge">已解锁</div></div>' +
        '<div class="channel-actions" style="margin-top:12px;"><button class="primary-button" type="button">前往频道</button></div>';
      card.querySelector("button").addEventListener("click", function () {
        openChannelAccess(item.id);
      });
      host.appendChild(card);
    });
  }

  function renderChannelCards() {
    const host = $("meChannelsList");
    host.innerHTML = "";
    if (!state.channels.items.length) {
      host.innerHTML = '<div class="inline-state">当前没有可进入的频道。</div>';
      return;
    }
    state.channels.items.forEach(function (item) {
      const card = document.createElement("article");
      card.className = "stack-card";
      card.innerHTML =
        '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(item.label) + '</div>' +
        '<div class="stack-subtitle">' + escapeHtml(item.subtitle || "") + '</div></div>' +
        '<div class="status-badge' + (item.available ? "" : " status-warning") + '">' + escapeHtml(item.available ? "可进入" : "待配置") + "</div></div>" +
        '<div class="channel-actions" style="margin-top:12px;"><button class="' + (item.available ? "primary-button" : "ghost-button") + '" type="button">' + escapeHtml(item.accessMode === "public_link" ? "打开频道" : "进入频道") + "</button></div>";
      const button = card.querySelector("button");
      button.disabled = !item.available;
      button.addEventListener("click", function () {
        if (item.link) {
          if (tg && tg.openTelegramLink) tg.openTelegramLink(item.link);
          else window.open(item.link, "_blank", "noopener");
          return;
        }
        if (item.resourceId) openChannelAccess(item.resourceId);
      });
      if (!item.available && item.reason) {
        const note = document.createElement("div");
        note.className = "stack-note";
        note.textContent = item.reason;
        card.appendChild(note);
      }
      host.appendChild(card);
    });
  }

  function renderOrdersList() {
    const host = $("meOrdersList");
    host.innerHTML = "";
    if (state.orders.loading) {
      host.innerHTML = createSkeletonCards(2);
      return;
    }
    if (!state.orders.items.length) {
      host.innerHTML = '<div class="inline-state">当前没有订单记录。</div>';
      return;
    }
    state.orders.items.forEach(function (order) {
      const statusClass = order.status === "paid" ? "" : (order.status === "pending" ? " status-warning" : " status-danger");
      const card = document.createElement("article");
      card.className = "stack-card";
      card.innerHTML =
        '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(order.product && order.product.title ? order.product.title : order.orderNo) + '</div>' +
        '<div class="stack-subtitle">订单号 ' + escapeHtml(order.orderNo) + "</div></div>" +
        '<div class="status-badge' + statusClass + '">' + escapeHtml(order.status) + "</div></div>" +
        '<div class="stack-meta"><span>' + escapeHtml(formatPriceMinor(order.amountMinor, order.currency)) + '</span><span>' + escapeHtml(formatDate(order.createdAt)) + "</span></div>" +
        '<div class="channel-actions" style="margin-top:12px;"></div>';
      const actions = card.querySelector(".channel-actions");
      const primary = document.createElement("button");
      primary.type = "button";
      primary.className = order.status === "pending" ? "primary-button" : "ghost-button";
      primary.textContent = order.status === "pending" && !state.env.isTelegram && order.product && !isStarsProduct(order.product)
        ? "继续 USDT 支付"
        : order.status === "paid"
          ? "查看权益"
          : "查看内容";
      primary.addEventListener("click", function () {
        if (order.status === "pending" && !state.env.isTelegram && order.product && !isStarsProduct(order.product)) {
          window.location.assign("/h5-pay.html?orderNo=" + encodeURIComponent(order.orderNo));
          return;
        }
        if (order.product && order.product.id) {
          const target = (state.library.items || []).find(function (item) { return item.productId === order.product.id; });
          if (target) openContentDetail(target.id, "me", { autoplay: false, resumePositionSec: 0 });
        }
      });
      actions.appendChild(primary);
      host.appendChild(card);
    });
  }

  function renderMeResume() {
    const host = $("meResumeCard");
    const recent = state.watch.recent;
    if (!recent) {
      host.innerHTML = '<div class="inline-state">还没有观看记录，去首页或片库打开一条内容后，这里会显示上次播放。</div>';
      return;
    }
    host.innerHTML =
      '<article class="resume-card">' +
      '<button class="resume-cover-button" type="button" aria-label="继续播放 ' + escapeHtml(recent.title) + '">' +
      '<div class="resume-cover">' +
      imageTag(recent.coverUrl, "resume-cover-image", recent.title || "上次播放封面", true) +
      '<span class="cover-duration">' + escapeHtml(recent.duration || "—") + "</span>" +
      "</div>" +
      "</button>" +
      '<div class="resume-body">' +
      '<div class="resume-title-row"><strong>' + escapeHtml(recent.title || "未命名内容") + '</strong><span class="resume-time">' + escapeHtml(formatDate(recent.lastPlayedAt)) + "</span></div>" +
      '<div class="resume-progress-track"><span class="resume-progress-value" style="width:' + escapeHtml(String(Math.max(0, Math.min(100, recent.progressPercent || 0)))) + '%"></span></div>' +
      '<div class="resume-meta"><span>' + escapeHtml(getLastPlayedSubtitle(recent)) + '</span><button class="primary-button" type="button">继续播放</button></div>' +
      "</div>" +
      "</article>";
    host.querySelector(".resume-cover-button").addEventListener("click", function () {
      openContentDetail(recent.contentId, "me", { autoplay: true, resumePositionSec: recent.resumePositionSec || 0 });
    });
    host.querySelector(".resume-meta .primary-button").addEventListener("click", function () {
      openContentDetail(recent.contentId, "me", { autoplay: true, resumePositionSec: recent.resumePositionSec || 0 });
    });
  }

  function renderWatchHistory() {
    const host = $("watchHistoryList");
    const empty = $("watchHistoryEmpty");
    const loadMore = $("watchHistoryLoadMore");
    const clearAll = $("watchHistoryClearButton");
    const items = state.watch.history || [];
    host.innerHTML = "";

    if (!items.length) {
      empty.classList.remove("is-hidden");
      loadMore.classList.add("is-hidden");
      clearAll.disabled = true;
      return;
    }

    empty.classList.add("is-hidden");
    clearAll.disabled = false;
    items.forEach(function (item) {
      const card = document.createElement("article");
      card.className = "history-card";
      card.innerHTML =
        '<button class="history-cover-button" type="button" aria-label="继续播放 ' + escapeHtml(item.title) + '">' +
        '<div class="history-cover">' +
        imageTag(item.coverUrl, "history-cover-image", item.title || "历史封面") +
        '<span class="cover-duration">' + escapeHtml(item.duration || "—") + "</span>" +
        "</div>" +
        "</button>" +
        '<div class="history-body">' +
        '<div class="history-title-row"><strong>' + escapeHtml(item.title || "未命名内容") + '</strong><span>' + escapeHtml(formatDate(item.lastPlayedAt)) + "</span></div>" +
        '<div class="resume-progress-track"><span class="resume-progress-value" style="width:' + escapeHtml(String(Math.max(0, Math.min(100, item.progressPercent || 0)))) + '%"></span></div>' +
        '<div class="history-meta"><span>' + escapeHtml(getLastPlayedSubtitle(item)) + '</span><span>' + escapeHtml(getAccessLabel(item)) + "</span></div>" +
        '<div class="history-actions"><button class="primary-button" type="button">继续播放</button><button class="ghost-button" type="button">删除记录</button></div>' +
        "</div>";
      const buttons = card.querySelectorAll("button");
      buttons[0].addEventListener("click", function () {
        openContentDetail(item.contentId, "me", { autoplay: true, resumePositionSec: item.resumePositionSec || 0 });
      });
      buttons[1].addEventListener("click", function () {
        openContentDetail(item.contentId, "me", { autoplay: true, resumePositionSec: item.resumePositionSec || 0 });
      });
      buttons[2].addEventListener("click", function () {
        deleteWatchHistoryItem(item.contentId);
      });
      host.appendChild(card);
    });

    const hasMore = state.watch.pagination.page < state.watch.pagination.totalPages;
    loadMore.classList.toggle("is-hidden", !hasMore);
  }

  function renderPreferenceCards() {
    $("mePreferenceList").innerHTML =
      '<article class="stack-card"><div class="stack-head"><div><div class="stack-title">内容偏好</div><div class="stack-subtitle">控制推荐与内容主题偏好</div></div></div><div class="stack-note">首期保留基础能力，后续会接入更细的偏好配置与推荐开关。</div></article>' +
      '<article class="stack-card"><div class="stack-head"><div><div class="stack-title">帮助、规则与隐私</div><div class="stack-subtitle">账号与安全、通知设置、帮助反馈</div></div></div><div class="stack-note">如需跨设备恢复权益，请先在此页绑定 Telegram。</div></article>';
  }

  function renderMe() {
    const session = state.session;
    const isTelegram = session && session.identity === "telegram";
    $("profileTitle").textContent = isTelegram
      ? "我的昵称 · " + (session.displayName || "同频成员")
      : (session.displayName || "同频成员");
    $("profileSubtitle").textContent = isTelegram
      ? "已连接 Telegram，可跨设备恢复订单与权益。"
      : "已自动登录；绑定 Telegram 后可跨设备恢复订单与权益。";

    const membershipSummary = state.entitlements.data && state.entitlements.data.summary
      ? state.entitlements.data.summary.membership
      : { status: "none", expiresAt: null };
    $("meMembershipText").textContent = membershipSummary.status === "active"
      ? (membershipSummary.expiresAt ? "已开通至 " + formatDateShort(membershipSummary.expiresAt) : "已开通")
      : "未开通";
    $("meMembershipHint").textContent = membershipSummary.status === "active"
      ? "会员内容会在详情页直接展示频道入口。"
      : "会员与内容包购买入口在「会员」页。";
    $("meOrdersText").textContent = state.orders.items.length ? "共 " + state.orders.items.length + " 条" : "暂无订单";
    $("meOrdersHint").textContent = state.orders.items.some(function (item) { return item.status === "pending"; })
      ? "你有待支付订单，通知入口会直接带你回到这里。"
      : "已支付、待支付、失效订单都会统一收进这里。";

    renderMeResume();
    renderUnlockedList();
    renderChannelCards();
    renderOrdersList();
    renderPreferenceCards();
  }

  function pendingOrderForProduct(productId) {
    return (state.orders.items || []).find(function (order) {
      return order.status === "pending" && order.product && order.product.id === productId;
    }) || null;
  }

  function getPrimaryDetailAction(detail) {
    if (detail.unlocked) {
      return { text: "观看完整视频", handler: function () { openChannelAccess(detail.id); } };
    }
    if (detail.accessType === "membership") {
      return { text: "开通会员", handler: function () { startPurchase(detail); } };
    }
    if (detail.accessType === "package") {
      return { text: "查看内容包", handler: function () { startPurchase(detail); } };
    }
    return { text: "查看频道预览", handler: function () { openChannelAccess(detail.id); } };
  }

  async function renderDetail(id) {
    if (!id) {
      $("detailContent").innerHTML = '<div class="empty-state">内容 ID 缺失。</div>';
      return;
    }
    if (!state.detailCache[id]) {
      state.detailLoading = true;
      $("detailContent").innerHTML = createSkeletonCards(1);
      try {
        state.detailCache[id] = await apiCall("/api/contents/" + encodeURIComponent(id));
      } catch (err) {
        $("detailContent").innerHTML = '<div class="empty-state">加载失败：' + escapeHtml(apiText(err)) + "</div>";
        state.detailLoading = false;
        return;
      }
      state.detailLoading = false;
    }
    const detail = state.detailCache[id];
    trackAnalytics("content_opened", { contentId: detail.id, sourceModule: state.route.fromTab || "home" });
    updatePageSeo(detail.effectiveSeo || { title: detail.title, description: detail.description, keywords: [] });
    updateOgImage(detail.coverUrl || "");
    updateJsonLd(detail.videoObjectJsonLd || null);

    const primaryAction = getPrimaryDetailAction(detail);
    const pendingOrder = detail.product ? pendingOrderForProduct(detail.product.id) : null;
    // 详情页只保留一个 16:9 媒体位：有试看直接播放试看；无试看才展示封面。
    // 这样不会把同一张封面和同一段视频上下重复展示，首屏也更聚焦。
    const mediaSlot = detail.previewUrl
      ? '<section class="detail-media detail-media-preview" aria-label="免费试看">' +
        '<video class="detail-preview-video" controls playsinline preload="metadata" src="' + escapeHtml(detail.previewUrl) + '"' +
          (detail.coverUrl ? ' poster="' + escapeHtml(detail.coverUrl) + '"' : '') + '>' +
          '当前浏览器不支持视频在线播放。' +
        '</video>' +
        '<div class="detail-media-label"><strong>免费试看</strong><span>试看不需要开通会员</span></div>' +
        '</section>'
      : '<div class="detail-cover' + (detail.coverUrl ? ' has-image' : '') + '">' +
        imageTag(detail.coverUrl, "detail-image", detail.title || "内容封面", true) +
        '</div>';
    $("detailContent").innerHTML =
      mediaSlot +
      '<div class="detail-copy">' +
      '<p class="eyebrow">' + escapeHtml((detail.tags || []).join(" · ") || getAccessLabel(detail)) + '</p>' +
      '<h2>' + escapeHtml(detail.title || "") + '</h2>' +
      '<div class="detail-meta"><span>' + escapeHtml(detail.duration || "—") + '</span><span>' + escapeHtml(detail.categories && detail.categories[0] ? detail.categories[0].name : "未分类") + '</span><span>' + escapeHtml(formatDateShort(detail.publishedAt)) + '</span></div>' +
      '<div class="detail-description">' + escapeHtml(detail.description || "暂无内容介绍。") + '</div>' +
      '<div class="detail-status-card">' +
      '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(detail.unlocked ? "已解锁，可直接进入频道" : getAccessLabel(detail)) + '</div>' +
      '<div class="stack-subtitle">' + escapeHtml(detail.unlocked
        ? "该内容已归属到你当前账户的有效权益。"
        : detail.accessType === "membership"
          ? "该内容通过会员主频道交付。"
          : detail.accessType === "package"
            ? "该内容通过所属内容包频道交付。"
            : "该内容为公开预览，可直接查看。") + '</div></div>' +
      '<div class="status-badge' + (detail.unlocked ? "" : " status-warning") + '">' + escapeHtml(detail.unlocked ? "已解锁" : "未解锁") + "</div></div>" +
      (pendingOrder ? '<div class="stack-note">当前有待支付订单：' + escapeHtml(pendingOrder.orderNo) + '，可在「我的 > 我的订单」继续支付。</div>' : "") +
      '</div>' +
      (detail.accessType !== "public" ? '<div class="detail-purchase-list"></div>' : "") +
      '<div class="sticky-action-bar"><button id="detailPrimaryButton" class="primary-button" type="button">' + escapeHtml(primaryAction.text) + '</button><button id="detailBackButton" class="ghost-button" type="button">返回</button></div>' +
      "</div>";

    const purchaseHost = $("detailContent").querySelector(".detail-purchase-list");
    if (purchaseHost) {
      if (detail.accessType === "membership") {
        purchaseHost.innerHTML =
          '<div class="detail-purchase-item"><strong>推荐购买方式</strong><p class="detail-note">1. 开通会员，持续获得会员主频道更新。' +
          (state.env.isTelegram
            ? ' 请使用 Telegram Stars 完成开通。'
            : (detail.product && detail.product.usdtPriceMinor
              ? ' 站外 H5 支持 USDT-TRC20：' + escapeHtml(formatPriceMinor(detail.product.usdtPriceMinor, "USDT")) + '。'
              : '')) + '</p></div>';
      } else if (detail.accessType === "package") {
        purchaseHost.innerHTML =
          '<div class="detail-purchase-item"><strong>推荐购买方式</strong><p class="detail-note">1. 解锁所属内容包；2. 若你已经拥有该包权益，可直接前往频道。</p></div>';
      }
    }

    $("detailPrimaryButton").addEventListener("click", primaryAction.handler);
    $("detailBackButton").addEventListener("click", function () {
      setHashForTab(state.route.fromTab || "home");
    });
    attachDetailPlayer(detail);
  }

  function handleBannerAction(banner) {
    if (banner.targetType === "content" && banner.targetId) {
      openContentDetail(banner.targetId, "home", { autoplay: false, resumePositionSec: 0 });
      return;
    }
    if (banner.targetType === "category" && banner.targetId) {
      state.library.categoryId = banner.targetId;
      setHashForTab("library");
      return;
    }
    if (banner.targetType === "package" && banner.targetId) {
      const target = (state.library.items || []).find(function (item) { return item.packageId === banner.targetId; });
      if (target) {
        openContentDetail(target.id, "home", { autoplay: false, resumePositionSec: 0 });
        return;
      }
    }
    if (banner.targetType === "membership") {
      setHashForTab("membership");
      return;
    }
    if (banner.externalUrl) {
      if (/^https:\/\/t\.me\//.test(banner.externalUrl) && tg && tg.openTelegramLink) tg.openTelegramLink(banner.externalUrl);
      else window.open(banner.externalUrl, "_blank", "noopener");
    }
  }

  async function bootstrapSession() {
    state.booting = true;
    clearBootError();
    let session = null;

    if (state.env.isTelegram && state.env.hasInitData) {
      try {
        const payload = await apiCall("/api/telegram/session", {
          method: "POST",
          body: JSON.stringify({ initData: tg.initData, botKey: getLaunchBotKey() }),
        });
        session = {
          identity: "telegram",
          displayName: payload.user && payload.user.displayName
            ? payload.user.displayName
            : "同频成员",
          telegramBound: true,
          userId: payload.user && payload.user.id ? String(payload.user.id) : null,
        };
      } catch (_) {}
    }

    if (!session) {
      try {
        session = await apiCall("/api/auth/h5/session");
      } catch (err) {
        if (err.status === 401) {
          session = await apiCall("/api/auth/h5/guest-session", {
            method: "POST",
            body: JSON.stringify({}),
          });
        } else {
          throw err;
        }
      }
    }

    state.session = session;
    state.booting = false;
  }

  async function loadHome() {
    state.home = await apiCall("/api/home");
    renderHome();
  }

  async function loadLibrary() {
    if (state.library.loading) return;
    state.library.loading = true;
    renderLibrary();
    try {
      const params = new URLSearchParams({
        page: "1",
        pageSize: "50",
        sort: state.library.sort,
      });
      if (state.library.categoryId) params.set("categoryId", state.library.categoryId);
      const data = await apiCall("/api/contents?" + params.toString());
      state.library.items = data.items || [];
      state.library.loaded = true;
    } catch (err) {
      $("libraryState").textContent = "片库加载失败：" + apiText(err);
    } finally {
      state.library.loading = false;
      renderLibrary();
      renderMembership();
      renderMe();
    }
  }

  async function loadOrders() {
    if (state.orders.loading) return;
    state.orders.loading = true;
    renderOrdersList();
    try {
      const data = await apiCall("/api/user/orders?page=1&pageSize=50");
      state.orders.items = data.items || [];
    } catch (err) {
      $("meOrdersList").innerHTML = '<div class="inline-state">订单加载失败：' + escapeHtml(apiText(err)) + "</div>";
    } finally {
      state.orders.loading = false;
      renderNotifyBadge();
      renderMe();
    }
  }

  async function loadEntitlements() {
    if (state.entitlements.loading) return;
    state.entitlements.loading = true;
    try {
      state.entitlements.data = await apiCall("/api/user/entitlements");
      state.entitlements.loaded = true;
    } catch (err) {
      $("meUnlockedList").innerHTML = '<div class="inline-state">权益加载失败：' + escapeHtml(apiText(err)) + "</div>";
    } finally {
      state.entitlements.loading = false;
      renderMembership();
      renderMe();
    }
  }

  async function loadChannels() {
    if (state.channels.loading) return;
    state.channels.loading = true;
    try {
      const data = await apiCall("/api/user/channels");
      state.channels.items = data.items || [];
      state.channels.loaded = true;
    } catch (err) {
      $("meChannelsList").innerHTML = '<div class="inline-state">频道列表加载失败：' + escapeHtml(apiText(err)) + "</div>";
    } finally {
      state.channels.loading = false;
      renderMe();
    }
  }

  async function loadWatchProgress(page, append) {
    if (state.watch.loading) return;
    state.watch.loading = true;
    const targetPage = Math.max(1, Number(page) || 1);
    try {
      const data = await apiCall("/api/user/watch-progress/history?page=" + targetPage + "&pageSize=20");
      state.watch.loaded = true;
      state.watch.pagination = data.pagination || { page: targetPage, pageSize: 20, total: 0, totalPages: 1 };
      state.watch.recent = data.recent || null;
      if (append) {
        const existingIds = new Set((state.watch.history || []).map(function (item) { return item.contentId; }));
        state.watch.history = (state.watch.history || []).concat((data.items || []).filter(function (item) {
          return !existingIds.has(item.contentId);
        }));
      } else {
        state.watch.history = data.items || [];
      }
    } catch (err) {
      $("meResumeCard").innerHTML = '<div class="inline-state">播放记录加载失败：' + escapeHtml(apiText(err)) + "</div>";
      $("homeRecentCard").innerHTML = "";
      $("homeRecentSection").classList.add("is-hidden");
    } finally {
      state.watch.loading = false;
      renderHomeResume();
      renderMeResume();
      if (state.route.view === "history") renderWatchHistory();
    }
  }

  async function deleteWatchHistoryItem(contentId) {
    try {
      await apiCall("/api/user/watch-progress/" + encodeURIComponent(contentId), {
        method: "DELETE",
      });
      removeWatchProgressItem(contentId);
    } catch (err) {
      showInlineMessage("删除观看记录失败：" + apiText(err));
    }
  }

  async function clearAllWatchHistory() {
    try {
      await apiCall("/api/user/watch-progress/clear", {
        method: "POST",
        body: JSON.stringify({}),
      });
      clearWatchProgressState();
    } catch (err) {
      showInlineMessage("清空观看记录失败：" + apiText(err));
    }
  }

  function renderNotifyBadge() {
    const pending = state.orders.items.filter(function (item) { return item.status === "pending"; }).length;
    const badge = $("notifyBadge");
    if (!pending) {
      badge.classList.add("is-hidden");
      return;
    }
    badge.classList.remove("is-hidden");
    badge.textContent = pending > 99 ? "99+" : String(pending);
  }

  async function writeWatchProgress(contentId, payload) {
    const body = Object.assign({}, payload || {});
    if (!contentId || !body.eventName) return null;
    try {
      const res = await apiCall("/api/contents/" + encodeURIComponent(contentId) + "/watch-progress", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res && res.item) applyWatchProgressItem(res.item);
      return res;
    } catch (_) {
      return null;
    }
  }

  function detachActivePlayer(reason) {
    const activeVideo = state.player.video;
    const activeContentId = state.player.contentId;
    if (activeVideo && activeContentId) {
      const eventName = reason || (activeVideo.ended ? "complete" : "leave");
      writeWatchProgress(activeContentId, {
        eventName: eventName,
        positionSec: activeVideo.ended ? activeVideo.duration || activeVideo.currentTime || 0 : activeVideo.currentTime || 0,
        durationSec: activeVideo.duration || null,
        quality: "auto",
      });
    }
    state.player.video = null;
    state.player.contentId = "";
    state.player.lastProgressSecond = -1;
    state.player.started = false;
  }

  function attachDetailPlayer(detail) {
    detachActivePlayer("leave");
    const video = $("detailContent").querySelector(".detail-preview-video");
    if (!video) return;
    const intent = state.resumeIntent && state.resumeIntent.contentId === detail.id ? state.resumeIntent : null;
    const resumePosition = intent ? Math.max(0, Math.floor(Number(intent.resumePositionSec) || 0)) : 0;
    state.player.video = video;
    state.player.contentId = detail.id;
    state.player.lastProgressSecond = -1;
    state.player.started = false;

    video.addEventListener("loadedmetadata", function () {
      if (resumePosition > 0 && Number.isFinite(video.duration) && resumePosition < Math.max(video.duration - 1, 1)) {
        try { video.currentTime = resumePosition; } catch (_) {}
      }
      if (intent && intent.autoplay) {
        const playback = video.play();
        if (playback && typeof playback.catch === "function") playback.catch(function () {});
      }
      state.resumeIntent = null;
    });

    video.addEventListener("play", function () {
      if (!state.player.started) {
        state.player.started = true;
        trackAnalytics("preview_start", { contentId: detail.id, seconds: Math.floor(video.currentTime || 0) });
      }
      writeWatchProgress(detail.id, {
        eventName: "start",
        positionSec: video.currentTime || 0,
        durationSec: video.duration || detail.durationSeconds || null,
        quality: "auto",
      });
    });

    video.addEventListener("timeupdate", function () {
      const current = Math.floor(video.currentTime || 0);
      if (current <= 0) return;
      if (state.player.lastProgressSecond < 0) {
        state.player.lastProgressSecond = current;
        return;
      }
      if (current - state.player.lastProgressSecond < 15) return;
      state.player.lastProgressSecond = current;
      writeWatchProgress(detail.id, {
        eventName: "progress",
        positionSec: current,
        durationSec: video.duration || detail.durationSeconds || null,
        quality: "auto",
      });
    });

    video.addEventListener("pause", function () {
      if (video.ended) return;
      writeWatchProgress(detail.id, {
        eventName: "pause",
        positionSec: video.currentTime || 0,
        durationSec: video.duration || detail.durationSeconds || null,
        quality: "auto",
      });
    });

    video.addEventListener("ended", function () {
      trackAnalytics("preview_complete", { contentId: detail.id, seconds: Math.floor(video.duration || detail.durationSeconds || 0) });
      writeWatchProgress(detail.id, {
        eventName: "complete",
        positionSec: video.duration || video.currentTime || detail.durationSeconds || 0,
        durationSec: video.duration || detail.durationSeconds || null,
        quality: "auto",
      });
    });
  }

  function openChannelAccess(resourceId) {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/resources/" + encodeURIComponent(resourceId) + "/access-link";
    form.target = "_blank";
    form.style.display = "none";
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  function getLaunchBotKey() {
    const value = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : "";
    return /^[a-zA-Z0-9_-]{1,32}$/.test(value || "") ? value : undefined;
  }

  async function startPurchase(detail) {
    if (!detail || !detail.product) {
      showInlineMessage("当前内容没有可用商品。");
      return;
    }
    trackAnalytics("unlock_clicked", { productId: detail.product.id, paymentMethod: state.env.isTelegram ? "telegram_stars" : "usdt_trc20" });
    if (state.env.isTelegram && isStarsProduct(detail.product)) {
      await createStarsOrderAndPay(detail);
      return;
    }
    // Standalone H5 always uses USDT-TRC20. Inside Telegram, digital-content
    // checkout remains Stars-only; do not expose an in-app USDT detour.
    window.location.assign("/h5-pay.html?productId=" + encodeURIComponent(detail.product.id));
  }

  async function createStarsOrderAndPay(detail) {
    if (!tg || typeof tg.openInvoice !== "function") {
      showInlineMessage("请在 Telegram Mini App 内使用 Stars 支付。");
      return;
    }
    let created;
    try {
      created = await apiCall("/api/orders/stars", {
        method: "POST",
        body: JSON.stringify({ productId: detail.product.id }),
      });
    } catch (err) {
      showInlineMessage("创建 Stars 订单失败：" + apiText(err));
      return;
    }
    const invoiceLink =
      (created && created.created && created.created.invoiceLink) ||
      (created && created.invoice && created.invoice.invoiceLink) ||
      (created && created.order && created.order.invoiceLink) ||
      null;
    if (!invoiceLink) {
      showInlineMessage("未获得有效 Stars 发票链接。");
      return;
    }
    tg.openInvoice(invoiceLink, function (status) {
      // Telegram 会返回 paid / cancelled / failed / pending。不能把关闭、失败误报为成功。
      loadOrders();
      loadEntitlements();
      if (status === "paid") {
        showInlineMessage("Stars 支付成功，权益正在发放。可在「我的」查看订单与频道入口。");
        return;
      }
      if (status === "pending") {
        showInlineMessage("Stars 支付正在处理中，请稍后在「我的」查看订单与权益状态。");
        return;
      }
      if (status === "failed") {
        showInlineMessage("Stars 支付未完成。请确认 Telegram 账户可购买 Stars 后重新发起，或联系支持。");
        return;
      }
      showInlineMessage("已取消 Stars 支付，订单仍可在「我的」中继续处理。");
    });
  }

  function routeTo(routeState) {
    const leavingDetail = state.route && state.route.view === "detail" && routeState.view !== "detail";
    if (leavingDetail) detachActivePlayer("leave");
    state.route = routeState;
    if (routeState.view !== "detail") trackAnalytics("page_viewed", { pageName: routeState.view === "history" ? "watch_history" : routeState.tab });
    const isDetail = routeState.view === "detail";
    const isHistory = routeState.view === "history";
    const titleMap = {
      home: ["同频", ""],
      library: ["片库", "搜索、分类与筛选"],
      membership: ["会员", "会员主频道与内容包"],
      me: ["我的", "资产、订单、频道入口与绑定"],
    };
    const isHome = !isDetail && !isHistory && routeState.tab === "home";

    $("backButton").hidden = !(isDetail || isHistory);
    $("bottomNav").classList.toggle("is-hidden", isDetail || isHistory);
    $("appHeader").classList.toggle("is-home", isHome);
    $("headerTitle").textContent = isDetail ? "视频详情" : (isHistory ? "观看历史" : titleMap[routeState.tab][0]);
    $("headerSubtitle").textContent = isDetail
      ? "查看权益与购买方式"
      : isHistory
        ? "按最近播放时间排序，可删除单条或清空记录"
      : (isHome ? "真实表达，在理解与边界中被看见" : titleMap[routeState.tab][1]);
    $("headerSubtitle").hidden = false;
    $("headerEyebrow").hidden = isHome;

    ["home", "library", "membership", "me"].forEach(function (tab) {
      $(tab + "View").classList.toggle("is-hidden", isDetail || isHistory || routeState.tab !== tab);
    });
    $("detailView").classList.toggle("is-hidden", !isDetail);
    $("watchHistoryView").classList.toggle("is-hidden", !isHistory);
    $("desktopRail").classList.toggle("is-hidden", isDetail || isHistory);
    if (!isDetail && !isHistory) renderDesktopRail();

    document.querySelectorAll(".nav-item").forEach(function (button) {
      button.classList.toggle("is-active", !isDetail && !isHistory && button.getAttribute("data-tab") === routeState.tab);
    });

    if (isDetail) {
      renderDetail(routeState.id);
      return;
    }
    if (isHistory) {
      if (!state.watch.loaded) loadWatchProgress(1, false);
      renderWatchHistory();
      return;
    }

    if (!state.library.loaded && routeState.tab !== "home") loadLibrary();
    if (routeState.tab === "membership") renderMembership();
    if (routeState.tab === "me") {
      loadOrders();
      loadEntitlements();
      loadChannels();
      if (!state.watch.loaded) loadWatchProgress(1, false);
    }
  }

  async function bootstrapApp() {
    if (state.booting) return;
    try {
      await bootstrapSession();
      trackAnalytics("session_started", { entrySource: state.env.isTelegram ? "telegram_mini_app" : "h5_direct" });
      await loadHome();
      await loadLibrary();
      await Promise.all([loadOrders(), loadEntitlements(), loadChannels(), loadWatchProgress(1, false)]);
      routeTo(parseHash());
    } catch (err) {
      showBootError("暂时无法建立会话", apiText(err));
    }
  }

  function bindEvents() {
    $("retryBootstrapButton").addEventListener("click", bootstrapApp);
    $("backButton").addEventListener("click", function () {
      setHashForTab(state.route.fromTab || "home");
    });
    $("searchButton").addEventListener("click", function () {
      setHashForTab("library");
      window.setTimeout(function () {
        $("librarySearchInput").focus();
      }, 50);
    });
    $("notifyButton").addEventListener("click", function () {
      setHashForTab("me");
      window.setTimeout(function () {
        const section = $("meOrdersSection");
        if (section && typeof section.scrollIntoView === "function") section.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    });
    $("jumpLibraryButton").addEventListener("click", function () {
      setHashForTab("library");
    });
    $("meWatchHistoryButton").addEventListener("click", function () {
      setHashForHistory("me");
    });
    $("watchHistoryLoadMore").addEventListener("click", function () {
      if (state.watch.loading) return;
      loadWatchProgress((state.watch.pagination.page || 1) + 1, true);
    });
    $("watchHistoryClearButton").addEventListener("click", function () {
      clearAllWatchHistory();
    });
    $("bindTelegramButton").addEventListener("click", function () {
      const redirect = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
      window.location.assign("/login.html?redirect=" + redirect);
    });
    $("logoutButton").addEventListener("click", async function () {
      try {
        await apiCall("/api/auth/h5/logout", { method: "POST", body: JSON.stringify({}) });
      } catch (_) {}
      window.location.reload();
    });
    $("librarySearchInput").addEventListener("input", function (event) {
      state.library.search = event.target.value || "";
      renderLibrary();
    });
    $("librarySortSegment").querySelectorAll(".segment-button").forEach(function (button) {
      button.addEventListener("click", function () {
        $("librarySortSegment").querySelectorAll(".segment-button").forEach(function (node) {
          node.classList.remove("is-active");
        });
        button.classList.add("is-active");
        state.library.sort = button.getAttribute("data-sort") || "newest";
        loadLibrary();
      });
    });
    document.querySelectorAll(".nav-item").forEach(function (button) {
      button.addEventListener("click", function () {
        setHashForTab(button.getAttribute("data-tab"));
      });
    });
    window.addEventListener("hashchange", function () {
      routeTo(parseHash());
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden" && state.player.video && state.player.contentId) {
        writeWatchProgress(state.player.contentId, {
          eventName: "leave",
          positionSec: state.player.video.currentTime || 0,
          durationSec: state.player.video.duration || null,
          quality: "auto",
        });
      }
    });
    window.addEventListener("pagehide", function () {
      if (state.player.video && state.player.contentId) {
        writeWatchProgress(state.player.contentId, {
          eventName: "leave",
          positionSec: state.player.video.currentTime || 0,
          durationSec: state.player.video.duration || null,
          quality: "auto",
        });
      }
    });
  }

  function initTelegram() {
    if (!tg) return;
    try { tg.ready(); } catch (_) {}
    try { tg.expand(); } catch (_) {}
    try { tg.setHeaderColor("#12111A"); } catch (_) {}
    try { tg.setBackgroundColor("#12111A"); } catch (_) {}
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTelegram();
    bindEvents();
    $("homeBannerList").innerHTML = createSkeletonCards(1);
    $("homeFeaturedCard").innerHTML = createSkeletonCards(1);
    $("homeRecentCard").innerHTML = createSkeletonCards(1);
    $("homeLatestGrid").innerHTML = createSkeletonCards(4);
    $("libraryGrid").innerHTML = createSkeletonCards(4);
    $("membershipPrimaryCard").innerHTML = createSkeletonCards(1);
    $("meResumeCard").innerHTML = createSkeletonCards(1);
    $("meUnlockedList").innerHTML = createSkeletonCards(1);
    if (!window.location.hash) setHashForTab("home");
    else routeTo(parseHash());
    bootstrapApp();
  });
})();
