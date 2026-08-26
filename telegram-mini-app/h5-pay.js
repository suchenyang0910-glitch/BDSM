(function () {
  "use strict";

  const H5_ERROR_ZH = {
    unauthorized: "未检测到登录态。请使用页面上的「Telegram 登录」按钮完成登录，或回到 Telegram Mini App 中打开本页面。",
    forbidden: "无权访问该订单。",
    product_not_found: "商品不存在或已下架，请回到 Mini App 选择在售商品。",
    bad_request: "参数不正确：USDT 商品需要 productId 为 USDT 币种，订单号需是你的订单。",
    usdt_address_pool_exhausted: "当前地址池已满，请稍后重试或联系客服更换地址池。",
    usdt_assign_failed: "地址分配失败，请稍后重试。",
    usdt_tail_exhausted_retry_next: "地址尾数占用，请重新下单（会换地址重试）。",
    pool_empty: "支付系统资源占用已满，请稍后再试。",
    payment_expired: "支付窗口已过期，请重新创建订单。",
    not_found: "订单或商品不存在。",
    stars_invoice_service_unavailable: "Stars 发票服务暂时不可用（Bot 未配置或 API 失败），请稍后重试或联系运营。",
    stars_continue_not_found: "未找到该订单（可能已被删除或订单号错误）。",
    stars_continue_not_owner: "该订单不是你的，无法续付（可发起新单或在 Mini App 中打开）。",
    stars_continue_not_stars: "该订单不是 Telegram Stars 支付，不能使用 Stars 续付通道。",
    stars_continue_not_pending: "该订单已不处于待支付状态，请重新创建订单。",
    stars_continue_expired: "Stars 续付窗口（30 分钟）已过，请重新创建订单。",
    stars_continue_no_invoice: "该旧单未保存发票链接（可能是旧版本创建），请重新创建订单。",
    h5_login_missing_bot_token: "服务端未配置 Telegram Bot 凭证，H5 登录暂不可用。请使用 Telegram Mini App 打开本页。",
    h5_login_invalid_hash: "登录回调签名校验失败。请返回登录页重新点击「使用 Telegram 登录」。",
    h5_login_auth_expired: "登录授权已超过 10 分钟有效窗口。请返回登录页重新发起授权。",
    h5_login_internal_error: "服务端用户登记失败。请稍后重试，或使用 Telegram Mini App 打开本页。",
    h5_login_merge_failed: "匿名订单合并失败。请稍后重试，或使用 Telegram Mini App 打开本页。",
    h5_login_required_for_payment: "当前页面已自动登录，可直接创建 USDT 订单；若需跨设备恢复订单与权益，请绑定 Telegram。",
    h5_login_required_for_channel_access: "获取 VIP 频道邀请链接前需要先绑定 Telegram 身份，否则无法将你加入目标频道。",
  };

  const BOT_USERNAME_FALLBACK = "InTune_bdsm_bot";
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  const VIEW_MAP = ["unauth", "orders", "entitlements", "channels", "payDetail", "error"];
  let currentView = "";
  let currentIdentitySession = null;

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

  function zhMsg(err) {
    const payload = err?.payload || err?.response?.data || {};
    const code =
      payload.error ||
      payload.code ||
      payload.userError ||
      payload.errorClass ||
      "";
    if (code && H5_ERROR_ZH[code]) return H5_ERROR_ZH[code];
    const raw = payload.userMessage || payload.message || payload.error || err?.message || "";
    return raw || "请稍后重试或联系客服。";
  }

  function minorToDecimalUsdt(minorStr) {
    const n = BigInt(minorStr || "0");
    const d = 1_000_000n;
    const whole = n / d;
    const frac = n % d;
    const fracStr = frac.toString().padStart(6, "0");
    return `${whole.toString()}.${fracStr}`;
  }

  function minorToDisplayUsdtPrice(minorStr) {
    return minorToDecimalUsdt(minorStr).replace(/\.?0+$/, "") || "0";
  }

  function normalizeXtrMinor(minorStr) {
    const n = BigInt(minorStr || "0");
    if (n > 0n && n >= 1_000_000n && n % 1_000_000n === 0n) return n / 1_000_000n;
    return n;
  }

  function minorToDecimalXtr(minorStr) {
    return normalizeXtrMinor(minorStr).toString();
  }

  function requestWithCompatibility(url, options) {
    if (typeof window.fetch === "function") return window.fetch(url, options);
    return new Promise((resolve, reject) => {
      if (typeof window.XMLHttpRequest !== "function") {
        reject(new Error("network_api_unavailable"));
        return;
      }
      const xhr = new window.XMLHttpRequest();
      xhr.open(options?.method || "GET", url, true);
      xhr.withCredentials = options?.credentials === "include";
      Object.entries(options?.headers || {}).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.onload = () => resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        json: async () => {
          const text = xhr.responseText || "";
          return text ? JSON.parse(text) : null;
        },
      });
      xhr.onerror = () => reject(new Error("network_request_failed"));
      xhr.ontimeout = () => reject(new Error("network_request_timeout"));
      xhr.send(options?.body || null);
    });
  }

  function api(url, options) {
    return requestWithCompatibility(url, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
    }).then(async (res) => {
      let payload = null;
      try {
        payload = await res.json();
      } catch (_) {
        payload = null;
      }
      if (!res.ok) {
        const e = new Error(payload?.message || `HTTP ${res.status}`);
        e.status = res.status;
        e.payload = payload;
        throw e;
      }
      return payload;
    });
  }

  function trackAnalytics(eventName, payload) {
    return requestWithCompatibility("/api/analytics/events", {
      credentials: "include",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        events: [{
          eventName: eventName,
          payload: Object.assign({
            platform: tg && typeof tg.openInvoice === "function" ? "telegram_mini_app" : "h5",
          }, payload || {}),
        }],
      }),
    }).catch(function () {});
  }

  function $(id) {
    return document.getElementById(id);
  }

  function showView(name) {
    const keyMap = {
      unauth: "viewUnauth",
      orders: "viewOrders",
      entitlements: "viewEntitlements",
      channels: "viewChannels",
      payDetail: "viewPayDetail",
      error: "viewError",
    };
    VIEW_MAP.forEach((n) => {
      const el = $(keyMap[n]);
      if (!el) return;
      el.style.display = n === name ? "block" : "none";
    });
    currentView = name;

    const tabBar = $("tabBar");
    if (tabBar) {
      const tabEnabled = name !== "unauth";
      tabBar.style.display = tabEnabled ? "grid" : "none";
      if (tabEnabled) {
        const tabName = { orders: "orders", entitlements: "entitlements", channels: "channels", payDetail: "pay" }[name];
        tabBar.querySelectorAll(".t").forEach((el) => {
          el.classList.toggle("active", el.dataset.tab === tabName);
        });
      }
    }
  }

  function showError(text) {
    showView("error");
    $("errorBox").textContent = text;
  }

  function copyText(t) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(t).then(() => true).catch(() => fallbackCopy(t));
      }
      return fallbackCopy(t);
    } catch (_) {
      return fallbackCopy(t);
    }
  }
  function fallbackCopy(t) {
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
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

  function currentOrderNoFromQs() {
    const p = new URLSearchParams(location.search);
    return p.get("orderNo") || "";
  }
  function currentProductIdFromQs() {
    const p = new URLSearchParams(location.search);
    return p.get("productId") || "";
  }
  function currentPaymentMethodFromQs() {
    const p = new URLSearchParams(location.search);
    return p.get("paymentMethod") || "";
  }

  function replaceCheckoutQuery(input) {
    const qs = new URLSearchParams(location.search);
    if (input.orderNo) qs.set("orderNo", input.orderNo); else qs.delete("orderNo");
    if (input.productId) qs.set("productId", input.productId); else qs.delete("productId");
    if (input.paymentMethod) qs.set("paymentMethod", input.paymentMethod); else qs.delete("paymentMethod");
    history.replaceState(null, "", `${location.pathname}?${qs.toString()}${location.hash || ""}`);
  }

  function isUsdtOrder(order) {
    return !!(order && (order.currency === "USDT" || order.paymentMethod === "usdt_trc20" || order.paymentMethod === "usdt_trc20_external"));
  }

  function isStarsOrder(order) {
    return !!(order && (order.paymentMethod === "telegram_stars" || order.paymentProvider === "telegram_stars" || order.currency === "XTR"));
  }

  function configurePaymentDetailMode(order, options) {
    const opts = options || {};
    const stars = opts.forceStars || isStarsOrder(order);
    const payTitle = $("payTitle");
    const paySubtitle = $("paySubtitle");
    const listPriceLabel = $("listPriceLabel");
    const payableLabelText = $("payableLabelText");
    const payCurrency = $("payCurrency");
    const copyAmountBtn = $("copyAmountBtn");
    const btnCopyAmount = $("btnCopyAmount");
    const addressWrap = $("addressWrap");
    const pollingWrap = $("pollingWrap");
    const starsWrap = $("starsWrap");

    if (stars) {
      if (payTitle) payTitle.textContent = "Telegram Stars 支付";
      if (paySubtitle) {
        paySubtitle.textContent = opts.invoiceFallback
          ? "当前环境无法直接拉起 Stars 原生支付，请复制发票链接回到 Telegram 内完成。"
          : "Telegram 内优先使用 Stars；若未完成，订单仍可稍后继续支付或切换 USDT。";
      }
      if (listPriceLabel) listPriceLabel.textContent = "商品价格";
      if (payableLabelText) payableLabelText.textContent = "应付金额";
      if (payCurrency) payCurrency.textContent = "XTR";
      if (copyAmountBtn) copyAmountBtn.style.display = "none";
      if (btnCopyAmount) btnCopyAmount.style.display = "none";
      if (addressWrap) addressWrap.style.display = "none";
      if (pollingWrap) pollingWrap.style.display = "block";
      if (starsWrap) starsWrap.style.display = opts.invoiceFallback ? "block" : "none";
      return;
    }

    if (payTitle) payTitle.textContent = "USDT-TRC20 支付";
    if (paySubtitle) paySubtitle.textContent = "请使用 TRON (TRC-20) 网络按精确金额转账，页面会自动恢复订单状态。";
    if (listPriceLabel) listPriceLabel.textContent = "商品价格";
    if (payableLabelText) payableLabelText.textContent = "实际应付（尾数唯一识别）";
    if (payCurrency) payCurrency.textContent = "USDT";
    if (addressWrap) addressWrap.style.display = "block";
    if (pollingWrap) pollingWrap.style.display = "block";
    if (starsWrap) starsWrap.style.display = "none";
    const refreshedCopyAmount = $("copyAmountBtn");
    if (refreshedCopyAmount) refreshedCopyAmount.style.display = "";
    if (btnCopyAmount) btnCopyAmount.style.display = "";
  }

  function setStep(stepIdx) {
    document.querySelectorAll("#paySteps .step").forEach((el, idx) => {
      const i = idx + 1;
      el.classList.remove("active", "done");
      if (i < stepIdx) el.classList.add("done");
      else if (i === stepIdx) el.classList.add("active");
    });
  }

  function setStatus(status, textOverride) {
    const pill = $("statusPill");
    const text = $("statusText");
    if (!pill || !text) return;
    pill.classList.remove(
      "pill-pending",
      "pill-paid",
      "pill-checking",
      "pill-expired",
    );
    const map = {
      pending: ["pill-pending", "待支付"],
      processing: ["pill-checking", "检测中"],
      paid: ["pill-paid", "已支付"],
      expired: ["pill-expired", "已过期"],
      cancelled: ["pill-expired", "已取消"],
      failed: ["pill-expired", "支付失败"],
      refunded: ["pill-expired", "已退款"],
    };
    const [cls, txt] = map[status] || ["pill-checking", "状态未知"];
    pill.classList.add(cls);
    text.textContent = textOverride || txt;
  }

  let pollTimer = null;
  let paidRedirectTimer = null;
  let lastForegroundRefreshAt = 0;
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function handleStarsInvoiceResult(orderNo, status) {
    loadOrders();
    loadEntitlements();
    if (status === "paid") {
      setStatus("processing", "Stars 支付成功，正在核验权益…");
      handleQueryOrder(orderNo);
      return;
    }
    if (status === "pending") {
      setStatus("processing", "Stars 支付确认中…");
      startPolling(orderNo);
      return;
    }
    if (status === "failed") {
      showError("Stars 支付未完成。你可以稍后继续支付，或切换到 USDT-TRC20。");
      return;
    }
    showError("已取消 Stars 支付，订单仍可在此继续处理。");
  }

  function startPolling(orderNo) {
    stopPolling();
    let attempt = 0;
    const tick = async () => {
      attempt += 1;
      try {
        const list = await api(`/api/user/orders?page=1&pageSize=50`);
        const found = (list?.items || []).find((o) => o.orderNo === orderNo);
        if (!found) return;
        applyOrderData(found);
        if (["paid", "expired", "cancelled", "refunded", "failed"].includes(found.status)) {
          stopPolling();
          if (found.status === "paid") {
            setStep(4);
            const card = $("activatedCard");
            if (card) card.style.display = "block";
          }
        }
      } catch (e) {
        // 忽略，下次重试
      }
    };
    tick();
    pollTimer = setInterval(tick, attempt < 5 ? 2500 : 5000);
  }

  function drawQr(address) {
    const box = $("qrBox");
    if (!box) return;
    box.innerHTML = "";
    try {
      if (typeof QRCode !== "undefined") {
        new QRCode(box, {
          // Raw TRON address is the cross-wallet QR format. Some wallets can
          // display a tron: URI but fail to start a TRC-20 transfer from it.
          // The exact unique USDT amount remains a separate one-tap copy.
          text: address,
          width: 220,
          height: 220,
          colorDark: "#0f0c18",
          colorLight: "#ffffff",
          correctLevel: 2,
        });
      } else {
        const img = document.createElement("img");
        img.alt = "二维码";
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=4&data=${encodeURIComponent(address)}`;
        box.appendChild(img);
      }
    } catch (_) {
      const span = document.createElement("div");
      span.textContent = "请使用钱包扫描下方地址";
      span.style.color = "#632d73";
      span.style.fontSize = "11px";
      span.style.fontWeight = "800";
      box.appendChild(span);
    }
  }

  let lastAddress = "";

  function showActivatedCard() {
    const card = $("activatedCard");
    if (!card) return;
    // 钱包 App 返回 H5 时，始终把已支付结果带回可见的支付详情页，避免停留在旧的待支付列表。
    showView("payDetail");
    const bound = currentIdentitySession?.telegramBound === true;
    const message = $("activatedMessage");
    const button = $("btnBackMiniApp");
    if (message) {
      message.innerHTML = bound
        ? "订单已确认支付成功，频道邀请已通过 Telegram Bot 私信发送给你。<br/>将在 3 秒后进入「我的权益」，你也可以立即查看。"
        : "订单已确认支付成功。请先绑定 Telegram，以便合并权益并领取私密频道邀请。";
    }
    if (button) button.textContent = bound ? "立即查看我的权益" : "绑定 Telegram 后领取频道";
    card.style.display = "block";
    if (bound && !paidRedirectTimer) {
      paidRedirectTimer = window.setTimeout(() => {
        window.location.assign("./index.html#view=entitlements");
      }, 3000);
    }
  }

  function applyOrderData(o) {
    configurePaymentDetailMode(o);
    const metaEl = $("orderMeta");
    if (metaEl) {
      metaEl.innerHTML =
        `<div>订单号：<code style="user-select:all; background:rgba(180,112,255,.14); padding:2px 6px; border-radius:6px; font-size:12px">${o.orderNo}</code></div>` +
        `<div style="margin-top:4px">创建：${formatDate(o.createdAt)}｜${o.product?.title ? ("商品：" + o.product.title) : ""}</div>` +
        (o.currency ? `<div style="margin-top:4px">币种：${o.currency}｜状态：${o.status}</div>` : "");
    }

    const isUsdt = isUsdtOrder(o);
    const displayAmount =
      o.usdtPayment?.displayAmountDecimal ??
      (isUsdt ? minorToDecimalUsdt(o.amountMinor) :
        o.currency === "XTR" ? minorToDecimalXtr(o.amountMinor) : null);
    // USDT 订单 amountMinor 是包含唯一尾数的实际应付金额；优先展示商品基价，避免把尾数误称为标价。
    const baseAmountMinor = o.usdtPayment?.baseAmountMinor ?? o.product?.usdtPriceMinor ?? null;
    const listPrice = isUsdt
      ? (baseAmountMinor != null ? minorToDisplayUsdtPrice(baseAmountMinor) : minorToDisplayUsdtPrice(o.amountMinor))
      : o.currency === "XTR" ? minorToDecimalXtr(o.amountMinor) : null;

    const listPriceEl = $("listPrice");
    if (listPriceEl) listPriceEl.textContent = listPrice ? `${listPrice} ${o.currency || ""}` : "—";
    const payEl = $("payAmount");
    if (payEl) {
      if (displayAmount) {
        const pieces = displayAmount.split(".");
        payEl.innerHTML = pieces.length === 2
          ? `${pieces[0]}.<span class="amount-tail">${pieces[1]}</span>`
          : `${displayAmount}`;
      } else {
        payEl.textContent = "—";
      }
    }

    const addr =
      o.usdtPayment?.toAddress ||
      o.usdtPayment?.address ||
      o.usdtPaymentAddress ||
      (o._h5Extra && o._h5Extra.address) ||
      "";
    if (addr && addr !== lastAddress) {
      lastAddress = addr;
      const addrEl = $("addrText");
      if (addrEl) addrEl.textContent = addr;
      drawQr(addr);
    }

    const confirmations = o.usdtPayment?.confirmationsTarget || 3;
    const confEl = $("confirmNum");
    if (confEl) confEl.textContent = confirmations;

    setStatus(o.status);

    if (o.status === "pending") setStep(1);
    else if (o.status === "processing") setStep(2);
    else if (o.status === "paid") {
      setStep(3);
      showActivatedCard();
    }
    else if (["expired", "cancelled", "failed"].includes(o.status)) {
      setStep(1);
    }
  }

  function formatDate(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function statusLabel(s) {
    return {
      pending: "待支付",
      processing: "处理中",
      paid: "已支付",
      expired: "已过期",
      cancelled: "已取消",
      failed: "失败",
      refunded: "已退款",
    }[s] || s;
  }

  function setChipAuthed(user) {
    const chip = $("userChip");
    const text = $("userChipText");
    if (!chip || !text) return;
    chip.classList.remove("off");
    const nick = user?.telegramFirstName
      || user?.telegramUsername
      || user?.nickname
      || (user?.telegramUserId ? `TG#${user.telegramUserId}` : "已登录");
    text.textContent = nick;
    chip.title = `已登录：${nick}`;
  }
  function setChipUnauth() {
    const chip = $("userChip");
    const text = $("userChipText");
    if (!chip || !text) return;
    chip.classList.add("off");
    text.textContent = "未登录";
    chip.title = "未登录：请在 Telegram Mini App 中打开本页";
  }

  function setDeepLink() {
    const btn = $("tgDeepLinkBtn");
    if (!btn) return;
    const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const h5Return = encodeURIComponent(location.pathname + location.search + location.hash);
    const href = `tg://resolve?domain=${BOT_USERNAME_FALLBACK}&start=h5_${token}_${h5Return}`;
    btn.href = href;
  }

  async function boot() {
    const qs = new URLSearchParams(location.search);
    const loginSuccess = qs.get("login") === "success";
    if (loginSuccess) {
      history.replaceState(null, "", `${location.pathname}${location.hash || ""}`);
      setTimeout(() => {
        const t = document.createElement("div");
        t.setAttribute("style", "position:fixed; left:50%; top:24px; transform:translateX(-50%); z-index:9999; padding:10px 16px; background:rgba(80,200,120,.15); border:1px solid rgba(80,200,120,.3); color:#c6ffd8; border-radius:12px; font-size:13px; backdrop-filter:blur(6px); box-shadow:0 10px 30px rgba(0,0,0,.4);");
        t.textContent = "✅ 登录成功 · 已绑定 Telegram 身份（订单与 VIP 频道权益可长期找回）";
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 4200);
      }, 400);
    }

    setDeepLink();
    setChipUnauth();

    const qsOrder = currentOrderNoFromQs();
    const qsProd = currentProductIdFromQs();
    const qsPaymentMethod = currentPaymentMethodFromQs();
    if (qsOrder) $("orderNo").value = qsOrder;
    if (qsProd && qsProd !== "list") $("productId").value = qsProd;

    // 首屏自动恢复登录；首次访问时由服务端创建持久会话。
    let established = false;
    try {
      const sess = await api("/api/auth/h5/session", {});
      if (sess && typeof sess.identity === "string") {
        currentIdentitySession = sess;
        established = true;
      }
    } catch (_) { /* ignore 401 */ }

    if (!established) {
      try {
        const gs = await api("/api/auth/h5/guest-session", { method: "POST", body: JSON.stringify({}) });
        if (gs && typeof gs.identity === "string") {
          currentIdentitySession = gs;
          established = true;
        }
      } catch (e) {
        showError("自动登录失败：" + zhMsg(e));
        return;
      }
    }

    if (!established) {
      const returnTo = encodeURIComponent(location.pathname + location.search + location.hash);
      window.location.assign(`/login.html?redirect=${returnTo}`);
      return;
    }

    if (currentIdentitySession?.telegramBound) {
      setChipAuthed({
        nickname: currentIdentitySession.displayName,
      });
    } else {
      const chip = $("userChip");
      const text = $("userChipText");
      if (chip && text) {
        chip.classList.remove("off");
        text.textContent = (currentIdentitySession.displayName || "同频成员") + " · 绑定 Telegram 可跨设备恢复";
        chip.title = "当前账户可浏览、创建 USDT 待支付订单；绑定 Telegram 后可跨设备恢复订单与权益。";
        let bound = false;
        chip.onclick = () => {
          if (bound) return;
          const returnTo = encodeURIComponent(location.pathname + location.search + location.hash);
          window.location.assign(`/login.html?redirect=${returnTo}`);
        };
      }
    }

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.style.display = currentIdentitySession?.telegramBound ? "" : "none";
      logoutBtn.onclick = async () => {
        try { await api("/api/auth/h5/logout", { method: "POST", body: JSON.stringify({}) }); } catch (_) {}
        window.location.reload();
      };
    }

    if (qsOrder) {
      trackAnalytics("checkout_open", {
        orderNo: qsOrder,
        paymentMethod: qsPaymentMethod === "stars" ? "telegram_stars" : qsPaymentMethod === "usdt" ? "usdt_trc20" : "manual",
      });
      await handleQueryOrder(qsOrder);
      return;
    }
    if (qsProd && qsProd !== "list") {
      trackAnalytics("checkout_open", {
        productId: qsProd,
        paymentMethod: qsPaymentMethod === "stars" ? "telegram_stars" : qsPaymentMethod === "usdt" ? "usdt_trc20" : "manual",
      });
      if (qsPaymentMethod === "stars") await handleCreateStarsOrder(qsProd);
      else await handleCreateOrder(qsProd);
      return;
    }
    showView("orders");
    await Promise.all([
      loadOrders().catch(() => {}),
      loadEntitlements().catch(() => {}),
      loadChannels().catch(() => {}),
    ]);
  }

  function ensureTelegramBound(userErrorKey) {
    if (currentIdentitySession?.telegramBound) return true;
    const returnTo = encodeURIComponent(location.pathname + location.search + location.hash);
    const errText = H5_ERROR_ZH[userErrorKey] || "需要先绑定 Telegram 身份。";
    try { sessionStorage.setItem("h5_pending_action_reason", userErrorKey + "|" + errText); } catch (_) {}
    window.location.assign(`/login.html?redirect=${returnTo}`);
    return false;
  }

  function disableAllPayButtons() {
    ["btnCreateOrder", "btnGotoOrder"].forEach((id) => {
      const b = $(id);
      if (b) { b.disabled = true; b.title = "未登录，禁止发起/查询支付"; }
    });
  }

  async function loadOrders() {
    const box = $("ordersList");
    if (!box) return;
    try {
      const list = await api(`/api/user/orders?page=1&pageSize=50`);
      const items = list?.items || [];
      if (items.length === 0) {
        box.innerHTML = `<div class="empty-hint"><h4>暂无订单</h4><div style="color:#8e7fb0; font-size:12px; margin-top:6px;">在 Telegram Mini App 中或本页创建支付后会出现在这里。</div></div>`;
        return;
      }
      box.innerHTML = items.map((o) => {
        const amount = o.currency === "USDT" ? minorToDecimalUsdt(o.amountMinor) :
          o.currency === "XTR" ? minorToDecimalXtr(o.amountMinor) : o.amountMinor;
        const isUsdt = o.currency === "USDT" || o.paymentMethod === "usdt_trc20" || o.paymentMethod === "usdt_trc20_external";
        const isStars = o.paymentMethod === "telegram_stars" || o.paymentProvider === "telegram_stars" || o.currency === "XTR";
        const canContinueUsdt = ["pending", "processing"].includes(o.status) && isUsdt;
        const canContinueStars = ["pending", "processing"].includes(o.status) && isStars;
        const canViewPaid = ["paid", "expired", "cancelled", "failed", "refunded"].includes(o.status);
        return `
          <div class="order-list-item">
            <div class="oli-head">
              <div>
                <div class="oli-title">${o.product?.title || "商品"} <span style="color:#8e7fb0; font-weight:500; margin-left:6px;">· ${o.currency || ""}</span></div>
                <div class="oli-meta">${o.orderNo}</div>
              </div>
              <div>
                <div class="oli-price">${amount ? amount + " " + (o.currency || "") : "-"}</div>
                <div class="oli-meta" style="text-align:right">${formatDate(o.createdAt)} · ${statusLabel(o.status)}</div>
              </div>
            </div>
            ${o._h5QuickNote ? `<div class="ent-sub" style="margin-bottom:8px;">${o._h5QuickNote}</div>` : ""}
            <div class="oli-cta">
              ${canContinueUsdt ? `<button class="btn btn-primary" data-act="pay" data-pay="usdt" data-no="${o.orderNo}">继续 USDT 支付</button>` : ""}
              ${canContinueStars ? `<button class="btn btn-primary" data-act="pay" data-pay="stars" data-no="${o.orderNo}">继续 Stars 支付</button>` : ""}
              ${canViewPaid ? `<button class="btn btn-ghost" data-act="view" data-no="${o.orderNo}">查看详情</button>` : ""}
              <button class="btn btn-ghost" data-act="copy" data-no="${o.orderNo}" title="复制订单号">复制单号</button>
            </div>
          </div>
        `;
      }).join("");
      box.querySelectorAll("button[data-act]").forEach((b) => {
        const act = b.dataset.act;
        const no = b.dataset.no;
        const pay = b.dataset.pay || "usdt";
        b.addEventListener("click", () => {
          if (act === "pay") {
            if (pay === "stars") handleContinueStars(no);
            else handleQueryOrder(no);
          }
          else if (act === "view") handleQueryOrder(no);
          else if (act === "copy") { if (copyText(no)) flashBtnEl(b, "✓ 已复制"); }
        });
      });
    } catch (err) {
      box.innerHTML = `<div class="error-box">加载订单失败：${zhMsg(err)}</div>`;
    }
  }

  async function loadEntitlements() {
    const box = $("entitlementsList");
    if (!box) return;
    try {
      const data = await api(`/api/user/entitlements?page=1&pageSize=50`);
      const memberships = Array.isArray(data?.memberships) ? data.memberships : [];
      const packages = Array.isArray(data?.packages) ? data.packages : [];
      const contents = Array.isArray(data?.contents) ? data.contents : [];
      const others = Array.isArray(data?.others) ? data.others : [];
      const total = memberships.length + packages.length + contents.length + others.length;
      const summary = data?.summary || {};
      if (total === 0) {
        box.innerHTML = `<div class="empty-hint"><h4>暂无权益</h4><div style="color:#8e7fb0; font-size:12px; margin-top:6px;">完成首笔支付后，你的会员 / 内容包 / 单条内容权益会自动出现在这里。点击下方「去购买」查看在售商品。</div><div style="margin-top:14px;"><a class="btn btn-primary" href="./h5-pay.html?product=list">去购买</a></div></div>`;
        return;
      }
      const activeStatus = summary?.membership?.status === "active" ? "会员生效中" : "暂无有效会员";
      const expireHint = summary?.membership?.expiresAt ? ` · 会员到期：${formatDate(summary.membership.expiresAt)}` : "";
      const totalHint = `当前共 ${total} 项权益`;
      const groups = [
        { key: "memberships", list: memberships, label: "会员主权益", tag: ["VIP 会员", "rgba(255,180,80,.10)", "#ffc98a", "rgba(255,180,80,.28)"] },
        { key: "packages", list: packages, label: "内容包交付权益", tag: ["内容包", "rgba(180,112,255,.12)", "#d7b9ff", "rgba(180,112,255,.3)"] },
        { key: "contents", list: contents, label: "单条内容交付权益", tag: ["内容", "rgba(80,180,255,.12)", "#aad9ff", "rgba(80,180,255,.3)"] },
        { key: "others", list: others, label: "其他权益", tag: ["其他", "rgba(120,120,120,.10)", "#cfcfcf", "rgba(120,120,120,.25)"] },
      ];
      const renderItem = (e, groupTag) => {
        if (!e) return "";
        const [tagText, tagBg, tagColor, tagBorder] = groupTag;
        const status = e.status || "unknown";
        const statusTag =
          status === "active"
            ? `<span class="tag" style="background:rgba(80,200,160,.12); color:#8fe0bd; border-color:rgba(80,200,160,.3)">有效</span>`
            : `<span class="tag" style="background:rgba(255,102,102,.1); color:#ff9191; border-color:rgba(255,102,102,.2)">${escapeHtml(status)}</span>`;
        const kindTag = `<span class="tag" style="background:${tagBg}; color:${tagColor}; border-color:${tagBorder}">${tagText}</span>`;
        let title = "权益项";
        let sub = "";
        if (e?.resourceType === "membership_channel") {
          title = "VIP 会员主频道 · 不限量观看";
          sub = `类型：会员主频道`;
        } else if (e?.resourceType === "package") {
          const meta = e?.meta || {};
          title = meta?.title || `内容包权益 #${(e?.resourceId || "").slice(0, 8)}`;
          const cnt = typeof meta?.itemsCount === "number" ? ` · 内含 ${meta.itemsCount} 条内容` : "";
          sub = `类型：内容包交付${cnt}`;
        } else if (e?.resourceType === "content") {
          const meta = e?.meta || {};
          title = meta?.title || `单条内容 #${(e?.resourceId || "").slice(0, 8)}`;
          sub = `类型：单条内容交付`;
        } else {
          title = `其他：${e?.resourceType || e?.referenceCode || "未命名"}`;
          sub = `类型：${escapeHtml(e?.resourceType || "other")}`;
        }
        const lines = [sub];
        if (e?.grantedAt) lines.push(`发放：${formatDate(e.grantedAt)}`);
        if (e?.expiresAt) lines.push(`过期：${formatDate(e.expiresAt)}`);
        else if (status === "active") lines.push("过期：长期有效");
        if (e?.orderNo) lines.push(`来源订单：${escapeHtml(e.orderNo)}`);
        return `
          <div class="ent-item">
            <div>
              <div class="ent-title">${escapeHtml(title)}</div>
              <div class="ent-sub">${escapeHtml(lines.filter(Boolean).join(" · "))}</div>
              <div class="ent-badges">${kindTag}${statusTag}</div>
            </div>
          </div>
        `;
      };
      const sectionHtml = groups
        .map((g) => {
          if (!g.list || g.list.length === 0) return "";
          const itemsHtml = g.list.map((e) => renderItem(e, g.tag)).join("");
          return `
            <div class="ent-group">
              <div class="ent-group-label">${escapeHtml(g.label)}（${g.list.length}）</div>
              ${itemsHtml}
            </div>
          `;
        })
        .filter(Boolean)
        .join("");
      box.innerHTML = `
        <div class="summary-card" style="padding:14px 16px; border-radius:14px; background:linear-gradient(135deg,rgba(255,180,80,.12),rgba(180,112,255,.10)); border:1px solid rgba(255,255,255,.06); margin-bottom:16px;">
          <div style="font-size:13px; color:#e7dcff;">权益总览 · ${escapeHtml(totalHint)}</div>
          <div style="font-size:15px; font-weight:600; color:#fff; margin-top:6px;">${escapeHtml(activeStatus)}${escapeHtml(expireHint)}</div>
          <div style="font-size:12px; color:#a99ad4; margin-top:4px;">已发放：会员 ${memberships.length} · 内容包 ${packages.length} · 单条 ${contents.length} · 其他 ${others.length}</div>
        </div>
        ${sectionHtml}
      `;
    } catch (err) {
      box.innerHTML = `<div class="error-box">加载权益失败：${zhMsg(err)}</div>`;
    }
  }

  async function loadChannels() {
    const box = $("channelsList");
    if (!box) return;
    try {
      const data = await api(`/api/user/channels`);
      const items = data?.items || [];
      if (items.length === 0) {
        box.innerHTML = `<div class="empty-hint"><h4>暂无可进入的频道</h4><div style="color:#8e7fb0; font-size:12px; margin-top:6px;">完成支付并激活权益后，会在这里列出对应的 Telegram 私密频道。</div></div>`;
        return;
      }
      const kindTagMap = {
        public: ["免费公开", "rgba(80,200,160,.12)", "#8fe0bd", "rgba(80,200,160,.3)"],
        membership: ["VIP 会员", "rgba(255,180,80,.10)", "#ffc98a", "rgba(255,180,80,.28)"],
        package: ["内容包", "rgba(180,112,255,.12)", "#d7b9ff", "rgba(180,112,255,.3)"],
      };
      box.innerHTML = items.map((c) => {
        const tag = kindTagMap[c.kind] || ["频道", "rgba(180,112,255,.10)", "#cfa8ff", "rgba(180,112,255,.26)"];
        const [tagText, tagBg, tagColor, tagBorder] = tag;
        let ctaHtml = "";
        if (!c.available) {
          const reason = c.reason ? ` title="${escapeHtml(c.reason)}"` : "";
          ctaHtml = `<button class="btn btn-ghost" disabled${reason}>暂未配置</button>`;
        } else if (c.accessMode === "public_link" && c.link) {
          ctaHtml = `<a class="btn btn-primary" href="${escapeHtml(c.link)}" target="_blank" rel="noopener noreferrer">打开公开链接</a>`;
        } else if (c.accessMode === "invite_link_on_demand" && c.resourceId) {
          ctaHtml = `<button class="btn btn-primary" data-act="get-access" data-rid="${encodeURIComponent(c.resourceId)}">获取进入链接</button>`;
        } else {
          ctaHtml = `<button class="btn btn-ghost" disabled>暂不可用</button>`;
        }
        return `
          <div class="ent-item" data-channel-id="${escapeHtml(c.id)}">
            <div>
              <div class="ent-title">${escapeHtml(c.label)}</div>
              <div class="ent-sub">${escapeHtml(c.subtitle || "")}</div>
              <div class="ent-badges"><span class="tag" style="background:${tagBg}; color:${tagColor}; border-color:${tagBorder};">${tagText}</span></div>
            </div>
            <div>
              ${ctaHtml}
            </div>
          </div>
        `;
      }).join("");
      box.querySelectorAll('button[data-act="get-access"]').forEach((b) => {
        const rid = b.dataset.rid || "";
        if (!rid) return;
        b.addEventListener("click", () => {
          if (!ensureTelegramBound("h5_login_required_for_channel_access")) return;
          openChannelAccess(rid);
        });
      });
    } catch (err) {
      box.innerHTML = `<div class="error-box">加载我的频道失败：${zhMsg(err)}</div>`;
    }
  }

  async function handleContinueStars(orderNo) {
    showView("payDetail");
    const card = $("activatedCard");
    if (card) card.style.display = "none";
    setStatus("processing", "检查 Stars 续付条件…");
    const meta = $("orderMeta");
    if (meta) meta.textContent = "订单号 " + orderNo;

    let resp;
    try {
      resp = await api(`/api/orders/${encodeURIComponent(orderNo)}/continue-stars`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (err) {
      if (err.status === 401) {
        showView("unauth");
        return;
      }
      showError("Stars 续付失败：" + zhMsg(err));
      return;
    }

    if (!resp?.ok || !resp?.order?.invoiceLink) {
      showError("Stars 订单无法续付（订单可能已过期或不是 Stars 支付）：请回到 Telegram Mini App 中重新创建订单。");
      return;
    }

    const link = resp.order.invoiceLink;
    applyOrderData(resp.order);
    trackAnalytics("checkout_open", {
      orderNo: orderNo,
      productId: resp.order?.product?.id || null,
      paymentMethod: "telegram_stars",
    });
    if (tg && typeof tg.openInvoice === "function") {
      tg.openInvoice(link, function (status) {
        handleStarsInvoiceResult(orderNo, status);
      });
      return;
    }
    setStep(2);
    setStatus("processing", "已取得 Stars 发票链接");

    configurePaymentDetailMode(resp.order, { forceStars: true, invoiceFallback: true });

    const starsWrap = $("starsWrap");
    const starsContent = $("starsFallbackContent");
    if (starsWrap) starsWrap.style.display = "block";
    if (starsContent) {
      starsContent.innerHTML = `
        <div style="margin-bottom:8px; font-size:13px; color:#b9a7e6;">★ Stars 发票链接：</div>
        <div class="card-row" id="starsLinkRow" style="word-break:break-all; padding:10px 12px; font-size:12px; color:#e8dfff; background:rgba(180,112,255,.08); border:1px solid rgba(180,112,255,.2); border-radius:10px; user-select:text;">${escapeHtml(link)}</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px;">
          <button class="btn btn-primary" id="btnCopyStarsLink" type="button">📋 复制发票链接</button>
          <button class="btn btn-ghost" id="btnGotoMiniApp" type="button">📱 打开 Mini App 支付</button>
        </div>
        <div style="margin-top:10px; padding:8px 10px; border-radius:8px; background:rgba(255,170,90,.08); border:1px solid rgba(255,170,90,.18); color:#ffc98a; font-size:12px; line-height:1.5;">
          说明：由于当前是 H5 站外页面，浏览器无法直接调用 Telegram Stars 原生支付弹窗。请回到 Telegram 内，通过 Mini App 或复制上面的链接到 Telegram 对话中打开，即可唤起 Stars 支付。
        </div>
      `;
      const row = $("starsLinkRow");
      const copyBtn = $("btnCopyStarsLink");
      const gotoBtn = $("btnGotoMiniApp");
      if (copyBtn) copyBtn.addEventListener("click", () => { if (copyText(link)) flashBtnEl(copyBtn, "✓ 已复制"); });
      if (row) row.addEventListener("click", () => { if (copyText(link)) flashBtnEl(copyBtn || row, "✓ 已复制"); });
      if (gotoBtn) gotoBtn.addEventListener("click", () => {
        const qs = new URLSearchParams(location.search);
        qs.set("orderNo", orderNo);
        location.href = `./index.html?${qs.toString()}#view=orders`;
      });
    }
    startPolling(orderNo);
  }

  async function handleQueryOrder(orderNo) {
    showView("payDetail");
    const card = $("activatedCard");
    if (card) card.style.display = "none";
    setStatus("processing", "查询中…");
    const meta = $("orderMeta");
    if (meta) meta.textContent = "订单号 " + orderNo;
    try {
      const data = await api(`/api/orders/${encodeURIComponent(orderNo)}/status`);
      const order = data?.order || null;
      if (!order) {
        return showError(
          "未找到该订单（或未登录导致无法读取你的订单）。请回到 Telegram Mini App 中打开本页，或确认订单号正确。",
        );
      }
      applyOrderData(order);
      replaceCheckoutQuery({ orderNo: order.orderNo, paymentMethod: order.paymentMethod === "telegram_stars" ? "stars" : "usdt" });
      trackAnalytics("checkout_open", {
        orderNo: order.orderNo,
        productId: order.product?.id || null,
        paymentMethod: order.paymentMethod === "telegram_stars" ? "telegram_stars" : "usdt_trc20",
      });
      if (["pending", "processing"].includes(order.status)) startPolling(orderNo);
      if (order.status === "paid") {
        setStep(4);
        if (card) card.style.display = "block";
      }
    } catch (err) {
      if (err.status === 401) {
        showView("unauth");
        return;
      }
      showError("查询订单失败：" + zhMsg(err));
    }
  }

  async function handleCreateOrder(productId) {
    showView("payDetail");
    const card = $("activatedCard");
    if (card) card.style.display = "none";
    setStatus("processing", "创建中…");
    const meta = $("orderMeta");
    if (meta) meta.textContent = `商品 ID：${productId}`;
    try {
      trackAnalytics("payment_method_selected", { productId: productId, paymentMethod: "usdt_trc20" });
      const created = await api("/api/orders/usdt", {
        method: "POST",
        body: JSON.stringify({ productId }),
      });
      const order = Object.assign({}, created, {
        _h5Extra: { address: created.address },
        usdtPayment: created.usdtPayment || null,
      });
      applyOrderData(order);
      if (order.orderNo) {
        replaceCheckoutQuery({ orderNo: order.orderNo, productId, paymentMethod: "usdt" });
        $("orderNo").value = order.orderNo;
        trackAnalytics("order_created", { orderNo: order.orderNo, productId: productId, paymentMethod: "usdt_trc20" });
      }
      if (["pending", "processing"].includes(order.status || "pending")) {
        startPolling(created.orderNo);
      }
      if (order.status === "paid") {
        setStep(4);
        if (card) card.style.display = "block";
      }
    } catch (err) {
      if (err.status === 401) {
        showView("unauth");
        return;
      }
      showError("创建 USDT 支付订单失败：" + zhMsg(err));
    }
  }

  async function handleCreateStarsOrder(productId) {
    showView("payDetail");
    const card = $("activatedCard");
    if (card) card.style.display = "none";
    setStatus("processing", "创建 Stars 订单中…");
    const meta = $("orderMeta");
    if (meta) meta.textContent = `商品 ID：${productId}`;
    try {
      trackAnalytics("payment_method_selected", { productId: productId, paymentMethod: "telegram_stars" });
      const created = await api("/api/orders/stars", {
        method: "POST",
        body: JSON.stringify({ productId }),
      });
      const order = created?.created || created?.order || null;
      if (!order?.orderNo || !order?.invoiceLink) {
        showError("未获得有效的 Stars 发票链接。");
        return;
      }
      applyOrderData(order);
      replaceCheckoutQuery({ orderNo: order.orderNo, productId, paymentMethod: "stars" });
      $("orderNo").value = order.orderNo;
      trackAnalytics("order_created", { orderNo: order.orderNo, productId: productId, paymentMethod: "telegram_stars" });
      if (tg && typeof tg.openInvoice === "function") {
        tg.openInvoice(order.invoiceLink, function (status) {
          handleStarsInvoiceResult(order.orderNo, status);
        });
        return;
      }
      await handleContinueStars(order.orderNo);
    } catch (err) {
      if (err.status === 401) {
        showView("unauth");
        return;
      }
      showError("创建 Stars 支付订单失败：" + zhMsg(err));
    }
  }

  function flashBtnEl(btn, txt) {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = txt;
    setTimeout(() => (btn.textContent = old), 1500);
  }
  function flashBtnById(id, txt) {
    flashBtnEl($(id), txt);
  }

  function bindCopyAndNav() {
    const addr = $("addrText");
    function copyAddrFn() {
      if (copyText(lastAddress || (addr && addr.textContent) || "")) {
        flashBtnById("btnCopyAddr", "✓ 已复制");
      }
    }
    function copyAmountFn() {
      const amtEl = document.getElementById("payAmount");
      const t = amtEl?.innerText?.replace(/[^0-9.]/g, "") || "";
      if (!t) return;
      if (copyText(t)) flashBtnById("btnCopyAmount", "✓ 已复制");
    }
    if (addr) addr.addEventListener("click", copyAddrFn);
    $("btnCopyAddr")?.addEventListener("click", copyAddrFn);
    $("btnCopyAmount")?.addEventListener("click", copyAmountFn);
    $("copyAmountBtn")?.addEventListener("click", copyAmountFn);

    $("btnRefreshStatus")?.addEventListener("click", () => {
      const qs = new URLSearchParams(location.search);
      const on = qs.get("orderNo") || ($("orderNo") && $("orderNo").value.trim());
      if (on) handleQueryOrder(on);
    });

    $("btnBackProfile")?.addEventListener("click", () => {
      stopPolling();
      showView("orders");
    });
    $("btnBackMiniApp")?.addEventListener("click", () => {
      if (!currentIdentitySession?.telegramBound) {
        const returnTo = encodeURIComponent(location.pathname + location.search + location.hash);
        location.href = `/login.html?redirect=${returnTo}`;
        return;
      }
      location.href = "./index.html#view=entitlements";
    });
  }

  function bindTabBar() {
    const bar = $("tabBar");
    if (!bar) return;
    bar.querySelectorAll(".t").forEach((t) => {
      t.addEventListener("click", () => {
        const tab = t.dataset.tab;
        if (tab === "orders") showView("orders");
        else if (tab === "entitlements") { showView("entitlements"); loadEntitlements().catch(() => {}); }
        else if (tab === "channels") { showView("channels"); loadChannels().catch(() => {}); }
        else if (tab === "pay") {
          const qs = new URLSearchParams(location.search);
          const on = qs.get("orderNo") || ($("orderNo") && $("orderNo").value.trim());
          if (on) handleQueryOrder(on);
          else showView("payDetail");
        }
      });
    });
  }

  function bindQuickActions() {
    $("btnCreateStarsOrder")?.addEventListener("click", () => {
      const p = ($("productId") && $("productId").value.trim()) || "";
      if (!p) {
        showError("请先填写产品 ID。");
        return;
      }
      handleCreateStarsOrder(p);
    });
    $("btnCreateOrder")?.addEventListener("click", () => {
      const p = ($("productId") && $("productId").value.trim()) || "";
      if (!p) {
        showError("请先填写产品 ID。");
        return;
      }
      handleCreateOrder(p);
    });
    $("btnGotoOrder")?.addEventListener("click", () => {
      const on = ($("orderNo") && $("orderNo").value.trim()) || "";
      if (!on) {
        showError("请先填写订单号。");
        return;
      }
      handleQueryOrder(on);
    });
  }

  function refreshCurrentOrderAfterForeground() {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - lastForegroundRefreshAt < 1200) return;
    const orderNo = currentOrderNoFromQs() || ($("orderNo") && $("orderNo").value.trim());
    if (!orderNo) return;
    lastForegroundRefreshAt = now;
    // 手机钱包/扫码器返回浏览器后，定时器可能被系统暂停；这里立即向服务端重新查单。
    handleQueryOrder(orderNo);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindCopyAndNav();
    bindTabBar();
    bindQuickActions();
    await boot();
    document.addEventListener("visibilitychange", refreshCurrentOrderAfterForeground);
    window.addEventListener("focus", refreshCurrentOrderAfterForeground);
    window.addEventListener("pageshow", refreshCurrentOrderAfterForeground);
  });
})();
