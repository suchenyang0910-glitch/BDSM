(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const RECENT_KEY = "intune_recent_views_v1";

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
    single_delivery_not_enabled: "首期不支持单条共享频道交付，请选择会员或内容包。",
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
    const fallbackTitle = "同频 · 精选点播";
    const fallbackDescription = "同频内容目录与权益入口";
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
    const raw = String(window.location.hash || "").replace(/^#/, "");
    const params = new URLSearchParams(raw);
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

  function getRecentItems() {
    try {
      const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (item) { return item && item.id; }).slice(0, 3);
    } catch (_) {
      return [];
    }
  }

  function rememberRecent(detail) {
    if (!detail || !detail.id) return;
    const next = getRecentItems().filter(function (item) { return item.id !== detail.id; });
    next.unshift({
      id: detail.id,
      title: detail.title || "未命名内容",
      duration: detail.duration || "—",
      accessType: detail.accessType || "public",
      coverUrl: detail.coverUrl || null,
      viewedAt: new Date().toISOString(),
    });
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, 3)));
  }

  function renderContentCards(hostId, items, fromTab) {
    const host = $(hostId);
    host.innerHTML = "";
    const template = $("contentCardTemplate");
    items.forEach(function (item) {
      const node = template.content.cloneNode(true);
      const cover = node.querySelector(".card-cover");
      if (item.coverUrl) {
        cover.style.backgroundImage = "linear-gradient(135deg, rgba(166, 107, 255, 0.24), rgba(38, 34, 54, 0.72)), url('" + String(item.coverUrl).replace(/'/g, "%27") + "')";
        cover.style.backgroundSize = "cover";
        cover.style.backgroundPosition = "center";
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
        setHashForDetail(item.id, fromTab);
      });
      const action = node.querySelector(".card-action");
      action.textContent = item.unlocked ? "查看详情" : "查看并了解权益";
      action.addEventListener("click", function () {
        setHashForDetail(item.id, fromTab);
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
      if (banner.imageUrl) {
        card.style.backgroundImage = "linear-gradient(140deg, rgba(166, 107, 255, 0.3), rgba(38, 34, 54, 0.92)), url('" + String(banner.imageUrl).replace(/'/g, "%27") + "')";
      }
      card.innerHTML =
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

  function renderRecentList() {
    const section = $("homeRecentSection");
    const host = $("homeRecentList");
    const recent = getRecentItems();
    if (!recent.length) {
      section.classList.add("is-hidden");
      host.innerHTML = "";
      return;
    }
    section.classList.remove("is-hidden");
    host.innerHTML = "";
    recent.forEach(function (item) {
      const card = document.createElement("article");
      card.className = "recent-visual-card";
      const safeCover = item.coverUrl ? String(item.coverUrl).replace(/'/g, "%27") : "";
      if (safeCover) {
        card.style.backgroundImage = "linear-gradient(180deg, transparent 25%, rgba(10, 8, 18, 0.82)), url('" + safeCover + "')";
      }
      card.innerHTML =
        '<button class="recent-visual-action" type="button" aria-label="继续查看 ' + escapeHtml(item.title) + '">' +
        '<span class="cover-duration">' + escapeHtml(item.duration || "—") + "</span>" +
        '<strong>' + escapeHtml(item.title) + "</strong>" +
        "</button>";
      card.querySelector("button").addEventListener("click", function () {
        setHashForDetail(item.id, "home");
      });
      host.appendChild(card);
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
    renderRecentList();
    renderThemeCards();
    renderContentCards("homeLatestGrid", state.home.latestContents || [], "home");
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
        setHashForDetail(item.sampleContentId, "membership");
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
          window.location.assign("./h5-pay.html?orderNo=" + encodeURIComponent(order.orderNo));
          return;
        }
        if (order.product && order.product.id) {
          const target = (state.library.items || []).find(function (item) { return item.productId === order.product.id; });
          if (target) setHashForDetail(target.id, "me");
        }
      });
      actions.appendChild(primary);
      host.appendChild(card);
    });
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
      ? "当前账户 · " + (session.displayName || "已连接 Telegram")
      : (session.displayName || "同频用户");
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
      return { text: "前往频道", handler: function () { openChannelAccess(detail.id); } };
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
    rememberRecent(detail);
    renderRecentList();
    updatePageSeo(detail.effectiveSeo || { title: detail.title, description: detail.description, keywords: [] });
    updateOgImage(detail.coverUrl || "");
    updateJsonLd(detail.videoObjectJsonLd || null);

    const primaryAction = getPrimaryDetailAction(detail);
    const pendingOrder = detail.product ? pendingOrderForProduct(detail.product.id) : null;
    const coverClass = detail.coverUrl ? "detail-cover has-image" : "detail-cover";
    $("detailContent").innerHTML =
      '<div class="' + coverClass + '"' + (detail.coverUrl ? ' style="background-image:url(\'' + String(detail.coverUrl).replace(/'/g, "%27") + '\')"' : "") + '></div>' +
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
          (detail.product && detail.product.usdtPriceMinor ? ' 支持 USDT-TRC20：' + escapeHtml(formatPriceMinor(detail.product.usdtPriceMinor, "USDT")) + '。' : '') + '</p>' +
          (state.env.isTelegram && detail.product && detail.product.usdtPriceMinor
            ? '<button id="detailUsdtButton" class="text-button" type="button">使用 USDT-TRC20 支付</button>'
            : '') + '</div>';
      } else if (detail.accessType === "package") {
        purchaseHost.innerHTML =
          '<div class="detail-purchase-item"><strong>推荐购买方式</strong><p class="detail-note">1. 解锁所属内容包；2. 若你已经拥有该包权益，可直接前往频道。</p></div>';
      }
    }

    $("detailPrimaryButton").addEventListener("click", primaryAction.handler);
    const usdtButton = $("detailUsdtButton");
    if (usdtButton && detail.product) {
      usdtButton.addEventListener("click", function () {
        window.location.assign("./h5-pay.html?productId=" + encodeURIComponent(detail.product.id));
      });
    }
    $("detailBackButton").addEventListener("click", function () {
      setHashForTab(state.route.fromTab || "home");
    });
  }

  function handleBannerAction(banner) {
    if (banner.targetType === "content" && banner.targetId) {
      setHashForDetail(banner.targetId, "home");
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
        setHashForDetail(target.id, "home");
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
          displayName: payload.user && (payload.user.first_name || payload.user.username)
            ? (payload.user.first_name || payload.user.username)
            : "Telegram 用户",
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
    if (state.env.isTelegram && isStarsProduct(detail.product)) {
      await createStarsOrderAndPay(detail);
      return;
    }
    // H5 always uses USDT-TRC20. In Mini App Stars stays the primary route,
    // while products without Stars can still use the same lightweight USDT page.
    window.location.assign("./h5-pay.html?productId=" + encodeURIComponent(detail.product.id));
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
    tg.openInvoice(invoiceLink, function () {
      loadOrders();
      loadEntitlements();
      showInlineMessage("Stars 支付已提交，请稍后在「我的」查看订单与权益状态。");
    });
  }

  function routeTo(routeState) {
    state.route = routeState;
    const isDetail = routeState.view === "detail";
    const titleMap = {
      home: ["同频", ""],
      library: ["片库", "搜索、分类与筛选"],
      membership: ["会员", "会员主频道与内容包"],
      me: ["我的", "资产、订单、频道入口与绑定"],
    };

    $("backButton").hidden = !isDetail;
    $("bottomNav").classList.toggle("is-hidden", isDetail);
    $("appHeader").classList.toggle("is-home", !isDetail && routeState.tab === "home");
    $("headerTitle").textContent = isDetail ? "视频详情" : titleMap[routeState.tab][0];
    $("headerSubtitle").textContent = isDetail ? "查看权益与购买方式" : titleMap[routeState.tab][1];
    $("headerSubtitle").hidden = !isDetail && routeState.tab === "home";
    $("headerEyebrow").hidden = !isDetail && routeState.tab === "home";

    ["home", "library", "membership", "me"].forEach(function (tab) {
      $(tab + "View").classList.toggle("is-hidden", isDetail || routeState.tab !== tab);
    });
    $("detailView").classList.toggle("is-hidden", !isDetail);

    document.querySelectorAll(".nav-item").forEach(function (button) {
      button.classList.toggle("is-active", !isDetail && button.getAttribute("data-tab") === routeState.tab);
    });

    if (isDetail) {
      renderDetail(routeState.id);
      return;
    }

    if (!state.library.loaded && routeState.tab !== "home") loadLibrary();
    if (routeState.tab === "membership") renderMembership();
    if (routeState.tab === "me") {
      loadOrders();
      loadEntitlements();
      loadChannels();
    }
  }

  async function bootstrapApp() {
    if (state.booting) return;
    try {
      await bootstrapSession();
      await loadHome();
      await loadLibrary();
      await Promise.all([loadOrders(), loadEntitlements(), loadChannels()]);
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
    $("homeLatestGrid").innerHTML = createSkeletonCards(4);
    $("libraryGrid").innerHTML = createSkeletonCards(4);
    $("membershipPrimaryCard").innerHTML = createSkeletonCards(1);
    $("meUnlockedList").innerHTML = createSkeletonCards(1);
    if (!window.location.hash) setHashForTab("home");
    else routeTo(parseHash());
    bootstrapApp();
  });
})();
