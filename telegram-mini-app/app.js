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
    auth_h5_guest_unavailable: "访客会话创建失败，请稍后重试。",
    auth_h5_session_internal: "会话读取失败，请稍后重试。",
    auth_h5_guest_internal: "系统暂时无法建立访客会话，请稍后重试。",
    stars_invoice_service_unavailable: "Stars 发票暂时不可用，请稍后重试。",
    stars_continue_expired: "Stars 续付窗口已过期，请重新下单。",
    single_delivery_not_enabled: "首期不支持单条共享频道交付，请选择会员或内容包。",
  };

  const state = {
    env: {
      isTelegram: !!tg,
      hasInitData: !!(tg && tg.initData),
    },
    session: null,
    booting: false,
    bootError: null,
    home: null,
    discover: {
      loading: false,
      loaded: false,
      items: [],
      pagination: null,
      categoryId: "all",
      search: "",
    },
    detailCache: {},
    detailLoading: false,
    orders: {
      loading: false,
      items: [],
      status: "",
      pagination: null,
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

  function ensureMetaTag(selector, attrs) {
    let el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement("meta");
      Object.keys(attrs).forEach(function (key) {
        el.setAttribute(key, attrs[key]);
      });
      document.head.appendChild(el);
    }
    return el;
  }

  function setMetaContent(selector, attrs, value) {
    const el = ensureMetaTag(selector, attrs);
    el.setAttribute("content", String(value || ""));
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
    if (!el) return;
    el.textContent = jsonLd ? JSON.stringify(jsonLd) : "";
  }

  function apiText(err) {
    const payload = err && err.payload ? err.payload : {};
    const code = payload.userError || payload.error || payload.errorClass || "";
    if (code && CLIENT_ERRORS[code]) return CLIENT_ERRORS[code];
    return payload.message || err.message || "请稍后重试。";
  }

  function isStarsProduct(product) {
    return product && String(product.currency || "").toUpperCase() === "XTR";
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function formatDateShort(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function normalizeXtrMinor(minor) {
    try {
      var n = BigInt(minor == null || minor === "" ? "0" : String(minor));
      if (n > 0n && n >= 1000000n && n % 1000000n === 0n) return n / 1000000n;
      return n;
    } catch (_) {
      return null;
    }
  }

  function formatPriceMinor(minor, currency) {
    if (minor == null || minor === "") return "未配置价格";
    if (String(currency || "").toUpperCase() === "XTR") {
      const starsMinor = normalizeXtrMinor(minor);
      if (starsMinor == null) return String(minor) + " " + (currency || "");
      return starsMinor.toString() + " Stars";
    }
    const num = Number(minor);
    if (!Number.isFinite(num)) return String(minor) + " " + (currency || "");
    if (String(currency || "").toUpperCase() === "USDT") {
      const usdt = (num / 1000000).toFixed(2).replace(/\.?0+$/, "");
      return usdt + " USDT";
    }
    return String(num) + " " + (currency || "");
  }

  function showBootError(title, message) {
    state.bootError = { title: title, message: message };
    $("globalErrorTitle").textContent = title;
    $("globalErrorMessage").textContent = message;
    $("globalError").classList.remove("is-hidden");
  }

  function clearBootError() {
    state.bootError = null;
    $("globalError").classList.add("is-hidden");
  }

  function requestWithCompatibility(url, opts) {
    if (typeof window.fetch === "function") {
      return window.fetch(url, opts);
    }
    return new Promise(function (resolve, reject) {
      if (typeof window.XMLHttpRequest !== "function") {
        reject(new Error("network_api_unavailable"));
        return;
      }
      const xhr = new window.XMLHttpRequest();
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
      xhr.ontimeout = function () { reject(new Error("network_request_timeout")); };
      xhr.send(opts.body || null);
    });
  }

  async function apiCall(url, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    if (!headers.Accept) headers.Accept = "application/json";
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

    const res = await requestWithCompatibility(url, {
      credentials: "include",
      method: opts.method || "GET",
      body: opts.body,
      headers: headers,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_) {
      payload = null;
    }
    if (!res.ok) {
      const err = new Error((payload && (payload.message || payload.error)) || ("HTTP " + res.status));
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  function parseHash() {
    const raw = String(window.location.hash || "").replace(/^#/, "");
    const params = new URLSearchParams(raw);
    const view = params.get("view");
    const id = params.get("id") || "";
    const fromTab = params.get("from") || "home";
    const tab = params.get("tab") || "home";
    if (view === "content" && id) {
      return { view: "detail", id: id, tab: fromTab, fromTab: fromTab };
    }
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
    params.set("from", fromTab || state.route.tab || "home");
    window.location.hash = params.toString();
  }

  function routeTo(hashState) {
    state.route = hashState;
    const isDetail = hashState.view === "detail";
    const titleMap = {
      home: ["同频点播", "首页 · 推荐、继续浏览与热门内容"],
      discover: ["发现", "搜索、分类筛选与完整目录"],
      membership: ["会员", "会员权益、内容包与支付入口"],
      orders: ["订单", "查看待支付、已支付与过期订单"],
      me: ["我的", "访客身份、绑定 Telegram、权益与频道入口"],
    };
    $("backButton").hidden = !isDetail;
    $("bottomNav").classList.toggle("is-hidden", isDetail);
    if (isDetail) {
      $("headerTitle").textContent = "内容详情";
      $("headerSubtitle").textContent = "返回后将恢复原来源 Tab 与浏览状态";
    } else {
      $("headerTitle").textContent = titleMap[hashState.tab][0];
      $("headerSubtitle").textContent = titleMap[hashState.tab][1];
      updateJsonLd(null);
      updatePageSeo(state.home && state.home.seo ? state.home.seo : null);
      updateOgImage("");
    }

    ["home", "discover", "membership", "orders", "me"].forEach(function (tab) {
      $(tab + "View").classList.toggle("is-hidden", isDetail || hashState.tab !== tab);
    });
    $("detailView").classList.toggle("is-hidden", !isDetail);

    document.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.classList.toggle("is-active", !isDetail && btn.getAttribute("data-tab") === hashState.tab);
    });

    if (isDetail) {
      renderDetail(hashState.id);
      return;
    }
    if (hashState.tab === "discover") loadDiscover();
    if (hashState.tab === "orders") loadOrders();
    if (hashState.tab === "me") {
      loadEntitlements();
      loadChannels();
    }
  }

  function createSkeletonCards(count) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push('<div class="skeleton"></div>');
    return out.join("");
  }

  function renderHome() {
    const home = state.home;
    if (!home) {
      $("homeBannerList").innerHTML = createSkeletonCards(2);
      $("homeRecommendedGrid").innerHTML = createSkeletonCards(4);
      $("homeUnlockedGrid").innerHTML = '<div class="inline-state">正在加载目录…</div>';
      return;
    }

    const membershipActive = !!home.meta && !!home.meta.hasMembership;
    $("heroTitle").textContent = membershipActive ? "你的会员内容已同步到当前设备" : "先浏览真实目录，再决定是否解锁";
    $("heroDescription").textContent = state.session && state.session.identity === "guest"
      ? "当前为访客模式，订单会自动保存在本设备；绑定 Telegram 后可跨端恢复权益。"
      : "当前会话已建立，可直接浏览、下单与查看订单/权益。";

    $("homeBannerList").innerHTML = "";
    if (!home.banners || home.banners.length === 0) {
      $("homeBannerList").innerHTML = '<div class="inline-state">暂无推荐 Banner。</div>';
    } else {
      home.banners.forEach(function (banner) {
        const card = document.createElement("article");
        card.className = "banner-card";
        card.innerHTML =
          '<p class="eyebrow">' + escapeHtml(banner.eyebrow || "RECOMMENDED") + '</p>' +
          '<h3>' + escapeHtml(banner.title || "") + '</h3>' +
          '<p>' + escapeHtml(banner.description || "") + '</p>' +
          '<button class="ghost-button" type="button">' + escapeHtml(banner.actionLabel || "查看") + '</button>';
        card.querySelector("button").addEventListener("click", function () {
          handleBannerAction(banner);
        });
        $("homeBannerList").appendChild(card);
      });
    }

    const recommended = (home.contents || []).slice(0, 6);
    const unlocked = (home.contents || []).filter(function (item) { return item.unlocked; }).slice(0, 4);
    renderContentCards("homeRecommendedGrid", recommended, "home");
    $("homeUnlockedGrid").innerHTML = unlocked.length ? "" : '<div class="inline-state">暂无已解锁内容，完成购买后会显示在这里。</div>';
    if (unlocked.length) renderContentCards("homeUnlockedGrid", unlocked, "home");

    renderMembershipBadge();
    renderSessionChip();
    updatePageSeo(home.seo || null);
    updateOgImage("");
    updateJsonLd(null);
  }

  function renderMembershipBadge() {
    const summary = state.entitlements.data && state.entitlements.data.summary ? state.entitlements.data.summary.membership : null;
    const badge = $("membershipStatusBadge");
    if (!summary || summary.status === "none") {
      badge.textContent = "未开通";
      badge.className = "status-badge status-warning";
      $("membershipHeadline").textContent = "会员与内容包入口";
      $("membershipCopy").textContent = state.env.isTelegram
        ? "Telegram 内优先展示 Stars；若存在 USDT 变体，可在后续版本一起呈现。"
        : "站外 H5 默认走 USDT；若当前商品仅有 Stars 版本，会提示前往 Telegram。";
      return;
    }
    if (summary.status === "active") {
      badge.textContent = summary.expiresAt ? "有效至 " + formatDateShort(summary.expiresAt) : "已生效";
      badge.className = "status-badge";
      $("membershipHeadline").textContent = "你的会员权益已生效";
      $("membershipCopy").textContent = "已生效的会员或内容包会在详情页直接展示进入频道入口。";
      return;
    }
    badge.textContent = summary.status;
    badge.className = "status-badge status-warning";
  }

  function renderDiscover() {
    const home = state.home;
    if (!home) {
      $("discoverState").innerHTML = "正在加载目录…";
      $("discoverGrid").innerHTML = createSkeletonCards(4);
      return;
    }
    renderDiscoverCategoryChips(home.categories || []);
    if (!state.discover.loaded && !state.discover.loading) loadDiscover();
    if (state.discover.loading) {
      $("discoverState").innerHTML = "正在加载发现页…";
      $("discoverGrid").innerHTML = createSkeletonCards(6);
      return;
    }
    const filtered = filterDiscoverItems();
    $("discoverState").innerHTML = filtered.length
      ? '共 ' + filtered.length + ' 条内容'
      : '没有匹配结果，试试更换关键词或分类。';
    if (filtered.length === 0) {
      $("discoverGrid").innerHTML = '<div class="inline-state">暂无匹配内容。</div>';
      return;
    }
    renderContentCards("discoverGrid", filtered, "discover");
  }

  function renderDiscoverCategoryChips(categories) {
    const host = $("discoverCategoryList");
    host.innerHTML = "";
    categories.forEach(function (cat) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip" + (state.discover.categoryId === cat.id ? " is-active" : "");
      btn.textContent = cat.name;
      btn.addEventListener("click", function () {
        state.discover.categoryId = cat.id;
        renderDiscover();
      });
      host.appendChild(btn);
    });
  }

  function filterDiscoverItems() {
    const keyword = String(state.discover.search || "").trim().toLowerCase();
    return (state.discover.items || []).filter(function (item) {
      const byCategory = state.discover.categoryId === "all" || item.categoryId === state.discover.categoryId;
      const byKeyword = !keyword || String(item.title || "").toLowerCase().includes(keyword) || String(item.description || "").toLowerCase().includes(keyword);
      return byCategory && byKeyword;
    });
  }

  function renderMembership() {
    const items = (state.home && state.home.contents ? state.home.contents : []).filter(function (item) {
      return item.accessType === "membership" || item.accessType === "package";
    });
    if (!state.home) {
      $("membershipGrid").innerHTML = createSkeletonCards(4);
      return;
    }
    if (!items.length) {
      $("membershipGrid").innerHTML = '<div class="inline-state">当前目录中还没有会员或内容包内容。</div>';
      return;
    }
    renderContentCards("membershipGrid", items, "membership");
  }

  function renderOrders() {
    const host = $("ordersList");
    if (state.orders.loading) {
      host.innerHTML = createSkeletonCards(3);
      return;
    }
    if (!state.orders.items.length) {
      host.innerHTML = '<div class="inline-state">当前没有符合筛选条件的订单。</div>';
      return;
    }
    host.innerHTML = "";
    state.orders.items.forEach(function (order) {
      const card = document.createElement("article");
      const statusClass = order.status === "paid" ? "" : (order.status === "pending" ? " status-warning" : " status-danger");
      card.className = "stack-card";
      card.innerHTML =
        '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(order.product && order.product.title ? order.product.title : order.orderNo) + '</div>' +
        '<div class="stack-subtitle">订单号 ' + escapeHtml(order.orderNo) + "</div></div>" +
        '<div class="status-badge' + statusClass + '">' + escapeHtml(order.status) + "</div></div>" +
        '<div class="stack-meta"><span>' + escapeHtml(formatPriceMinor(order.amountMinor, order.currency)) + '</span><span>' + escapeHtml(formatDate(order.createdAt)) + "</span></div>" +
        '<div class="channel-actions" style="margin-top:12px;"></div>';
      const actions = card.querySelector(".channel-actions");
      const detailBtn = document.createElement("button");
      detailBtn.type = "button";
      detailBtn.className = "ghost-button";
      detailBtn.textContent = "查看商品";
      detailBtn.addEventListener("click", function () {
        if (order.product && order.product.id) showInlineMessage("当前订单商品已绑定，可在首页/发现中继续查看。");
      });
      actions.appendChild(detailBtn);

      if (order.status === "pending" && !state.env.isTelegram && order.product && !isStarsProduct(order.product)) {
        const payBtn = document.createElement("button");
        payBtn.type = "button";
        payBtn.className = "primary-button";
        payBtn.textContent = "继续 USDT 支付";
        payBtn.addEventListener("click", function () {
          window.location.assign("./h5-pay.html?orderNo=" + encodeURIComponent(order.orderNo));
        });
        actions.appendChild(payBtn);
      }

      if (order.status === "paid") {
        const accessBtn = document.createElement("button");
        accessBtn.type = "button";
        accessBtn.className = "primary-button";
        accessBtn.textContent = "进入频道";
        accessBtn.addEventListener("click", function () {
          const first = (order.entitlements || [])[0];
          if (!first) {
            showInlineMessage("该订单还没有已激活权益，请稍后刷新重试。");
            return;
          }
          if (first.resourceType === "membership_channel") {
            const content = findFirstContentByType("membership");
            if (!content) {
              showInlineMessage("还没有可作为交付触发点的会员内容。");
              return;
            }
            openChannelAccess(content.id);
            return;
          }
          if (first.resourceType === "package") {
            const content = findFirstContentByPackage(first.resourceId);
            if (!content) {
              showInlineMessage("该内容包暂无可触发的已发布内容。");
              return;
            }
            openChannelAccess(content.id);
          }
        });
        actions.appendChild(accessBtn);
      }
      host.appendChild(card);
    });
    renderOrdersBadge();
  }

  function renderMe() {
    const session = state.session;
    $("profileTitle").textContent = session && session.identity === "telegram"
      ? (session.displayName || "已绑定 Telegram")
      : "访客模式";
    $("profileSubtitle").textContent = session && session.identity === "telegram"
      ? "已绑定 Telegram，可跨设备恢复订单与权益。"
      : "已自动保存本设备订单；绑定 Telegram 后可跨设备恢复权益。";
    $("logoutButton").classList.toggle("is-hidden", !(session && session.identity));

    if (!state.entitlements.loaded || state.entitlements.loading) {
      $("meEntitlementsList").innerHTML = createSkeletonCards(2);
      $("meMembershipText").textContent = "加载中";
      $("meMembershipHint").textContent = "正在读取权益摘要…";
    } else {
      const summary = state.entitlements.data && state.entitlements.data.summary ? state.entitlements.data.summary.membership : { status: "none", expiresAt: null };
      $("meMembershipText").textContent = summary.status === "active"
        ? (summary.expiresAt ? "有效至 " + formatDateShort(summary.expiresAt) : "已生效")
        : "未开通";
      $("meMembershipHint").textContent = summary.status === "active"
        ? "会员内容会在详情页直接展示进入频道入口。"
        : "完成购买后，会员/内容包/单条内容权益会显示在这里。";
      renderEntitlementCards();
    }

    $("meOrdersText").textContent = state.orders.items.length
      ? "共 " + state.orders.items.length + " 条"
      : "暂无订单";
    $("meOrdersHint").textContent = state.orders.items.some(function (item) { return item.status === "pending"; })
      ? "你有待支付订单，可前往订单页继续支付。"
      : "订单页会显示待支付、已支付与过期状态。";

    if (!state.channels.loaded || state.channels.loading) {
      $("meChannelsList").innerHTML = createSkeletonCards(2);
    } else {
      renderChannelCards();
    }
  }

  function renderEntitlementCards() {
    const host = $("meEntitlementsList");
    host.innerHTML = "";
    const data = state.entitlements.data;
    const all = []
      .concat(data.memberships || [])
      .concat(data.packages || [])
      .concat(data.contents || []);
    if (!all.length) {
      host.innerHTML = '<div class="inline-state">暂无权益记录。</div>';
      return;
    }
    all.slice(0, 8).forEach(function (item) {
      const metaTitle = item.meta && item.meta.title ? item.meta.title : (
        item.resourceType === "membership_channel" ? "VIP 会员频道" : item.resourceType
      );
      const card = document.createElement("article");
      const statusClass = item.status === "active" ? "" : " status-warning";
      card.className = "stack-card";
      card.innerHTML =
        '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(metaTitle) + '</div>' +
        '<div class="stack-subtitle">' + escapeHtml(item.resourceType) + "</div></div>" +
        '<div class="status-badge' + statusClass + '">' + escapeHtml(item.status) + "</div></div>" +
        '<div class="stack-meta"><span>开始 ' + escapeHtml(formatDate(item.startsAt)) + '</span><span>到期 ' + escapeHtml(item.expiresAt ? formatDate(item.expiresAt) : "永久") + "</span></div>";
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
        '<div class="status-badge' + (item.available ? "" : " status-warning") + '">' + (item.available ? "可进入" : "待配置") + "</div></div>" +
        '<div class="channel-actions" style="margin-top:12px;"></div>';
      const actions = card.querySelector(".channel-actions");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = item.available ? "primary-button" : "ghost-button";
      btn.textContent = item.accessMode === "public_link" ? "打开频道" : "进入频道";
      btn.disabled = !item.available;
      btn.addEventListener("click", function () {
        if (item.link) {
          if (tg && tg.openTelegramLink) tg.openTelegramLink(item.link);
          else window.open(item.link, "_blank", "noopener");
          return;
        }
        if (item.resourceId) openChannelAccess(item.resourceId);
      });
      actions.appendChild(btn);
      if (!item.available && item.reason) {
        const note = document.createElement("div");
        note.className = "stack-note";
        note.textContent = item.reason;
        card.appendChild(note);
      }
      host.appendChild(card);
    });
  }

  async function renderDetail(id) {
    if (!id) {
      $("detailContent").innerHTML = '<div class="empty-state">内容 ID 缺失。</div>';
      return;
    }
    if (state.detailLoading) {
      $("detailContent").innerHTML = createSkeletonCards(1);
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
    updatePageSeo(detail.effectiveSeo || { title: detail.title, description: detail.description, keywords: [] });
    updateOgImage(detail.coverUrl || "");
    updateJsonLd(detail.videoObjectJsonLd || null);
    const coverClass = detail.coverUrl ? "detail-cover has-image" : "detail-cover";
    const priceText = detail.product ? formatPriceMinor(detail.product.priceMinor, detail.product.currency) : "未配置商品";
    $("detailContent").innerHTML =
      '<div class="' + coverClass + '"' + (detail.coverUrl ? ' style="background-image:url(\'' + String(detail.coverUrl).replace(/'/g, "%27") + '\')"' : "") + '></div>' +
      '<div class="detail-copy">' +
      '<p class="eyebrow">' + escapeHtml((detail.tags || []).join(" · ") || detail.accessType || "DETAIL") + '</p>' +
      '<h2>' + escapeHtml(detail.title || "") + '</h2>' +
      '<div class="detail-meta"><span>' + escapeHtml(detail.duration || "—") + '</span><span>' + escapeHtml(priceText) + '</span><span>' + escapeHtml(detail.ownedBy || detail.accessType || "") + '</span></div>' +
      '<div class="detail-description">' + escapeHtml(detail.description || "暂无内容介绍。") + '</div>' +
      '<div class="detail-actions"></div>' +
      "</div>";
    const actions = $("detailContent").querySelector(".detail-actions");
    if (detail.unlocked) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "primary-button";
      btn.textContent = "进入频道观看";
      btn.addEventListener("click", function () {
        openChannelAccess(detail.id);
      });
      actions.appendChild(btn);
    } else if (detail.product) {
      const buyBtn = document.createElement("button");
      buyBtn.type = "button";
      buyBtn.className = "primary-button";
      buyBtn.textContent = state.env.isTelegram && isStarsProduct(detail.product) ? "使用 Stars 解锁" : "去支付";
      buyBtn.addEventListener("click", function () {
        startPurchase(detail);
      });
      actions.appendChild(buyBtn);
    }
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "ghost-button";
    backBtn.textContent = "返回";
    backBtn.addEventListener("click", function () {
      setHashForTab(state.route.fromTab || "home");
    });
    actions.appendChild(backBtn);
  }

  function renderContentCards(hostId, items, fromTab) {
    const host = $(hostId);
    host.innerHTML = "";
    const tpl = $("contentCardTemplate");
    items.forEach(function (item) {
      const node = tpl.content.cloneNode(true);
      const cover = node.querySelector(".card-cover");
      if (item.coverUrl) {
        cover.style.backgroundImage = "linear-gradient(135deg, rgba(166,107,255,0.24), rgba(38,34,54,0.62)), url('" + String(item.coverUrl).replace(/'/g, "%27") + "')";
        cover.style.backgroundSize = "cover";
        cover.style.backgroundPosition = "center";
      }
      node.querySelector(".cover-duration").textContent = item.duration || "—";
      node.querySelector(".card-tag").textContent = (item.tags || []).join(" · ") || item.accessType || "";
      node.querySelector(".card-title").textContent = item.title || "未命名内容";
      node.querySelector(".card-desc").textContent = item.description || "暂无描述";
      node.querySelector(".card-price").textContent = item.priceMinor ? formatPriceMinor(item.priceMinor, item.priceCurrency) : "免费";
      node.querySelector(".card-access").textContent = item.unlocked ? "已解锁" : (item.accessType || "待解锁");
      node.querySelector(".cover-button").addEventListener("click", function () {
        setHashForDetail(item.id, fromTab);
      });
      const action = node.querySelector(".card-action");
      action.textContent = item.unlocked ? "查看详情" : "查看并解锁";
      action.addEventListener("click", function () {
        setHashForDetail(item.id, fromTab);
      });
      host.appendChild(node);
    });
  }

  function renderSessionChip() {
    const session = state.session;
    const text = $("sessionChipText");
    const icon = $("sessionChipIcon");
    if (!session) {
      icon.textContent = "…";
      text.textContent = "建立会话中";
      return;
    }
    if (session.identity === "telegram") {
      icon.textContent = (session.displayName || "T").slice(0, 1);
      text.textContent = session.displayName || "已绑定 Telegram";
      return;
    }
    icon.textContent = "访";
    text.textContent = "访客模式";
  }

  async function bootstrapSession() {
    state.booting = true;
    clearBootError();
    renderSessionChip();
    let session = null;

    if (state.env.isTelegram && state.env.hasInitData) {
      try {
        const payload = await apiCall("/api/telegram/session", {
          method: "POST",
          body: JSON.stringify({ initData: tg.initData, botKey: getLaunchBotKey() }),
        });
        session = {
          identity: "telegram",
          displayName: payload.user && (payload.user.first_name || payload.user.username) ? (payload.user.first_name || payload.user.username) : "Telegram 用户",
          telegramBound: true,
          userId: payload.user && payload.user.id ? String(payload.user.id) : null,
        };
      } catch (_) {
      }
    }

    if (!session) {
      try {
        session = await apiCall("/api/auth/h5/session");
      } catch (err) {
        if (err.status === 401) {
          try {
            session = await apiCall("/api/auth/h5/guest-session", {
              method: "POST",
              body: JSON.stringify({}),
            });
          } catch (guestErr) {
            showBootError("暂时无法建立会话", apiText(guestErr));
            state.booting = false;
            return false;
          }
        } else {
          showBootError("暂时无法建立会话", apiText(err));
          state.booting = false;
          return false;
        }
      }
    }

    state.session = session;
    renderSessionChip();
    state.booting = false;
    return true;
  }

  async function bootstrapApp() {
    if (state.booting) return;
    const sessionOk = await bootstrapSession();
    if (!sessionOk) return;
    await loadHome();
    routeTo(parseHash());
  }

  async function loadHome() {
    try {
      state.home = await apiCall("/api/home");
      renderHome();
      renderDiscover();
      renderMembership();
    } catch (err) {
      showBootError("目录加载失败", apiText(err));
    }
  }

  async function loadDiscover() {
    if (state.discover.loading) return;
    state.discover.loading = true;
    renderDiscover();
    try {
      const params = new URLSearchParams({
        page: "1",
        pageSize: "50",
        sort: "newest",
      });
      const data = await apiCall("/api/contents?" + params.toString());
      state.discover.items = (data && data.items) || [];
      state.discover.pagination = data && data.pagination ? data.pagination : null;
      state.discover.loaded = true;
    } catch (err) {
      $("discoverState").innerHTML = "发现页加载失败：" + escapeHtml(apiText(err));
    } finally {
      state.discover.loading = false;
      renderDiscover();
    }
  }

  async function loadOrders() {
    if (state.orders.loading) return;
    state.orders.loading = true;
    renderOrders();
    try {
      const params = new URLSearchParams({
        page: "1",
        pageSize: "50",
      });
      if (state.orders.status) params.set("status", state.orders.status);
      const data = await apiCall("/api/user/orders?" + params.toString());
      state.orders.items = data.items || [];
      state.orders.pagination = data.pagination || null;
    } catch (err) {
      $("ordersList").innerHTML = '<div class="inline-state">订单加载失败：' + escapeHtml(apiText(err)) + "</div>";
    } finally {
      state.orders.loading = false;
      renderOrders();
      renderMe();
    }
  }

  async function loadEntitlements() {
    if (state.entitlements.loading) return;
    state.entitlements.loading = true;
    renderMe();
    try {
      state.entitlements.data = await apiCall("/api/user/entitlements");
      state.entitlements.loaded = true;
    } catch (err) {
      $("meEntitlementsList").innerHTML = '<div class="inline-state">权益加载失败：' + escapeHtml(apiText(err)) + "</div>";
    } finally {
      state.entitlements.loading = false;
      renderMembershipBadge();
      renderMe();
    }
  }

  async function loadChannels() {
    if (state.channels.loading) return;
    state.channels.loading = true;
    renderMe();
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

  function showInlineMessage(message) {
    if (tg && tg.showPopup) {
      tg.showPopup({ title: "提示", message: message, buttons: [{ type: "ok" }] }).catch(function () {});
      return;
    }
    window.alert(message);
  }

  function handleBannerAction(banner) {
    if (banner.targetType === "content" && banner.targetId) {
      setHashForDetail(banner.targetId, "home");
      return;
    }
    if (banner.targetType === "category" && banner.targetId) {
      state.discover.categoryId = banner.targetId;
      setHashForTab("discover");
      return;
    }
    if (banner.externalUrl || banner.targetId) {
      const url = banner.externalUrl || banner.targetId;
      if (/^https:\/\/t\.me\//.test(url) && tg && tg.openTelegramLink) tg.openTelegramLink(url);
      else window.open(url, "_blank", "noopener");
    }
  }

  function findFirstContentByType(type) {
    return (state.home && state.home.contents ? state.home.contents : []).find(function (item) { return item.accessType === type; }) || null;
  }

  function findFirstContentByPackage(packageId) {
    return Object.keys(state.detailCache).map(function (id) { return state.detailCache[id]; }).find(function (detail) {
      return detail && detail.package && detail.package.id === packageId;
    }) || null;
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
    if (!isStarsProduct(detail.product)) {
      window.location.assign("./h5-pay.html?productId=" + encodeURIComponent(detail.product.id));
      return;
    }
    showInlineMessage("当前商品仅支持 Telegram Stars。请在 Telegram Mini App 内打开后支付。");
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
      showInlineMessage("Stars 支付已提交，请在订单页确认状态。");
    });
  }

  function renderOrdersBadge() {
    const pending = state.orders.items.filter(function (item) { return item.status === "pending"; }).length;
    const badge = $("ordersBadge");
    if (!pending) {
      badge.classList.add("is-hidden");
      return;
    }
    badge.classList.remove("is-hidden");
    badge.textContent = pending > 99 ? "99+" : String(pending);
  }

  function bindEvents() {
    $("retryBootstrapButton").addEventListener("click", function () {
      bootstrapApp();
    });
    $("backButton").addEventListener("click", function () {
      setHashForTab(state.route.fromTab || "home");
    });
    $("homePrimaryAction").addEventListener("click", function () {
      setHashForTab("discover");
    });
    $("homeSecondaryAction").addEventListener("click", function () {
      setHashForTab("me");
    });
    $("jumpDiscoverButton").addEventListener("click", function () {
      setHashForTab("discover");
    });
    $("sessionChip").addEventListener("click", function () {
      setHashForTab("me");
    });
    $("bindTelegramButton").addEventListener("click", function () {
      const redirect = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
      window.location.assign("/login.html?redirect=" + redirect);
    });
    $("logoutButton").addEventListener("click", async function () {
      try {
        await apiCall("/api/auth/h5/logout", {
          method: "POST",
          body: JSON.stringify({}),
        });
      } catch (_) {
      }
      window.location.reload();
    });
    $("discoverSearchInput").addEventListener("input", function (evt) {
      state.discover.search = evt.target.value || "";
      renderDiscover();
    });
    $("ordersStatusSegment").querySelectorAll(".segment-button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        $("ordersStatusSegment").querySelectorAll(".segment-button").forEach(function (node) {
          node.classList.remove("is-active");
        });
        btn.classList.add("is-active");
        state.orders.status = btn.getAttribute("data-status") || "";
        loadOrders();
      });
    });
    document.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setHashForTab(btn.getAttribute("data-tab"));
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
    renderHome();
    renderDiscover();
    renderMembership();
    renderOrders();
    renderMe();
    if (!window.location.hash) setHashForTab("home");
    else routeTo(parseHash());
    bootstrapApp();
  });
})();
