/*
 * Mini App（Telegram WebView） - 原生 HTML/JS，hash 路由 4 视图：
 *   home (默认) ｜ orders （我的订单）｜ entitlements（我的权益）｜ content/:id（内容详情 + 购买/解锁 CTA）
 * 身份由服务端 session 校验；权限必须由后端 unlocked 字段决定，前端只渲染。
 */

(function () {
  "use strict";

  const telegram = window.Telegram?.WebApp;

  /** @typedef {'home'|'content'|'orders'|'entitlements'} ViewName */

  const state = {
    user: null,
    /** @type {'checking'|'active'|'expired'|'none'} */
    access: "checking",
    videos: [],
    banners: [],
    categories: [],
    activeCategory: "all",
    orderPage: { page: 1, pageSize: 20, status: "", total: 0, items: [], loaded: false },
    view: /** @type {ViewName} */ ("home"),
    viewParams: /** @type {Record<string,string>} */ ({}),
  };

  /* ================= 工具函数 ================= */

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#039;",
      '"': "&quot;",
    }[ch]));
  }

  function formatDate(iso, withTime = true) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (!withTime) return base;
    return `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatDurationSeconds(sec = 0) {
    const s = Number(sec) || 0;
    if (s <= 0) return "-";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  }

  function copyText(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (_) {
      return false;
    }
  }

  function showAlert(msg) {
    if (telegram?.showAlert) telegram.showAlert(msg);
    else window.alert(msg);
  }

  function showToast(msg) {
    if (telegram?.showPopup) {
      telegram.showPopup({ title: "提示", message: msg, buttons: [{ type: "ok" }] }).catch(() => {});
      return;
    }
    showAlert(msg);
  }

  function apiCall(url, options = {}) {
    return fetch(url, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }).then(async (res) => {
      let payload = null;
      try { payload = await res.json(); } catch (_) { payload = null; }
      if (!res.ok) {
        const message = payload?.message || payload?.error || `HTTP ${res.status}`;
        const err = new Error(message);
        err.status = res.status;
        err.payload = payload;
        throw err;
      }
      return payload;
    });
  }

  function getLaunchBotKey() {
    const value = telegram?.initDataUnsafe?.start_param;
    return /^[a-z0-9_-]{1,32}$/i.test(value || "") ? value : undefined;
  }

  /* ================= hash 路由 ================= */

  function parseHash() {
    const raw = (location.hash || "").replace(/^#/, "");
    const params = new URLSearchParams(raw);
    const view = params.get("view");
    const id = params.get("id");
    /** @type {ViewName} */
    let v = "home";
    if (view === "orders") v = "orders";
    else if (view === "entitlements") v = "entitlements";
    else if (view === "content" && id) v = "content";
    return { view: v, id: id || "", params };
  }

  function setHashView(view, extra = {}) {
    const params = new URLSearchParams({ view, ...extra });
    location.hash = params.toString();
  }

  function syncViewFromHash() {
    const parsed = parseHash();
    state.view = parsed.view;
    state.viewParams = parsed.params;
    const titleMap = {
      home: "同频点播",
      content: "内容详情",
      orders: "我的订单",
      entitlements: "我的权益",
    };
    document.getElementById("pageTitle").textContent = titleMap[state.view] || "同频点播";
    const backBtn = document.getElementById("backButton");
    if (state.view === "home") {
      backBtn.style.display = "none";
    } else {
      backBtn.style.display = "inline-flex";
    }
    const sections = {
      home: document.getElementById("homeView"),
      content: document.getElementById("contentDetailView"),
      orders: document.getElementById("ordersView"),
      entitlements: document.getElementById("entitlementsView"),
    };
    Object.entries(sections).forEach(([k, el]) => {
      el.classList.toggle("is-hidden", k !== state.view);
    });
    if (state.view === "content") renderContentDetail(parsed.id);
    if (state.view === "orders") loadUserOrders(true);
    if (state.view === "entitlements") loadUserEntitlements();
    window.scrollTo({ top: 0, behavior: state.view === "home" ? "instant" : "smooth" });
  }

  /* ================= 启动与鉴权 ================= */

  function initTelegram() {
    if (!telegram) return;
    try { telegram.ready(); } catch (_) {}
    try { telegram.expand(); } catch (_) {}
    try { telegram.setHeaderColor?.("#13111c"); } catch (_) {}
    try { telegram.setBackgroundColor?.("#13111c"); } catch (_) {}
    state.user = telegram.initDataUnsafe?.user || null;
  }

  async function loadAccess() {
    renderStatus("checking");
    let hasSession = false;
    try {
      if (!telegram?.initData) throw new Error("Telegram context unavailable");
      const payload = await apiCall("/api/telegram/session", {
        method: "POST",
        body: JSON.stringify({ initData: telegram.initData, botKey: getLaunchBotKey() }),
      });
      state.user = payload.user;
      state.access = payload.access?.membership || payload.access || "none";
      hasSession = true;
    } catch (_) {
      state.access = "none";
    }
    try {
      if (!hasSession) throw new Error("no session");
      const home = await apiCall("/api/home");
      state.banners = home.banners || [];
      state.categories = home.categories || [];
      state.videos = home.contents || home.videos || [];
    } catch (_) {
      state.videos = demoVideos();
      state.banners = demoHome().banners;
      state.categories = demoHome().categories;
    }
    renderProfileInitial();
    render();
  }

  /* ================= demo 数据（无网络时用） ================= */

  function demoVideos() {
    return [
      { id: "welcome", title: "同频 · 新成员导览", tag: "START HERE", duration: "03:20", description: "认识社区边界、内容规则与成员权益。", accessType: "public", unlocked: true, categoryId: "guide" },
      { id: "topic-01", title: "主题内容 · 第一辑", tag: "MEMBERS ONLY", duration: "18:42", description: "已授权的精选内容；完整访问需拥有对应会员权益。", accessType: "membership", unlocked: false, categoryId: "featured" },
      { id: "topic-02", title: "创作者访谈 · 真实表达", tag: "MEMBERS ONLY", duration: "24:10", description: "围绕理解、尊重与个人边界展开的对话。", accessType: "membership", unlocked: false, categoryId: "interview" },
      { id: "topic-03", title: "主题内容 · 第二辑", tag: "CONTENT PACK", duration: "16:35", description: "加入内容包后可持续查看同主题更新。", accessType: "package", unlocked: false, categoryId: "featured" },
    ];
  }
  function demoHome() {
    return {
      banners: [
        { eyebrow: "PUBLIC PREVIEW", title: "关注同频公开频道", description: "获取最新预告、公开样本与平台通知。", actionLabel: "前往频道", targetType: "external", targetId: "https://t.me/InTune_bdsm" },
      ],
      categories: [
        { id: "all", name: "全部" },
        { id: "featured", name: "精选" },
        { id: "guide", name: "导览" },
        { id: "interview", name: "访谈" },
      ],
    };
  }

  /* ================= 渲染：状态 + 顶部 ================= */

  function renderStatus(access = state.access) {
    const statusEl = document.getElementById("membershipStatus");
    const hintEl = document.getElementById("membershipHint");
    const labels = {
      checking: ["正在核验…", "正在确认账户与订单状态"],
      active: ["会员有效", "你已拥有会员内容访问权益"],
      expired: ["会员已到期", "续费完成后将恢复会员内容访问"],
      none: ["尚未开通会员", "可浏览目录；会员内容需完成有效订单后访问"],
    };
    const [s, h] = labels[access] || labels.none;
    statusEl.textContent = s;
    hintEl.textContent = h;
  }

  function renderProfileInitial() {
    const initial = state.user?.first_name?.slice(0, 1) || "访";
    document.getElementById("profileInitial").textContent = initial;
  }

  /* ================= 渲染：首页 ================= */

  function renderHome() {
    renderStatus();
    renderBanners();
    renderCategories();
    renderVideoList();
  }

  function renderBanners() {
    const list = document.getElementById("bannerList");
    list.replaceChildren();
    state.banners.forEach((banner, index) => {
      const el = document.createElement("article");
      el.className = "banner";
      el.style.background = index % 2 ? "linear-gradient(120deg, #1d5960, #202639 65%, #af7764)" : "linear-gradient(120deg, #632d73, #222438 65%, #ba7269)";
      const actionLabel = escapeHtml(banner.actionLabel || "查看");
      el.innerHTML =
        `<span class="eyebrow">${escapeHtml(banner.eyebrow || "")}</span>` +
        `<strong>${escapeHtml(banner.title || "")}</strong>` +
        `<p>${escapeHtml(banner.description || "")}</p>` +
        `<button type="button">${actionLabel}</button>`;
      el.querySelector("button").addEventListener("click", () => handleBannerClick(banner));
      list.appendChild(el);
    });
  }

  function handleBannerClick(banner) {
    const externalUrl = banner.externalUrl || banner.targetId;
    if ((banner.targetType === "external" || banner.targetType === "external_link") && /^https:\/\/t\.me\//.test(externalUrl)) {
      telegram?.openTelegramLink ? telegram.openTelegramLink(externalUrl) : window.open(externalUrl, "_blank", "noopener");
      return;
    }
    if (banner.targetType === "category") {
      state.activeCategory = banner.targetId || "all";
      renderVideoList();
      document.getElementById("sectionTitle")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const target = document.querySelector(`[data-video-id="${banner.targetId}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderCategories() {
    const list = document.getElementById("categoryList");
    list.replaceChildren();
    state.categories.forEach((cat) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `category ${state.activeCategory === cat.id ? "active" : ""}`;
      btn.textContent = cat.name;
      btn.addEventListener("click", () => {
        state.activeCategory = cat.id;
        renderCategories();
        renderVideoList();
      });
      list.appendChild(btn);
    });
  }

  function renderVideoList() {
    const visible = state.activeCategory === "all"
      ? state.videos
      : state.activeCategory === "featured"
        ? state.videos.filter((v) => v.isFeatured || v.categoryId === "featured")
        : state.videos.filter((v) => v.categoryId === state.activeCategory);
    const titleEl = document.getElementById("sectionTitle");
    const countEl = document.getElementById("contentCount");
    const catName = state.categories.find((c) => c.id === state.activeCategory)?.name || "精选内容";
    titleEl.textContent = state.activeCategory === "all" ? "推荐内容" : catName;
    countEl.textContent = `${visible.length} 项`;

    const list = document.getElementById("videoList");
    const tpl = document.getElementById("videoTemplate");
    list.replaceChildren();
    visible.forEach((video, index) => {
      const f = tpl.content.cloneNode(true);
      const card = f.querySelector(".video-card");
      card.dataset.videoId = video.id;
      const cover = f.querySelector(".cover");
      const fallback = index % 2
        ? "linear-gradient(145deg, #23495d, #17232d 57%, #7a5c6d)"
        : "linear-gradient(145deg, #582667, #241834 55%, #b27066)";
      cover.style.background = video.coverUrl
        ? `center / cover no-repeat url("${String(video.coverUrl).replace(/[\"\\]/g, "")}"), ${fallback}`
        : fallback;
      f.querySelector(".duration").textContent = video.duration || "-";
      f.querySelector(".tag").textContent = video.tag || "";
      f.querySelector("h3").textContent = video.title;
      f.querySelector(".description").textContent = video.description || "";
      const btn = f.querySelector(".open-button");
      const owned = video.unlocked === true || (video.unlocked === undefined && (video.accessType === "public" || state.access === "active"));
      btn.textContent = owned ? "打开详情" : "查看详情并解锁";
      btn.disabled = false;
      btn.addEventListener("click", () => setHashView("content", { id: video.id }));
      list.appendChild(f);
    });
  }

  /* ================= 内容详情 ================= */

  async function renderContentDetail(id) {
    const host = document.getElementById("contentDetail");
    host.innerHTML = `<div class="empty-hint"><h4>正在加载内容…</h4></div>`;
    if (!id) {
      host.innerHTML = `<div class="empty-hint"><h4>内容 ID 缺失</h4><p>返回首页重新选择。</p></div>`;
      return;
    }
    let detail = null;
    try {
      detail = await apiCall(`/api/contents/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.status === 404) {
        host.innerHTML = `<div class="empty-hint"><h4>内容不存在或已下架</h4><p>返回首页重新选择。</p></div>`;
      } else if (err.status === 403) {
        host.innerHTML = `<div class="empty-hint"><h4>内容未上架</h4><p>${escapeHtml(err.payload?.message || err.message)}</p></div>`;
      } else {
        host.innerHTML = `<div class="empty-hint"><h4>加载失败</h4><p>${escapeHtml(err.message || "请刷新重试")}</p></div>`;
      }
      return;
    }
    renderContentDetailCard(detail);
  }

  function renderContentDetailCard(d) {
    const host = document.getElementById("contentDetail");
    host.replaceChildren();

    const cover = document.createElement("div");
    cover.className = "detail-cover";
    if (d.coverUrl) {
      cover.style.backgroundImage = `url("${String(d.coverUrl).replace(/[\"\\]/g, "")}")`;
      cover.style.backgroundSize = "cover";
      cover.style.backgroundPosition = "center";
    }
    const durationChip = document.createElement("span");
    durationChip.className = "duration-chip";
    durationChip.textContent = d.duration || "—";
    cover.appendChild(durationChip);
    host.appendChild(cover);

    const tags = document.createElement("div");
    tags.className = "detail-tags";
    const typeMap = { public: { label: "免费内容", cls: "green" }, single: "单条内容", package: "内容包", membership: { label: "会员专属", cls: "purple" } };
    const t = d.accessType;
    const typeTag = typeMap[t];
    if (typeTag) {
      const typeChip = document.createElement("span");
      typeChip.className = "chip " + (typeof typeTag === "string" ? "" : typeTag.cls);
      typeChip.textContent = typeof typeTag === "string" ? typeTag : typeTag.label;
      tags.appendChild(typeChip);
    }
    (d.tags || []).forEach((tName) => {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = tName;
      tags.appendChild(c);
    });
    if (d.unlocked) {
      const okTag = document.createElement("span");
      okTag.className = "chip green";
      okTag.textContent = "已解锁";
      tags.appendChild(okTag);
    }
    host.appendChild(tags);

    const title = document.createElement("h2");
    title.className = "detail-title";
    title.textContent = d.title;
    host.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "detail-meta";
    const items = [];
    if (d.duration) items.push(`时长 ${d.duration}`);
    if (d.categories && d.categories.length) items.push(d.categories.map((c) => c.name).join(" · "));
    if (d.publishedAt) items.push(`更新于 ${formatDate(d.publishedAt, false)}`);
    if (d.product) {
      const priceStars = (Number(d.product.priceMinor || 0) / 1_000_000_000).toFixed(6);
      items.push(`${priceStars} Stars (${d.product.currency})`);
      if (d.product.durationDays) items.push(`会员 ${d.product.durationDays} 天`);
    }
    items.forEach((it) => {
      const s = document.createElement("span");
      s.textContent = it;
      meta.appendChild(s);
    });
    host.appendChild(meta);

    if (d.description) {
      const desc = document.createElement("div");
      desc.className = "detail-description";
      desc.textContent = d.description;
      host.appendChild(desc);
    }

    const footer = document.createElement("div");
    footer.className = "detail-footer";
    const cta = document.createElement("button");
    cta.className = "detail-cta" + (d.unlocked ? "" : " locked");
    const sub = document.createElement("div");
    sub.className = "detail-cta-sub";

    if (d.unlocked) {
      cta.textContent = "前往频道观看 / 获取观看链接";
      cta.addEventListener("click", () => requestChannelLink(d.id));
      const ownedLabel = d.ownedBy === "single" ? "你已单独购买此内容" :
        d.ownedBy === "package" ? "你已购买所属内容包" :
        d.ownedBy === "membership" ? "当前会员已包含此内容" : "此内容可直接查看";
      sub.textContent = `${ownedLabel} · 点击进入收费频道/预览频道`;
    } else {
      if (d.accessType === "public") {
        cta.textContent = "此内容免费开放（无需解锁）";
        cta.disabled = true;
        sub.textContent = "未登录状态下的占位；请重新在 Telegram 中打开。";
      } else if (d.product && d.product.id) {
        const priceStars = (Number(d.product.priceMinor || 0) / 1_000_000_000).toFixed(6);
        const label = d.accessType === "membership" ? `购买会员 · ${d.product.durationDays || 30} 天` :
          d.accessType === "package" ? "购买内容包" : "购买本条内容";
        cta.textContent = `${label} · ≈ ${priceStars} Stars`;
        cta.addEventListener("click", () => openCreateOrderDialog(d));
        sub.textContent = "点击创建订单 → 把订单号发给客服/运营 → 到账确认后权益立即生效（含会员频道邀请）";
      } else {
        cta.textContent = "当前内容暂未上架购买";
        cta.disabled = true;
        sub.textContent = "如有需要，联系同频运营单独开通。";
      }
    }
    footer.appendChild(cta);
    footer.appendChild(sub);
    host.appendChild(footer);
  }

  async function requestChannelLink(videoId) {
    try {
      const res = await apiCall(`/api/resources/${encodeURIComponent(videoId)}/access-link`, { method: "POST" });
      const url = res?.url;
      if (!url || !/^https:\/\/t\.me\//.test(url)) throw new Error("invalid channel link");
      telegram?.openTelegramLink ? telegram.openTelegramLink(url) : window.open(url, "_blank", "noopener");
    } catch (err) {
      showAlert("当前无法取得访问链接：" + (err?.payload?.message || err?.message || "请稍后重试或联系支持。"));
    }
  }

  /* ================= 创建订单（内容详情 CTA） ================= */

  function openCreateOrderDialog(detail) {
    const dlg = document.getElementById("createOrderDialog");
    document.getElementById("coTitle").textContent =
      detail.accessType === "membership" ? "购买会员 · 创建订单" :
      detail.accessType === "package" ? "购买内容包 · 创建订单" : "购买内容 · 创建订单";

    const preview = document.getElementById("coPreview");
    const rows = [
      ["内容", detail.title],
    ];
    if (detail.product) {
      const priceStars = (Number(detail.product.priceMinor || 0) / 1_000_000_000).toFixed(6);
      rows.push(["价格", `${detail.product.priceMinor} ${detail.product.currency} (≈ ${priceStars} Stars)`]);
      if (detail.product.durationDays) rows.push(["时长", `${detail.product.durationDays} 天`]);
    } else {
      rows.push(["价格", "暂未配置"]);
    }
    preview.innerHTML = rows.map(([k, v]) =>
      `<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`
    ).join("");

    const orderNoBox = document.getElementById("coOrderNo");
    orderNoBox.style.display = "none";
    orderNoBox.innerHTML = "";

    const confirmBtn = document.getElementById("coConfirm");
    confirmBtn.disabled = false;
    confirmBtn.textContent = "创建订单并生成订单号";

    confirmBtn.onclick = async () => {
      if (!detail.product?.id) {
        showAlert("该内容暂未配置商品，无法创建订单。");
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = "正在创建订单…";
      try {
        const created = await apiCall("/api/orders", {
          method: "POST",
          body: JSON.stringify({ productId: detail.product.id }),
        });
        orderNoBox.style.display = "flex";
        const label = document.createElement("div");
        label.className = "label";
        label.textContent = "你的订单号（长按 / 复制，发给客服或运营）";
        const valueEl = document.createElement("div");
        valueEl.className = "value";
        valueEl.textContent = created.orderNo;
        valueEl.style.cursor = "copy";
        valueEl.title = "点击复制";
        valueEl.addEventListener("click", () => {
          if (copyText(created.orderNo)) showToast("订单号已复制，可粘贴给客服。");
        });
        const sub = document.createElement("div");
        sub.className = "sub";
        sub.textContent = `创建时间 ${formatDate(created.createdAt)} · 当前状态：待支付`;
        orderNoBox.append(label, valueEl, sub);
        confirmBtn.textContent = "创建成功 · 已保存到「我的订单」";
      } catch (err) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "创建订单并生成订单号";
        const message = err?.payload?.message || err?.payload?.error || err?.message || "创建失败";
        showAlert("创建订单失败：" + message);
      }
    };

    try { dlg.showModal(); } catch (_) {}
  }

  /* ================= 我的订单 ================= */

  function initOrdersToolbar() {
    const seg = document.getElementById("ordersStatusSegment");
    seg.querySelectorAll(".seg-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        seg.querySelectorAll(".seg-item").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.orderPage.status = btn.dataset.status || "";
        loadUserOrders(true);
      });
    });
    document.getElementById("loadMoreOrdersButton").addEventListener("click", () => loadUserOrders(false));
  }

  async function loadUserOrders(reset) {
    const list = document.getElementById("ordersList");
    if (reset) {
      state.orderPage.page = 1;
      state.orderPage.items = [];
      state.orderPage.loaded = false;
      list.replaceChildren();
      list.innerHTML = `<div class="empty-hint"><h4>加载中…</h4></div>`;
    }
    const qs = new URLSearchParams({
      page: String(state.orderPage.page),
      pageSize: String(state.orderPage.pageSize),
    });
    if (state.orderPage.status) qs.set("status", state.orderPage.status);
    try {
      const data = await apiCall(`/api/user/orders?${qs.toString()}`);
      state.orderPage.total = data.pagination.total;
      const nextItems = reset ? data.items : state.orderPage.items.concat(data.items);
      state.orderPage.items = nextItems;
      state.orderPage.page = data.pagination.page + 1;
      state.orderPage.loaded = nextItems.length >= data.pagination.total;
      renderOrders(nextItems);
      const loadMoreBtn = document.getElementById("loadMoreOrdersButton");
      loadMoreBtn.style.display = state.orderPage.loaded || data.items.length === 0 ? "none" : "inline-block";
    } catch (err) {
      const msg = err?.status === 401 ? "请先在 Telegram Mini App 内完成登录" : (err?.payload?.message || err?.message || "加载失败");
      if (reset) {
        list.innerHTML = `<div class="empty-hint"><h4>订单加载失败</h4><p>${escapeHtml(msg)}</p></div>`;
      } else {
        showAlert("加载更多失败：" + msg);
      }
    }
  }

  function renderOrders(items) {
    const list = document.getElementById("ordersList");
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-hint";
      empty.innerHTML =
        `<h4>暂无订单记录</h4>` +
        `<p>先在内容详情页创建订单，或联系客服/运营协助下单。</p>` +
        `<div style="margin-top:14px"><button class="cta-button cta-primary" id="goHomeFromOrders">回到首页浏览内容</button></div>`;
      list.appendChild(empty);
      document.getElementById("goHomeFromOrders")?.addEventListener("click", () => setHashView("home"));
      return;
    }
    const tpl = document.getElementById("orderTemplate");
    items.forEach((o) => list.appendChild(renderOrderCard(o, tpl)));
  }

  function renderOrderCard(o, tpl) {
    const f = tpl.content.cloneNode(true);
    const product = o.product;
    f.querySelector(".order-no").textContent = o.orderNo;

    const status = f.querySelector(".order-status");
    status.className = "order-status status-" + o.status;
    const statusLabel = {
      pending: "待支付",
      processing: "处理中",
      paid: "已支付",
      failed: "失败",
      refunded: "已退款",
      cancelled: "已取消",
      expired: "已过期",
    }[o.status] || o.status;
    status.textContent = statusLabel;

    const cover = f.querySelector(".order-cover");
    const covers = [
      "linear-gradient(145deg, #582667, #241834 55%, #b27066)",
      "linear-gradient(145deg, #23495d, #17232d 57%, #7a5c6d)",
      "linear-gradient(145deg, #1d5960, #202639 65%, #af7764)",
      "linear-gradient(145deg, #632d73, #222438 65%, #ba7269)",
    ];
    cover.style.background = covers[Math.abs(hashStr(o.orderNo)) % covers.length];

    f.querySelector(".product-title").textContent = product?.title || "未命名商品";
    const metaBits = [];
    if (product?.type) metaBits.push({ single: "单条内容", package: "内容包", membership: "会员" }[product.type] || product.type);
    if (product?.durationDays) metaBits.push(`${product.durationDays} 天`);
    const ent = o.entitlements && o.entitlements[0];
    if (ent && ent.expiresAt) metaBits.push(`权益至 ${formatDate(ent.expiresAt, false)}`);
    f.querySelector(".product-meta").textContent = metaBits.join(" · ");

    const priceStars = (Number(o.amountMinor || 0) / 1_000_000_000).toFixed(6);
    f.querySelector(".amount").textContent = o.amountMinor || "0";
    f.querySelector(".amount-sub").textContent = `${o.currency || "XTR"} · ≈ ${priceStars} Stars`;

    const dateBits = [`创建 ${formatDate(o.createdAt)}`];
    if (o.paidAt) dateBits.push(`到账 ${formatDate(o.paidAt)}`);
    f.querySelector(".order-time").textContent = dateBits.join(" ｜ ");

    const ctaHost = f.querySelector(".order-cta");
    ctaHost.innerHTML = "";
    const copyOrderBtn = document.createElement("button");
    copyOrderBtn.type = "button";
    copyOrderBtn.className = "cta-button cta-ghost";
    copyOrderBtn.textContent = "复制订单号";
    copyOrderBtn.addEventListener("click", () => {
      if (copyText(o.orderNo)) showToast(`已复制订单号 ${o.orderNo}`);
    });
    ctaHost.appendChild(copyOrderBtn);
    if (o.status === "pending") {
      const payBtn = document.createElement("button");
      payBtn.type = "button";
      payBtn.className = "cta-button cta-primary";
      payBtn.textContent = "查看付款指引";
      payBtn.addEventListener("click", () => showToast("请把订单号发给客服/运营完成转账，到账后运营会确认补单，权益立即生效。"));
      ctaHost.appendChild(payBtn);
    }
    if (o.status === "paid" && o.entitlements && o.entitlements.length) {
      const goBtn = document.createElement("button");
      goBtn.type = "button";
      goBtn.className = "cta-button cta-primary";
      goBtn.textContent = "进入频道观看";
      goBtn.addEventListener("click", () => {
        const firstMember = o.entitlements.find((e) => e.resourceType === "membership_channel");
        if (firstMember) {
          requestChannelLink("membership-main").catch(() => showAlert("请先回到首页，点击已解锁的会员内容进入频道。"));
        } else if (o.product?.id) {
          setHashView("home");
          setTimeout(() => showToast("请返回首页，找到「已解锁」内容，点击「前往频道观看」。"), 300);
        }
      });
      ctaHost.appendChild(goBtn);
    }
    return f;
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
    return h;
  }

  /* ================= 我的权益 ================= */

  async function loadUserEntitlements() {
    const summaryEl = document.getElementById("entitlementsSummary");
    const mBlock = document.getElementById("entitlementsMemberships");
    const pBlock = document.getElementById("entitlementsPackages");
    const cBlock = document.getElementById("entitlementsContents");
    summaryEl.innerHTML = `<div class="empty-hint" style="padding:16px">正在加载…</div>`;
    [mBlock, pBlock, cBlock].forEach((b) => (b.innerHTML = ""));
    try {
      const data = await apiCall("/api/user/entitlements");
      renderEntitlementsSummary(data.summary);
      renderMemberships(data.memberships || [], mBlock);
      renderPackages(data.packages || [], pBlock);
      renderContents(data.contents || [], cBlock);
    } catch (err) {
      const msg = err?.status === 401 ? "请先在 Telegram Mini App 内完成登录" : (err?.payload?.message || err?.message || "加载失败");
      summaryEl.innerHTML = `<div class="empty-hint" style="padding:16px"><h4>权益加载失败</h4><p>${escapeHtml(msg)}</p></div>`;
    }
  }

  function renderEntitlementsSummary(summary) {
    const el = document.getElementById("entitlementsSummary");
    const ms = summary?.membership || { status: "none", expiresAt: null };
    const statusLabel = {
      active: { label: "会员有效", color: "var(--success)", text: "#0f3c25" },
      pending: { label: "待激活", color: "var(--pending)", text: "#7a4a00" },
      expired: { label: "已过期", color: "#e1c699", text: "#5b3200" },
      cancelled: { label: "已取消", color: "#ffbfbf", text: "#4d1515" },
      revoked: { label: "已收回", color: "#ffbfbf", text: "#4d1515" },
      none: { label: "尚未开通", color: "rgba(255,255,255,.08)", text: "#efeaf6" },
    }[ms.status] || { label: ms.status, color: "rgba(255,255,255,.08)", text: "#efeaf6" };

    const expiresText = ms.expiresAt ? `到期日：${formatDate(ms.expiresAt, false)}` : "";
    const totalText = `共 ${summary?.totalEntitlements ?? 0} 条权益记录`;

    el.innerHTML = `
      <div class="summary-row">
        <div>
          <div class="summary-label">当前会员</div>
          <div class="summary-value" style="color:${statusLabel.color === "var(--success)" ? "var(--success)" : "#fff"}">${statusLabel.label}</div>
          ${expiresText ? `<div class="summary-sub">${escapeHtml(expiresText)}</div>` : ""}
        </div>
        <div style="padding: 6px 12px; border-radius: 999px; background: ${statusLabel.color}; color: ${statusLabel.text}; font-weight: 800; font-size: 12px;">
          MEMBERSHIP
        </div>
      </div>
      <div class="summary-row">
        <div>
          <div class="summary-label">累计权益</div>
          <div class="summary-value">${escapeHtml(totalText)}</div>
          ${ms.status === "active" ? `<div class="summary-sub">会员内容、会员频道邀请、以及单独购买的内容均在此处查看。</div>`
            : ms.status === "none" ? `<div class="summary-sub">先从首页选择内容，或联系客服开通会员。</div>`
            : `<div class="summary-sub">如需续费，请在订单页创建续费订单后联系客服确认。</div>`}
        </div>
        <button type="button" class="cta-button cta-ghost" id="goHomeFromEntitlements">去首页</button>
      </div>
    `;
    document.getElementById("goHomeFromEntitlements")?.addEventListener("click", () => setHashView("home"));
  }

  function entitlementsBlockHeader(blockEl, title, count, color = "") {
    const h3 = document.createElement("h3");
    h3.innerHTML = `<span>${escapeHtml(title)}</span><span class="count">${count} 条</span>`;
    if (color) h3.style.borderLeft = `4px solid ${color}`;
    blockEl.appendChild(h3);
  }

  function renderMemberships(items, block) {
    block.replaceChildren();
    entitlementsBlockHeader(block, "会员频道权益", items.length, "var(--success)");
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-hint";
      empty.innerHTML = `<h4>暂无会员权益</h4><p>开通后即可进入同频收费会员频道，浏览全部会员内容。</p>`;
      block.appendChild(empty);
      return;
    }
    items.forEach((e) => block.appendChild(entitlementCard({
      status: e.status,
      title: "同频会员频道",
      subtitle: e.expiresAt ? `将于 ${formatDate(e.expiresAt, false)} 到期` : "永久有效",
      start: e.startsAt, end: e.expiresAt, orderNo: e.orderNo,
      cta: e.status === "active"
        ? { text: "进入会员频道", onClick: () => requestChannelLink("membership-main") }
        : null,
    })));
  }

  function renderPackages(items, block) {
    block.replaceChildren();
    entitlementsBlockHeader(block, "内容包权益", items.length, "#b470ff");
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-hint";
      empty.innerHTML = `<h4>暂无内容包权益</h4><p>内容包购买完成后，同主题下的全部内容解锁。</p>`;
      block.appendChild(empty);
      return;
    }
    items.forEach((e) => {
      const meta = e.meta || {};
      const card = entitlementCard({
        status: e.status,
        title: meta.title || `内容包 #${e.resourceId.slice(0, 8)}`,
        subtitle: `${meta.itemsCount || 0} 条内容 · ${e.orderNo ? ("订单 " + e.orderNo) : "无订单"}`,
        start: e.startsAt, end: e.expiresAt, orderNo: e.orderNo,
      });
      if (meta.itemTitles && meta.itemTitles.length) {
        const box = document.createElement("div");
        box.className = "ent-items";
        box.innerHTML = `<div>包含内容（展示前 ${meta.itemTitles.length} 条）</div>
          <ul>${meta.itemTitles.map((t) => `<li>${escapeHtml(t || "未命名内容")}</li>`).join("")}</ul>`;
        card.appendChild(box);
      }
      block.appendChild(card);
    });
  }

  function renderContents(items, block) {
    block.replaceChildren();
    entitlementsBlockHeader(block, "单独购买的内容权益", items.length, "#81d5a3");
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-hint";
      empty.innerHTML = `<h4>暂无单独购买内容</h4><p>如购买过单条内容，会显示在这里。</p>`;
      block.appendChild(empty);
      return;
    }
    items.forEach((e) => {
      const meta = e.meta || {};
      const card = entitlementCard({
        status: e.status,
        title: meta.title || `内容 #${e.resourceId.slice(0, 8)}`,
        subtitle: meta.durationSeconds
          ? `时长 ${formatDurationSeconds(meta.durationSeconds)}`
          : (e.orderNo ? ("订单 " + e.orderNo) : ""),
        start: e.startsAt, end: e.expiresAt, orderNo: e.orderNo,
        cta: e.status === "active"
          ? { text: "进入频道观看", onClick: () => requestChannelLink(e.resourceId) }
          : null,
      });
      block.appendChild(card);
    });
  }

  function entitlementCard({ status, title, subtitle, start, end, orderNo, cta }) {
    const card = document.createElement("div");
    card.className = "entitlement-card";
    const head = document.createElement("div");
    head.className = "ent-head";
    const left = document.createElement("div");
    const t = document.createElement("div");
    t.className = "ent-title";
    t.textContent = title;
    const s = document.createElement("div");
    s.className = "ent-sub";
    s.textContent = subtitle || "";
    left.append(t, s);
    const right = document.createElement("div");
    const st = document.createElement("span");
    st.className = `ent-status status-${status}`;
    const statusLabel = {
      active: "有效",
      pending: "待生效",
      expired: "已过期",
      revoked: "已收回",
      cancelled: "已取消",
    }[status] || status || "-";
    st.textContent = statusLabel;
    right.appendChild(st);
    head.append(left, right);
    card.appendChild(head);

    const dates = document.createElement("div");
    dates.className = "ent-dates";
    dates.innerHTML = `
      <div>生效开始：<strong>${formatDate(start)}</strong></div>
      <div>到期时间：<strong>${end ? formatDate(end, true) : "永久"}</strong></div>
      ${orderNo ? `<div>订单号：<code style="user-select:all; font-size: 12px; color: #e9d5ff">${escapeHtml(orderNo)}</code></div>` : ""}
    `;
    card.appendChild(dates);

    if (cta) {
      const footer = document.createElement("div");
      footer.style.cssText = "margin-top:12px; display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap;";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cta-button cta-primary";
      btn.textContent = cta.text;
      btn.addEventListener("click", cta.onClick);
      footer.appendChild(btn);
      card.appendChild(footer);
    }
    return card;
  }

  /* ================= 全局按钮绑定 ================= */

  function bindGlobalButtons() {
    document.getElementById("backButton").addEventListener("click", () => {
      if (state.view === "home") return;
      setHashView("home");
    });
    document.getElementById("refreshButton").addEventListener("click", loadAccess);
    document.getElementById("openOrdersButton").addEventListener("click", () => setHashView("orders"));
    document.getElementById("openEntitlementsButton").addEventListener("click", () => setHashView("entitlements"));

    const dlg = document.getElementById("accountDialog");
    document.getElementById("profileButton").addEventListener("click", () => {
      document.getElementById("accountName").textContent = state.user?.first_name || "访客";
      document.getElementById("accountId").textContent = state.user?.id || "仅在 Telegram 内获取";
      document.getElementById("accountAccess").textContent = state.access || "-";
      try { dlg.showModal(); } catch (_) {}
    });
    document.getElementById("closeDialog").addEventListener("click", () => dlg.close());
    document.getElementById("navOrdersButton").addEventListener("click", () => {
      dlg.close();
      setHashView("orders");
    });
    document.getElementById("navEntitlementsButton").addEventListener("click", () => {
      dlg.close();
      setHashView("entitlements");
    });

    const co = document.getElementById("createOrderDialog");
    document.getElementById("closeOrderDialog").addEventListener("click", () => co.close());
    document.getElementById("coCancel").addEventListener("click", () => co.close());
  }

  /* ================= 顶层 render ================= */

  function render() {
    renderHome();
    syncViewFromHash();
  }

  /* ================= 启动 ================= */

  document.addEventListener("DOMContentLoaded", () => {
    initTelegram();
    bindGlobalButtons();
    initOrdersToolbar();
    window.addEventListener("hashchange", syncViewFromHash);
    if (!location.hash) location.hash = "view=home";
    else syncViewFromHash();
    loadAccess();
  });
})();
