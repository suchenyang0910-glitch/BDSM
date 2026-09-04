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
    watch: {
      loading: false,
      loaded: false,
      recent: null,
      history: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    },
    articles: {
      loading: false,
      loaded: false,
      items: [],
      details: {},
    },
    community: {
      loading: false,
      loaded: false,
      imageUploadEnabled: false,
      items: [],
      nextCursor: null,
      detailCache: {},
      myPostsLoading: false,
      myPostsLoaded: false,
      myPosts: [],
      myPostsNextCursor: null,
    },
    player: {
      contentId: "",
      video: null,
      lastProgressSecond: -1,
      started: false,
      managed: false,
      playbackSessionId: "",
      deliveryVariant: "",
      hls: null,
      currentQuality: "auto",
      bufferStartedAt: 0,
      playRequestedAt: 0,
      prefetchContentId: "",
      prefetchedSession: null,
    },
    trafficEntry: null,
    resumeIntent: null,
    route: {
      tab: "home",
      view: "tab",
      id: "",
      fromTab: "home",
    },
    interactions: {},
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

  // Keep a failed legacy cover from collapsing the card or rendering a broken
  // image glyph. The original object URL is never exposed as a fallback.
  document.addEventListener("error", function (event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.dataset.fallbackApplied === "1") return;
    image.dataset.fallbackApplied = "1";
    image.removeAttribute("src");
    image.classList.add("is-image-unavailable");
  }, true);

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

  function currentTrafficEntryPayload() {
    if (!state.trafficEntry || !state.trafficEntry.code) return null;
    return {
      trafficEntryCode: state.trafficEntry.code,
      entryType: state.trafficEntry.entryType,
      destinationType: state.trafficEntry.destinationType,
      destinationId: state.trafficEntry.destinationId,
    };
  }

  function shouldAttachTrafficEntry(eventName) {
    return [
      "session_started",
      "content_opened",
      "article_opened",
      "preview_started",
      "preview_completed",
      "playback_started",
      "playback_completed",
      "unlock_clicked",
      "checkout_open",
      "payment_method_selected",
      "payment_confirmed",
    ].indexOf(eventName) >= 0;
  }

  function trackAnalytics(eventName, payload) {
    var mergedPayload = payload || {};
    if (shouldAttachTrafficEntry(eventName)) {
      mergedPayload = Object.assign({}, currentTrafficEntryPayload() || {}, mergedPayload);
    }
    // 仅发送白名单事件与最小业务字段；服务端会再次校验、哈希化并丢弃未知字段。
    requestWithCompatibility("/api/analytics/events", {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ events: [{ eventName: eventName, payload: Object.assign({ platform: state.env.isTelegram ? "telegram_mini_app" : "h5" }, mergedPayload) }] }),
    }).catch(function () {});
  }

  function getDetailPlaybackStatus(detail) {
    return detail && detail.playbackStatus && typeof detail.playbackStatus === "object"
      ? detail.playbackStatus
      : null;
  }

  function hasManagedPlayback(detail) {
    const playback = getDetailPlaybackStatus(detail);
    return !!(playback && !playback.errorClass && (playback.action === "preview" || playback.action === "play_full"));
  }

  function canUseNativeHls(video) {
    if (!video || typeof video.canPlayType !== "function") return false;
    return /maybe|probably/i.test(video.canPlayType("application/vnd.apple.mpegurl")) ||
      /maybe|probably/i.test(video.canPlayType("application/x-mpegURL"));
  }

  function destroyManagedHls() {
    const active = state.player.hls;
    if (active && typeof active.destroy === "function") {
      try { active.destroy(); } catch (_) {}
    }
    state.player.hls = null;
  }

  function clearManagedPlaybackState() {
    destroyManagedHls();
    state.player.managed = false;
    state.player.playbackSessionId = "";
    state.player.deliveryVariant = "";
    state.player.currentQuality = "auto";
    state.player.bufferStartedAt = 0;
    state.player.playRequestedAt = 0;
  }

  function reportPlaybackError(detail, errorCode) {
    trackAnalytics("playback_error", {
      contentId: detail && detail.id ? detail.id : null,
      deliveryVariant: state.player.deliveryVariant || null,
      errorCode: errorCode || "unknown",
    });
  }

  function currentPlaybackSource(detail) {
    return state.player.deliveryVariant === "full"
      ? "full_play"
      : (hasManagedPlayback(detail) ? "preview_play" : "preview_prefetch");
  }

  function detectPlaybackNetworkPolicy() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    const effectiveType = conn && typeof conn.effectiveType === "string" ? conn.effectiveType : "";
    const saveData = !!(conn && conn.saveData);
    const constrained = saveData || /(^|[^a-z])(slow-2g|2g|3g)([^a-z]|$)/i.test(effectiveType);
    const cellular = /(^|[^a-z])(cellular|2g|3g)([^a-z]|$)/i.test(effectiveType);
    return {
      saveData: saveData,
      constrained: constrained,
      cellular: cellular,
      defaultQuality: constrained ? "480p" : "720p",
      maxForwardBufferSec: constrained ? 6 : 15,
      prefetchSegmentCount: constrained ? 1 : 2,
      qualityReason: saveData ? "save_data" : cellular ? "cellular" : "startup",
    };
  }

  function inferQualityLabelFromHeight(height) {
    const value = Number(height || 0);
    if (value >= 900) return "1080p";
    if (value >= 600) return "720p";
    if (value >= 360) return "480p";
    return "preview";
  }

  function trackManagedAnalytics(detail, eventName, payload) {
    trackAnalytics(eventName, Object.assign({
      contentId: detail && detail.id ? detail.id : null,
      sessionId: state.player.playbackSessionId || null,
      quality: state.player.currentQuality || "auto",
      source: currentPlaybackSource(detail),
    }, payload || {}));
  }

  function createManagedRequest(url, init) {
    return new Request(url, Object.assign({}, init || {}, {
      credentials: "include",
      cache: "no-store",
      headers: Object.assign({}, (init && init.headers) || {}, {
        "Cache-Control": state.player.deliveryVariant === "full" ? "no-store" : "no-cache",
        Pragma: "no-cache",
      }),
    }));
  }

  function findPreferredLevelIndex(levels, qualityLabel) {
    var preferredHeight = qualityLabel === "480p" ? 480 : qualityLabel === "720p" ? 720 : 1080;
    var found = -1;
    for (var i = 0; i < levels.length; i += 1) {
      if (Number(levels[i].height || 0) <= preferredHeight) found = i;
    }
    return found >= 0 ? found : Math.max(0, Math.min(levels.length - 1, qualityLabel === "480p" ? 0 : 1));
  }

  async function prefetchManagedManifest(detail, manifestUrl, sessionId) {
    try {
      const manifestRes = await requestWithCompatibility(manifestUrl, {
        credentials: "include",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      });
      if (!manifestRes.ok) throw new Error("prefetch_manifest_failed");
      const manifestText = await manifestRes.text();
      const targets = [];
      var mapLine = manifestText.match(/#EXT-X-MAP:.*URI="([^"]+)"/i);
      if (mapLine && mapLine[1]) targets.push(new URL(mapLine[1], manifestUrl).toString());
      manifestText.split(/\r?\n/).forEach(function (line) {
        var value = String(line || "").trim();
        if (!value || value.charAt(0) === "#") return;
        if (/\.m3u8($|\?)/i.test(value)) return;
        if (targets.length >= detectPlaybackNetworkPolicy().prefetchSegmentCount + (mapLine ? 1 : 0)) return;
        targets.push(new URL(value, manifestUrl).toString());
      });
      for (var i = 0; i < targets.length; i += 1) {
        await requestWithCompatibility(targets[i], {
          credentials: "include",
          cache: "no-store",
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        });
      }
      trackAnalytics("playback_prefetch_result", {
        contentId: detail.id,
        sessionId: sessionId,
        quality: "preview",
        result: "hit",
        source: "preview_prefetch",
      });
    } catch (_) {
      trackAnalytics("playback_prefetch_result", {
        contentId: detail.id,
        sessionId: sessionId,
        quality: "preview",
        result: "error",
        source: "preview_prefetch",
      });
    }
  }

  async function prefetchDetailPreview(detail) {
    if (!detail || state.player.prefetchContentId === detail.id) return;
    const playback = getDetailPlaybackStatus(detail);
    if (!playback || playback.action !== "preview" || playback.errorClass || !state.session || !state.session.userId) return;
    state.player.prefetchContentId = detail.id;
    try {
      const prefetched = await apiCall("/api/contents/" + encodeURIComponent(detail.id) + "/playback-session", {
        method: "POST",
        body: JSON.stringify({ purpose: "prefetch" }),
      });
      if (prefetched && prefetched.sessionId && prefetched.manifestUrl) {
        state.player.prefetchedSession = {
          contentId: detail.id,
          sessionId: prefetched.sessionId,
          manifestUrl: prefetched.manifestUrl,
          deliveryVariant: prefetched.deliveryVariant || "preview",
          expiresAt: prefetched.expiresAt || null,
        };
      }
      await prefetchManagedManifest(detail, prefetched.manifestUrl, prefetched.sessionId || "");
    } catch (_) {
      state.player.prefetchContentId = "";
      state.player.prefetchedSession = null;
      trackAnalytics("playback_prefetch_result", {
        contentId: detail.id,
        sessionId: null,
        quality: "preview",
        result: "miss",
        source: "preview_prefetch",
      });
    }
  }

  function loadManagedVideoSource(video, manifestUrl, detail) {
    destroyManagedHls();
    try { video.pause(); } catch (_) {}
    try { video.removeAttribute("src"); video.load(); } catch (_) {}
    state.player.playRequestedAt = Date.now();
    state.player.currentQuality = state.player.deliveryVariant === "full" ? detectPlaybackNetworkPolicy().defaultQuality : "preview";

    if (canUseNativeHls(video)) {
      video.src = manifestUrl;
      video.load();
      trackManagedAnalytics(detail, "playback_manifest_ready");
      return;
    }

    const HlsCtor = window.Hls;
    if (HlsCtor && typeof HlsCtor.isSupported === "function" && HlsCtor.isSupported()) {
      const networkPolicy = detectPlaybackNetworkPolicy();
      const hls = new HlsCtor({
        enableWorker: true,
        maxBufferLength: networkPolicy.maxForwardBufferSec,
        maxMaxBufferLength: networkPolicy.maxForwardBufferSec,
        backBufferLength: 15,
        fetchSetup: function (context, init) {
          return createManagedRequest(context.url, init);
        },
        xhrSetup: function (xhr) {
          xhr.withCredentials = true;
          try {
            xhr.setRequestHeader("Cache-Control", state.player.deliveryVariant === "full" ? "no-store" : "no-cache");
            xhr.setRequestHeader("Pragma", "no-cache");
          } catch (_) {}
        },
      });
      state.player.hls = hls;
      if (HlsCtor.Events && typeof hls.on === "function") {
        hls.on(HlsCtor.Events.MANIFEST_PARSED, function (_, data) {
          const levels = (data && data.levels) || [];
          const preferredLevel = findPreferredLevelIndex(levels, networkPolicy.defaultQuality);
          if (state.player.deliveryVariant === "full") {
            hls.autoLevelCapping = Math.min(preferredLevel, levels.length - 1);
            hls.startLevel = preferredLevel;
            state.player.currentQuality = networkPolicy.defaultQuality;
          } else {
            state.player.currentQuality = "preview";
          }
          trackManagedAnalytics(detail, "playback_manifest_ready");
        });
        hls.on(HlsCtor.Events.LEVEL_SWITCHED, function (_, data) {
          var fromQuality = state.player.currentQuality || "auto";
          var level = typeof data.level === "number" ? hls.levels[data.level] : null;
          var toQuality = level ? inferQualityLabelFromHeight(level.height) : fromQuality;
          if (toQuality !== fromQuality) {
            state.player.currentQuality = toQuality;
            trackManagedAnalytics(detail, "playback_quality_change", {
              fromQuality: fromQuality,
              toQuality: toQuality,
              reason: detectPlaybackNetworkPolicy().qualityReason,
            });
          }
        });
        hls.on(HlsCtor.Events.ERROR, function (_, data) {
          if (!data || !data.fatal) return;
          reportPlaybackError(detail, data.type || data.details || "hls_error");
          showInlineMessage("视频播放中断，请稍后重试。");
          destroyManagedHls();
        });
      }
      hls.loadSource(manifestUrl);
      hls.attachMedia(video);
      return;
    }

    video.src = manifestUrl;
    video.load();
  }

  function postManagedPlayback(sessionId, endpointSuffix, payload, detail) {
    if (!sessionId) return Promise.resolve(null);
    return apiCall("/api/playback-sessions/" + encodeURIComponent(sessionId) + endpointSuffix, {
      method: "POST",
      body: JSON.stringify(payload),
    }).catch(function (err) {
      reportPlaybackError(detail, err && err.payload ? (err.payload.error || err.payload.errorClass) : "playback_request_failed");
      if (err && err.payload && err.payload.error === "playback_session_inactive") {
        clearManagedPlaybackState();
      }
      return null;
    });
  }

  function writePlayerProgress(detail, payload) {
    if (state.player.managed && state.player.playbackSessionId) {
      const isEndEvent = payload.eventName === "leave" || payload.eventName === "complete";
      return postManagedPlayback(
        state.player.playbackSessionId,
        isEndEvent ? "/end" : "/heartbeat",
        {
          eventName: payload.eventName === "start"
            ? "start"
            : payload.eventName === "pause"
              ? "pause"
              : payload.eventName === "complete"
                ? "complete"
                : "progress",
          positionSec: payload.positionSec || 0,
          durationSec: payload.durationSec || null,
          quality: payload.quality || state.player.currentQuality || "auto",
        },
        detail,
      );
    }
    return writeWatchProgress(detail.id, payload);
  }

  function playInlineDetailVideo() {
    const video = $("detailContent").querySelector(".detail-preview-video");
    if (!video) {
      showInlineMessage("当前内容暂未准备好播放器。");
      return;
    }
    const playback = video.play();
    if (playback && typeof playback.catch === "function") playback.catch(function () {});
  }

  async function startManagedPlayback(detail) {
    const video = $("detailContent").querySelector(".detail-preview-video");
    if (!video) {
      showInlineMessage("当前内容暂未准备好播放器。");
      return;
    }
    if (state.player.managed && state.player.playbackSessionId && state.player.contentId === detail.id) {
      playInlineDetailVideo();
      return;
    }
    const prefetched = state.player.prefetchedSession;
    let created = prefetched && prefetched.contentId === detail.id ? prefetched : null;
    if (created) state.player.prefetchedSession = null;
    try {
      if (!created) {
        created = await apiCall("/api/contents/" + encodeURIComponent(detail.id) + "/playback-session", {
          method: "POST",
          body: JSON.stringify({}),
        });
      }
    } catch (err) {
      reportPlaybackError(detail, err && err.payload ? (err.payload.error || err.payload.errorClass) : "playback_session_failed");
      if (detail.previewUrl) {
        showInlineMessage("Web 受控播放尚未开放，先为你展示当前试看。");
        playInlineDetailVideo();
        return;
      }
      if (detail.unlocked) {
        showInlineMessage("完整 Web 播放仍保持关闭，请先使用 Telegram 备用观看。");
        return;
      }
      showInlineMessage("创建播放会话失败：" + apiText(err));
      return;
    }

    state.player.managed = true;
    state.player.playbackSessionId = created.sessionId || "";
    state.player.deliveryVariant = created.deliveryVariant || "";
    loadManagedVideoSource(video, created.manifestUrl, detail);
    const gate = $("previewUpgradeGate");
    if (gate) gate.classList.add("is-hidden");
    const playback = video.play();
    if (playback && typeof playback.catch === "function") playback.catch(function () {});
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
    const fallbackTitle = "同频 · 精选点播";
    const fallbackDescription = "同频内容目录与权益入口";
    const title = seo && seo.title ? seo.title : fallbackTitle;
    const description = seo && seo.description ? seo.description : fallbackDescription;
    const keywordItems = [];
    if (seo && Array.isArray(seo.keywords)) keywordItems.push.apply(keywordItems, seo.keywords);
    if (seo && Array.isArray(seo.geoKeywords)) keywordItems.push.apply(keywordItems, seo.geoKeywords);
    const keywords = Array.from(new Set(keywordItems.map(function (item) { return String(item || "").trim(); }).filter(Boolean))).join(",");
    const geoKeywords = seo && Array.isArray(seo.geoKeywords) ? seo.geoKeywords.join(",") : "";
    document.title = title;
    setMetaContent('meta[name="description"]', { name: "description" }, description);
    setMetaContent('meta[name="keywords"]', { name: "keywords" }, keywords);
    setMetaContent('meta[name="geo.keywords"]', { name: "geo.keywords" }, geoKeywords);
    setMetaContent('meta[name="robots"]', { name: "robots" }, seo && seo.robots ? seo.robots : "noindex,nofollow");
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

  function clearLandingQueryParams() {
    const url = new URL(window.location.href);
    ["content", "te", "category", "package", "membership", "article"].forEach(function (key) {
      url.searchParams.delete(key);
    });
    window.history.replaceState(null, "", url.pathname + (url.search || ""));
  }

  function parseHash() {
    // Telegram 免费频道/H5 外链使用 ?content=<UUID>；查询参数优先于首页 hash，
    // 确保用户点击推广链接时直接进入对应内容详情，而不是落回首页。
    const queryParams = new URLSearchParams(window.location.search);
    const queryContentId = queryParams.get("content");
    if (queryContentId) {
      return { view: "detail", id: queryContentId, tab: "home", fromTab: "home" };
    }
    const queryCategoryId = queryParams.get("category");
    if (queryCategoryId) {
      return { view: "tab", id: "", tab: "library", fromTab: "home", categoryId: queryCategoryId };
    }
    const queryPackageId = queryParams.get("package");
    if (queryPackageId) {
      return { view: "tab", id: "", tab: "me", fromTab: "home", packageId: queryPackageId };
    }
    if (queryParams.get("membership") === "1") {
      return { view: "tab", id: "", tab: "me", fromTab: "home" };
    }
    const queryArticle = queryParams.get("article");
    if (queryArticle) return { view: "article", id: queryArticle, tab: "community", fromTab: "community", communitySection: "articles" };
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
    if (params.get("view") === "article" && params.get("id")) {
      return { view: "article", id: params.get("id") || "", tab: "community", fromTab: params.get("from") || "community", communitySection: "articles" };
    }
    if (params.get("view") === "community" && params.get("id")) {
      return { view: "community", id: params.get("id") || "", tab: "community", fromTab: params.get("from") || "community" };
    }
    const rawTab = params.get("tab") || "home";
    const articleTab = rawTab === "articles";
    const tab = articleTab ? "community" : (rawTab === "membership" ? "me" : rawTab);
    return { view: "tab", id: "", tab: tab, fromTab: articleTab ? "community" : rawTab, communitySection: articleTab || params.get("section") === "articles" ? "articles" : "posts" };
  }

  function setHashForTab(tab) {
    clearLandingQueryParams();
    const params = new URLSearchParams();
    const articleTab = tab === "articles";
    params.set("tab", articleTab ? "community" : tab);
    if (articleTab) params.set("section", "articles");
    window.location.hash = params.toString();
  }

  function setHashForDetail(id, fromTab) {
    clearLandingQueryParams();
    const params = new URLSearchParams();
    params.set("view", "content");
    params.set("id", id);
    params.set("from", fromTab || "home");
    window.location.hash = params.toString();
  }

  function setHashForHistory(fromTab) {
    clearLandingQueryParams();
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
    const toast = $("inlineToast");
    if (!toast) return;
    toast.textContent = String(message || "请稍后重试。");
    toast.classList.remove("is-hidden");
    if (state.inlineToastTimer) window.clearTimeout(state.inlineToastTimer);
    state.inlineToastTimer = window.setTimeout(function () {
      toast.classList.add("is-hidden");
    }, 5000);
  }

  function setHashForArticle(slug, fromTab) {
    clearLandingQueryParams();
    const params = new URLSearchParams();
    params.set("view", "article");
    params.set("id", slug);
    params.set("from", fromTab || "community");
    window.location.hash = params.toString();
  }

  function setHashForCommunityDetail(id, fromTab) {
    clearLandingQueryParams();
    const params = new URLSearchParams();
    params.set("view", "community");
    params.set("id", id);
    params.set("from", fromTab || "community");
    window.location.hash = params.toString();
  }

  function openCommunityPost(id) {
    setHashForCommunityDetail(id, "community");
  }

  function formatArticleDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime())
      ? date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0")
      : "";
  }

  async function loadArticles() {
    if (state.articles.loading || state.articles.loaded) return;
    state.articles.loading = true;
    try {
      const data = await apiCall("/api/articles");
      state.articles.items = Array.isArray(data && data.items) ? data.items : [];
      state.articles.loaded = true;
    } catch (err) {
      if ($("articlesState")) $("articlesState").textContent = "文章加载失败：" + apiText(err);
    } finally {
      state.articles.loading = false;
      renderArticles();
    }
  }

  function renderArticles() {
    const host = $("articlesList");
    const stateNode = $("articlesState");
    if (!host || !stateNode || !state.articles.loaded) return;
    stateNode.classList.toggle("is-hidden", state.articles.items.length > 0);
    stateNode.textContent = state.articles.items.length ? "" : "暂无文章。";
    host.innerHTML = state.articles.items.map(function (item) {
      const topics = (item.topics || []).slice(0, 3).map(function (topic) { return '<span class="article-topic">' + escapeHtml(topic) + "</span>"; }).join("");
      return '<button class="article-card" type="button" data-article-slug="' + escapeHtml(item.slug) + '">' +
        (item.coverImageUrl ? '<img class="article-card-cover" src="' + escapeHtml(item.coverImageUrl) + '" alt="' + escapeHtml(item.title) + '" loading="lazy">' : "") +
        '<div class="article-card-top">' + topics + '<span>' + escapeHtml(formatArticleDate(item.updatedAt || item.publishedAt)) + "</span></div>" +
        "<h3>" + escapeHtml(item.title) + "</h3><p class=\"muted-copy\">" + escapeHtml(item.summary) + "</p>" +
        '<span class="text-button">阅读中文导读 ›</span></button>';
    }).join("");
    host.querySelectorAll("[data-article-slug]").forEach(function (button) {
      button.addEventListener("click", function () { setHashForArticle(button.getAttribute("data-article-slug"), "articles"); });
    });
  }

  async function renderArticleDetail(slug) {
    const host = $("articleDetailContent");
    if (!host) return;
    host.innerHTML = '<div class="inline-state">正在加载文章…</div>';
    try {
      let item = state.articles.details[slug];
      if (!item) {
        item = await apiCall("/api/articles/" + encodeURIComponent(slug));
        state.articles.details[slug] = item;
      }
      if (state.route && state.route.view === "article" && state.route.id === slug) {
        $("headerTitle").textContent = item.title || "文章详情";
        $("headerSubtitle").textContent = item.summary || "文章导读";
      }
      updatePageSeo(item.seo);
      trackAnalytics("article_opened", { articleSlug: item.slug || slug, sourceModule: "articles" });
      const topics = (item.topics || []).map(function (topic) { return '<span class="article-topic">' + escapeHtml(topic) + "</span>"; }).join("");
      host.innerHTML = '<div class="article-detail-meta">' + topics + '<span>' + escapeHtml(formatArticleDate(item.updatedAt || item.publishedAt)) + "</span></div>" +
        (item.coverImageUrl ? '<img class="article-detail-cover" src="' + escapeHtml(item.coverImageUrl) + '" alt="' + escapeHtml(item.title) + '">' : "") +
        "<h2>" + escapeHtml(item.title) + "</h2><p class=\"muted-copy\">" + escapeHtml(item.summary) + "</p>" +
        '<div class="article-html-body">' + String(item.bodyHtml || "") + "</div>" +
        renderInteractionPanelShell("article", {
          targetType: "article",
          targetId: item.id || "",
          title: item.title || "文章",
          emptyHint: item.id ? "" : "当前文章处于静态应急模式，互动暂不可用。",
        }) +
        '<footer class="article-attribution">归属：SAMEWAVE</footer>';
      if (item.id) {
        initializeInteractionPanel("article", {
          targetType: "article",
          targetId: item.id,
          title: item.title || "文章",
        });
      }
    } catch (err) {
      host.innerHTML = '<div class="inline-state">文章加载失败：' + escapeHtml(apiText(err)) + "</div>";
    }
  }

  function communityStatusMeta(status) {
    return {
      pending: { label: "审核中", className: "is-pending" },
      rejected: { label: "已驳回", className: "is-rejected" },
      published: { label: "已发布", className: "is-published" },
      hidden: { label: "已隐藏", className: "is-hidden" },
      removed: { label: "已删除", className: "is-removed" },
    }[status] || { label: status || "未知", className: "" };
  }

  function parseCommunityTopics(raw) {
    return String(raw || "")
      .split(/[,\n，;；]+/)
      .map(function (item) { return item.trim().replace(/^#+/g, ""); })
      .filter(Boolean)
      .slice(0, 5);
  }

  function formatCommunityDate(value) {
    return formatArticleDate(value);
  }

  function renderCommunityAuthorAvatar(author) {
    const name = author && author.displayName ? String(author.displayName) : "同";
    if (author && author.photoUrl) {
      return '<span class="community-author-avatar">' + imageTag(author.photoUrl, "", name, true) + "</span>";
    }
    return '<span class="community-author-avatar">' + escapeHtml(name.slice(0, 1).toUpperCase()) + "</span>";
  }

  async function digestSha256Base64(file) {
    const buffer = await file.arrayBuffer();
    const hash = await window.crypto.subtle.digest("SHA-256", buffer);
    var binary = "";
    Array.from(new Uint8Array(hash)).forEach(function (byte) {
      binary += String.fromCharCode(byte);
    });
    return window.btoa(binary);
  }

  async function uploadCommunityImages(postId, files) {
    const selected = Array.prototype.slice.call(files || []).slice(0, 9);
    for (const file of selected) {
      const init = await apiCall("/api/community/posts/" + encodeURIComponent(postId) + "/assets/upload-session", {
        method: "POST",
        body: JSON.stringify({
          kind: "image",
          filename: file.name || "image.jpg",
          mimeType: file.type || "image/jpeg",
          byteSize: file.size,
          sha256: await digestSha256Base64(file),
        }),
      });
      const uploadResp = await fetch(init.uploadUrl, {
        method: "PUT",
        headers: Object.assign({}, init.expectedHttpHeaders || {}),
        body: file,
      });
      if (!uploadResp.ok) throw new Error("community_upload_failed");
      await apiCall("/api/community/upload-sessions/" + encodeURIComponent(init.uploadSessionId) + "/complete", {
        method: "POST",
        body: JSON.stringify({}),
      });
    }
  }

  async function loadCommunityFeed(nextCursor) {
    if (state.community.loading) return;
    state.community.loading = true;
    try {
      const params = new URLSearchParams();
      params.set("limit", "10");
      if (nextCursor) params.set("cursor", nextCursor);
      const data = await apiCall("/api/community/posts?" + params.toString());
      if (data && data.capabilities) state.community.imageUploadEnabled = !!data.capabilities.imageUploadEnabled;
      const items = Array.isArray(data && data.items) ? data.items : [];
      state.community.items = nextCursor ? state.community.items.concat(items) : items;
      state.community.nextCursor = data && data.nextCursor ? data.nextCursor : null;
      state.community.loaded = true;
      if ($("communityState")) $("communityState").textContent = items.length || nextCursor ? "" : "暂无已发布帖子。";
    } catch (err) {
      if ($("communityState")) $("communityState").textContent = "社区加载失败：" + apiText(err);
    } finally {
      state.community.loading = false;
      renderCommunityFeed();
    }
  }

  async function loadMyCommunityPosts(nextCursor) {
    if (!state.session || !state.session.userId) {
      showInlineMessage("登录后即可查看我的帖子。");
      return;
    }
    if (state.community.myPostsLoading) return;
    state.community.myPostsLoading = true;
    try {
      const params = new URLSearchParams();
      params.set("limit", "10");
      if (nextCursor) params.set("cursor", nextCursor);
      const data = await apiCall("/api/community/me/posts?" + params.toString());
      const items = Array.isArray(data && data.items) ? data.items : [];
      state.community.myPosts = nextCursor ? state.community.myPosts.concat(items) : items;
      state.community.myPostsNextCursor = data && data.nextCursor ? data.nextCursor : null;
      state.community.myPostsLoaded = true;
      $("communityMyPostsSection").classList.remove("is-hidden");
      $("communityMyPostsState").textContent = items.length || nextCursor ? "" : "你还没有发布过帖子。";
    } catch (err) {
      $("communityMyPostsSection").classList.remove("is-hidden");
      $("communityMyPostsState").textContent = "我的帖子加载失败：" + apiText(err);
    } finally {
      state.community.myPostsLoading = false;
      renderMyCommunityPosts();
    }
  }

  function renderCommunityMedia(items, detailMode) {
    const assets = Array.isArray(items) ? items.filter(Boolean) : [];
    const imageAssets = assets.filter(function (item) { return item.kind === "image" && item.imageUrl; });
    if (!imageAssets.length) return "";
    const cls = "community-media-grid community-media-grid-count-" + imageAssets.length;
    return '<div class="' + cls + '">' + imageAssets.map(function (asset) {
      const imgClass = detailMode ? "community-detail-image" : "community-media-image";
      return '<button class="community-media-tile" type="button" data-community-image="' + escapeHtml(asset.imageUrl) + '">' +
        '<img class="' + imgClass + '" src="' + escapeHtml(asset.imageUrl) + '" alt="圈子图片" loading="lazy">' +
        "</button>";
    }).join("") + "</div>";
  }

  function renderCommunityCard(item, options) {
    const statusMeta = communityStatusMeta(item.status);
    const topics = (item.topics || []).slice(0, 5).map(function (topic) { return '<span class="community-topic-chip">#' + escapeHtml(topic) + "</span>"; }).join("");
    const actionText = options && options.mine ? "查看审核详情" : "查看帖子";
    const canEdit = !!(options && options.mine && (item.status === "pending" || item.status === "rejected"));
    const canDelete = !!(options && options.mine && item.status !== "removed");
    return '<article class="community-card">' +
      '<div class="community-card-head">' +
        '<div class="community-card-author">' +
          renderCommunityAuthorAvatar(item.author || null) +
          '<div><strong>' + escapeHtml(item.author && item.author.displayName ? item.author.displayName : "同频成员") + '</strong>' +
          (item.isOfficial ? '<span class="community-author-label">官方</span>' : '') +
          (item.aiAssisted ? '<span class="community-author-label">AI 协助</span>' : '') +
          '<div class="muted-copy">' + escapeHtml(formatCommunityDate(item.publishedAt || item.createdAt)) + '</div></div>' +
        "</div>" +
        '<span class="community-status-badge ' + statusMeta.className + '">' + escapeHtml(statusMeta.label) + "</span>" +
      "</div>" +
      (topics ? '<div class="community-card-topics">' + topics + "</div>" : "") +
      '<p class="community-card-body">' + escapeHtml(item.summary || item.body || "") + "</p>" +
      renderCommunityMedia(item.assets || [], false) +
      (options && options.mine && item.moderationReason ? '<p class="muted-copy">审核说明：' + escapeHtml(item.moderationReason) + "</p>" : "") +
      '<div class="community-card-actions"><div class="interaction-summary-copy"><strong>' + escapeHtml(item.reactionCount || 0) + '</strong><span>赞</span><strong>' + escapeHtml(item.commentCount || 0) + '</strong><span>评论</span></div><div class="community-card-action-buttons">' +
      (canEdit ? '<button class="ghost-button" type="button" data-community-edit="' + escapeHtml(item.id) + '">编辑</button>' : "") +
      (canDelete ? '<button class="ghost-button" type="button" data-community-delete="' + escapeHtml(item.id) + '">删除</button>' : "") +
      '<button class="text-button" type="button" data-community-open="' + escapeHtml(item.id) + '">' + actionText + ' ›</button></div></div>' +
    "</article>";
  }

  function renderCommunityFeed() {
    const host = $("communityFeed");
    const stateNode = $("communityState");
    if (!host || !stateNode || !state.community.loaded) return;
    stateNode.classList.toggle("is-hidden", state.community.items.length > 0);
    stateNode.textContent = state.community.items.length ? "" : "暂无已发布帖子。";
    host.innerHTML = state.community.items.map(function (item) { return renderCommunityCard(item, { mine: false }); }).join("");
    $("communityLoadMoreButton").classList.toggle("is-hidden", !state.community.nextCursor);
    host.querySelectorAll("[data-community-open]").forEach(function (button) {
      button.addEventListener("click", function () {
        openCommunityPost(button.getAttribute("data-community-open"));
      });
    });
  }

  function renderMyCommunityPosts() {
    const host = $("communityMyPostsList");
    const stateNode = $("communityMyPostsState");
    if (!host || !stateNode || !state.community.myPostsLoaded) return;
    stateNode.classList.toggle("is-hidden", state.community.myPosts.length > 0);
    stateNode.textContent = state.community.myPosts.length ? "" : "你还没有发布过帖子。";
    host.innerHTML = state.community.myPosts.map(function (item) { return renderCommunityCard(item, { mine: true }); }).join("");
    $("communityMyPostsLoadMoreButton").classList.toggle("is-hidden", !state.community.myPostsNextCursor);
    host.querySelectorAll("[data-community-open]").forEach(function (button) {
      button.addEventListener("click", function () {
        setHashForCommunityDetail(button.getAttribute("data-community-open"), "community");
      });
    });
    host.querySelectorAll("[data-community-edit]").forEach(function (button) {
      button.addEventListener("click", function () {
        const postId = button.getAttribute("data-community-edit") || "";
        const post = state.community.myPosts.find(function (item) { return item.id === postId; });
        if (post) openCommunityComposer(post);
      });
    });
    host.querySelectorAll("[data-community-delete]").forEach(function (button) {
      button.addEventListener("click", function () {
        deleteCommunityPost(button.getAttribute("data-community-delete") || "");
      });
    });
  }

  function resetCommunityComposer() {
    $("communityComposerModal").dataset.editingPostId = "";
    $("communityComposerBody").value = "";
    $("communityComposerTopics").value = "";
    $("communityComposerImages").value = "";
    $("communityComposerImages").disabled = !state.community.imageUploadEnabled;
    $("communityComposerFiles").textContent = "";
    $("communityComposerHint").textContent = state.community.imageUploadEnabled
      ? "首期开放图文，最多 9 张图片；提交后需审核。"
      : "当前先开放文字帖子；图片上传正在进行对象存储验收。";
    $("communityComposerCount").textContent = "0/2000";
    $("communityComposerSubmit").textContent = "提交审核";
  }

  function openCommunityComposer(post) {
    if (!state.session || !state.session.userId) {
      showInlineMessage("登录后即可发布。");
      return;
    }
    resetCommunityComposer();
    if (post) {
      $("communityComposerModal").dataset.editingPostId = post.id || "";
      $("communityComposerBody").value = post.body || "";
      $("communityComposerTopics").value = Array.isArray(post.topics) ? post.topics.join(", ") : "";
      $("communityComposerImages").disabled = true;
      $("communityComposerHint").textContent = "待审核或被驳回帖子可修改正文与话题，图片沿用当前草稿。";
      $("communityComposerCount").textContent = String(($("communityComposerBody").value || "").length) + "/2000";
      $("communityComposerSubmit").textContent = "保存修改";
    }
    $("communityComposerModal").classList.remove("is-hidden");
    $("communityComposerBody").focus();
  }

  function closeCommunityComposer() {
    $("communityComposerModal").classList.add("is-hidden");
    resetCommunityComposer();
  }

  async function deleteCommunityPost(postId) {
    if (!postId) return;
    if (!window.confirm("确认删除这条帖子吗？删除后将从用户侧隐藏。")) return;
    try {
      await apiCall("/api/community/posts/" + encodeURIComponent(postId), {
        method: "DELETE",
        body: JSON.stringify({}),
      });
      delete state.community.detailCache[postId];
      state.community.myPostsLoaded = false;
      state.community.loaded = false;
      if (state.route.view === "community" && state.route.id === postId) {
        setHashForTab("community");
      }
      await loadCommunityFeed();
      await loadMyCommunityPosts();
      showInlineMessage("帖子已删除。");
    } catch (err) {
      showInlineMessage("删除失败：" + apiText(err));
    }
  }

  async function submitCommunityPost() {
    const body = $("communityComposerBody").value || "";
    const topics = parseCommunityTopics($("communityComposerTopics").value || "");
    const files = $("communityComposerImages").files;
    const editingPostId = $("communityComposerModal").dataset.editingPostId || "";
    if (!body.trim()) {
      showInlineMessage("请输入正文后再提交。");
      return;
    }
    if (topics.length < 1) {
      showInlineMessage("请至少填写 1 个话题。");
      return;
    }
    try {
      if (editingPostId) {
        await apiCall("/api/community/posts/" + encodeURIComponent(editingPostId), {
          method: "PATCH",
          body: JSON.stringify({ body: body, topics: topics }),
        });
      } else {
        const created = await apiCall("/api/community/posts", {
          method: "POST",
          body: JSON.stringify({ body: body, topics: topics }),
        });
        const post = created && created.post ? created.post : null;
        if (post && files && files.length) {
          await uploadCommunityImages(post.id, files);
        }
      }
      closeCommunityComposer();
      showInlineMessage(editingPostId ? "待审核帖子已更新。" : "已提交审核，通过后将展示在社区中。");
      state.community.myPostsLoaded = false;
      state.community.loaded = false;
      await loadCommunityFeed();
      await loadMyCommunityPosts();
    } catch (err) {
      showInlineMessage("社区发布失败：" + apiText(err));
    }
  }

  async function renderCommunityDetail(id) {
    const host = $("communityDetailContent");
    if (!host) return;
    host.innerHTML = '<div class="inline-state">正在加载帖子…</div>';
    try {
      let item = state.community.detailCache[id];
      if (!item) {
        item = await apiCall("/api/community/posts/" + encodeURIComponent(id));
        state.community.detailCache[id] = item;
      }
      if (state.route && state.route.view === "community" && state.route.id === id) {
        $("headerTitle").textContent = item.title || "帖子详情";
        $("headerSubtitle").textContent = item.summary || "社区帖子";
      }
      updatePageSeo(item.effectiveSeo || null);
      const topics = (item.topics || []).map(function (topic) { return '<span class="community-topic-chip">#' + escapeHtml(topic) + "</span>"; }).join("");
      host.innerHTML =
        '<div class="community-detail-meta">' + (topics ? '<div class="community-detail-topics">' + topics + "</div>" : "") + '<span>' + escapeHtml(formatCommunityDate(item.publishedAt || item.createdAt)) + "</span></div>" +
        '<h2>' + escapeHtml(item.title || "圈子帖子") + "</h2>" +
        '<p class="community-detail-body">' + escapeHtml(item.body || item.summary || "") + "</p>" +
        renderCommunityMedia(item.assets || [], true) +
        (item.status === "published"
          ? renderInteractionPanelShell("community", {
              targetType: "circle_post",
              targetId: item.id,
              title: item.title || "圈子帖子",
            })
          : '<div class="inline-state">该帖子当前仅作者可见，等待审核结果。</div>');
      if (item.status === "published") {
        initializeInteractionPanel("community", {
          targetType: "circle_post",
          targetId: item.id,
          title: item.title || "圈子帖子",
        });
      }
      host.querySelectorAll("[data-community-image]").forEach(function (button) {
        button.addEventListener("click", function () {
          const url = button.getAttribute("data-community-image");
          if (url) window.open(url, "_blank", "noopener");
        });
      });
    } catch (err) {
      host.innerHTML = '<div class="inline-state">帖子加载失败：' + escapeHtml(apiText(err)) + "</div>";
    }
  }

  const INTERACTION_REPORT_REASONS = [
    { code: "spam", label: "垃圾/广告" },
    { code: "abuse", label: "骚扰/辱骂" },
    { code: "illegal", label: "违法/违规" },
    { code: "sexual_violence", label: "性暴力/非自愿" },
    { code: "other", label: "其他" },
  ];

  function interactionState(prefix) {
    if (!state.interactions[prefix]) {
      state.interactions[prefix] = {
        targetType: "",
        targetId: "",
        title: "",
        sort: "hot",
        items: [],
        nextCursor: null,
        summary: { likeCount: 0, commentCount: 0, likedByMe: false },
        replyingToId: "",
        replyDraft: "",
        reportSubject: null,
        loadingComments: false,
      };
    }
    return state.interactions[prefix];
  }

  function interactionNode(prefix, suffix) {
    return $(prefix + suffix);
  }

  function renderInteractionPanelShell(prefix, options) {
    const targetId = options && options.targetId ? String(options.targetId) : "";
    if (!targetId) {
      return '<section class="interaction-panel"><div class="inline-state">' + escapeHtml(options && options.emptyHint ? options.emptyHint : "互动暂未开放。") + '</div></section>';
    }
    return '' +
      '<section id="' + prefix + 'InteractionPanel" class="interaction-panel">' +
        '<div class="interaction-summary-bar">' +
          '<button id="' + prefix + 'LikeButton" class="interaction-chip" type="button">赞 <strong id="' + prefix + 'LikeCount">0</strong></button>' +
          '<div class="interaction-summary-copy"><strong id="' + prefix + 'CommentCount">0</strong><span>条评论</span></div>' +
          '<button id="' + prefix + 'ReportButton" class="text-button" type="button">举报内容</button>' +
        '</div>' +
        '<div class="interaction-composer">' +
          '<textarea id="' + prefix + 'CommentInput" class="interaction-textarea" rows="4" maxlength="500" placeholder="留下你的看法，最多 500 字。"></textarea>' +
          '<div class="interaction-composer-foot">' +
            '<span id="' + prefix + 'ComposerHint" class="muted-copy">仅支持纯文本与 Emoji，未审核评论不会公开显示。</span>' +
            '<span id="' + prefix + 'ComposerCount" class="interaction-counter">0/500</span>' +
          '</div>' +
          '<div class="interaction-composer-actions">' +
            '<button id="' + prefix + 'CommentSubmit" class="primary-button" type="button">发表评论</button>' +
          '</div>' +
        '</div>' +
        '<div class="interaction-sort-bar">' +
          '<div class="segment" role="tablist" aria-label="评论排序">' +
            '<button id="' + prefix + 'SortHot" class="segment-button is-active" type="button">热门</button>' +
            '<button id="' + prefix + 'SortNew" class="segment-button" type="button">最新</button>' +
          '</div>' +
        '</div>' +
        '<div id="' + prefix + 'InteractionState" class="inline-state is-hidden"></div>' +
        '<div id="' + prefix + 'CommentList" class="interaction-comment-list"></div>' +
        '<button id="' + prefix + 'LoadMore" class="ghost-button is-hidden" type="button">加载更多评论</button>' +
      '</section>' +
      '<section id="' + prefix + 'ReportSheet" class="interaction-report-sheet is-hidden" aria-live="polite">' +
        '<div class="interaction-report-card">' +
          '<div class="interaction-report-head"><strong>举报原因</strong><button id="' + prefix + 'ReportCancel" class="ghost-button" type="button">取消</button></div>' +
          '<label class="interaction-field-label" for="' + prefix + 'ReportReason">请选择原因</label>' +
          '<select id="' + prefix + 'ReportReason" class="interaction-select">' +
            INTERACTION_REPORT_REASONS.map(function (item) { return '<option value="' + item.code + '">' + item.label + '</option>'; }).join("") +
          '</select>' +
          '<label class="interaction-field-label" for="' + prefix + 'ReportDetail">补充说明</label>' +
          '<textarea id="' + prefix + 'ReportDetail" class="interaction-textarea" rows="3" maxlength="500" placeholder="选填，最多 500 字。"></textarea>' +
          '<button id="' + prefix + 'ReportSubmit" class="primary-button" type="button">提交举报</button>' +
        '</div>' +
      '</section>';
  }

  function normalizeCommentRows(items) {
    return Array.isArray(items) ? items : [];
  }

  function formatCommentTimestamp(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "刚刚";
    const diff = Date.now() - date.getTime();
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return Math.max(1, Math.floor(diff / (60 * 1000))) + " 分钟前";
    if (diff < 24 * 60 * 60 * 1000) return Math.max(1, Math.floor(diff / (60 * 60 * 1000))) + " 小时前";
    return formatArticleDate(date.toISOString());
  }

  function findInteractionComment(items, commentId) {
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].id === commentId) return items[i];
      const replies = Array.isArray(items[i].replies) ? items[i].replies : [];
      for (let j = 0; j < replies.length; j += 1) {
        if (replies[j].id === commentId) return replies[j];
      }
    }
    return null;
  }

  function updateInteractionSummaryDom(prefix) {
    const current = interactionState(prefix);
    const likeButton = interactionNode(prefix, "LikeButton");
    const likeCount = interactionNode(prefix, "LikeCount");
    const commentCount = interactionNode(prefix, "CommentCount");
    if (likeButton) likeButton.classList.toggle("is-active", !!current.summary.likedByMe);
    if (likeCount) likeCount.textContent = String(current.summary.likeCount || 0);
    if (commentCount) commentCount.textContent = String(current.summary.commentCount || 0);
  }

  function updateInteractionComposerCount(prefix) {
    const input = interactionNode(prefix, "CommentInput");
    const counter = interactionNode(prefix, "ComposerCount");
    if (!input || !counter) return;
    counter.textContent = String((input.value || "").length) + "/500";
  }

  function setInteractionStateText(prefix, message, visible) {
    const node = interactionNode(prefix, "InteractionState");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("is-hidden", !visible || !message);
  }

  function renderInteractionCommentItem(prefix, comment, isReply) {
    const current = interactionState(prefix);
    const currentUserId = state.session && state.session.userId ? String(state.session.userId) : "";
    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    const canDelete = !!currentUserId && comment.author && String(comment.author.id) === currentUserId;
    const replyBox = !isReply && current.replyingToId === comment.id
      ? '<div class="interaction-reply-box">' +
          '<textarea id="' + prefix + 'ReplyInput" class="interaction-textarea" rows="3" maxlength="300" placeholder="回复 ' + escapeHtml((comment.author && comment.author.displayName) || "同频成员") + '，最多 300 字。">' + escapeHtml(current.replyDraft || "") + '</textarea>' +
          '<div class="interaction-composer-foot"><span class="muted-copy">仅支持回复一级评论。</span><span id="' + prefix + 'ReplyCount" class="interaction-counter">' + String((current.replyDraft || "").length) + '/300</span></div>' +
          '<div class="interaction-composer-actions"><button class="ghost-button" type="button" data-interaction-cancel-reply="' + escapeHtml(comment.id) + '">取消</button><button class="primary-button" type="button" data-interaction-submit-reply="' + escapeHtml(comment.id) + '">发送回复</button></div>' +
        '</div>'
      : "";
    return '' +
      '<article class="interaction-comment' + (isReply ? ' is-reply' : '') + '">' +
        '<div class="interaction-comment-head"><strong>' + escapeHtml(comment.author && comment.author.displayName ? comment.author.displayName : "同频成员") + '</strong><span>' + escapeHtml(formatCommentTimestamp(comment.createdAt)) + '</span></div>' +
        '<p class="interaction-comment-body">' + escapeHtml(comment.body || "") + '</p>' +
        '<div class="interaction-comment-actions">' +
          '<button class="interaction-link-button' + (comment.likedByMe ? ' is-active' : '') + '" type="button" data-interaction-like-comment="' + escapeHtml(comment.id) + '">赞 ' + escapeHtml(String(comment.likeCount || 0)) + '</button>' +
          (!isReply ? '<button class="interaction-link-button" type="button" data-interaction-reply="' + escapeHtml(comment.id) + '">回复</button>' : '') +
          '<button class="interaction-link-button" type="button" data-interaction-report-comment="' + escapeHtml(comment.id) + '">举报</button>' +
          (canDelete ? '<button class="interaction-link-button interaction-link-danger" type="button" data-interaction-delete-comment="' + escapeHtml(comment.id) + '">删除</button>' : '') +
        '</div>' +
        replyBox +
        (replies.length ? '<div class="interaction-reply-list">' + replies.map(function (reply) { return renderInteractionCommentItem(prefix, reply, true); }).join("") + '</div>' : '') +
        (!isReply && Number(comment.replyCount || 0) > replies.length ? '<p class="interaction-more-replies">当前已展示前 ' + escapeHtml(String(replies.length)) + ' 条回复。</p>' : '') +
      '</article>';
  }

  function bindInteractionCommentActions(prefix) {
    const current = interactionState(prefix);
    const replyInput = interactionNode(prefix, "ReplyInput");
    const replyCount = interactionNode(prefix, "ReplyCount");
    if (replyInput && replyCount) {
      replyInput.oninput = function () {
        current.replyDraft = replyInput.value || "";
        replyCount.textContent = String(current.replyDraft.length) + "/300";
      };
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-interaction-like-comment]"), function (button) {
      button.onclick = function () { toggleInteractionCommentLike(prefix, button.getAttribute("data-interaction-like-comment")); };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-interaction-reply]"), function (button) {
      button.onclick = function () {
        current.replyingToId = button.getAttribute("data-interaction-reply") || "";
        current.replyDraft = "";
        renderInteractionComments(prefix);
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-interaction-cancel-reply]"), function (button) {
      button.onclick = function () {
        current.replyingToId = "";
        current.replyDraft = "";
        renderInteractionComments(prefix);
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-interaction-submit-reply]"), function (button) {
      button.onclick = function () {
        submitInteractionComment(prefix, {
          parentId: button.getAttribute("data-interaction-submit-reply") || "",
          body: current.replyDraft || "",
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-interaction-report-comment]"), function (button) {
      button.onclick = function () { openInteractionReportSheet(prefix, { commentId: button.getAttribute("data-interaction-report-comment") || "" }); };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-interaction-delete-comment]"), function (button) {
      button.onclick = function () { deleteInteractionComment(prefix, button.getAttribute("data-interaction-delete-comment") || ""); };
    });
  }

  function renderInteractionComments(prefix) {
    const current = interactionState(prefix);
    const host = interactionNode(prefix, "CommentList");
    const loadMore = interactionNode(prefix, "LoadMore");
    if (!host) return;
    if (!current.items.length) host.innerHTML = '<div class="empty-state">还没有公开评论，来抢第一个发言位置。</div>';
    else host.innerHTML = current.items.map(function (comment) { return renderInteractionCommentItem(prefix, comment, false); }).join("");
    if (loadMore) loadMore.classList.toggle("is-hidden", !current.nextCursor);
    bindInteractionCommentActions(prefix);
  }

  async function loadInteractionSummary(prefix) {
    const current = interactionState(prefix);
    const query = new URLSearchParams({ targetType: current.targetType, targetId: current.targetId });
    const payload = await apiCall("/api/interactions/summary?" + query.toString());
    if (interactionState(prefix).targetId !== current.targetId) return;
    current.summary = payload && payload.summary ? payload.summary : { likeCount: 0, commentCount: 0, likedByMe: false };
    updateInteractionSummaryDom(prefix);
  }

  async function loadInteractionComments(prefix, options) {
    const current = interactionState(prefix);
    if (!current.targetId || current.loadingComments) return;
    current.loadingComments = true;
    const append = !!(options && options.append);
    if (!append) setInteractionStateText(prefix, "正在加载评论…", true);
    try {
      const query = new URLSearchParams({
        targetType: current.targetType,
        targetId: current.targetId,
        sort: current.sort,
        pageSize: "10",
      });
      if (append && current.nextCursor) query.set("cursor", current.nextCursor);
      const payload = await apiCall("/api/interactions/comments?" + query.toString());
      if (interactionState(prefix).targetId !== current.targetId) return;
      current.items = append ? current.items.concat(normalizeCommentRows(payload && payload.items)) : normalizeCommentRows(payload && payload.items);
      current.nextCursor = payload && payload.nextCursor ? payload.nextCursor : null;
      renderInteractionComments(prefix);
      setInteractionStateText(prefix, "", false);
    } catch (err) {
      if (!append) setInteractionStateText(prefix, "评论加载失败：" + apiText(err), true);
      else showInlineMessage("加载更多评论失败：" + apiText(err));
    } finally {
      current.loadingComments = false;
    }
  }

  async function refreshInteractionPanel(prefix) {
    await Promise.all([
      loadInteractionSummary(prefix),
      loadInteractionComments(prefix, { append: false }),
    ]);
  }

  async function toggleInteractionTargetLike(prefix) {
    const current = interactionState(prefix);
    const before = { likedByMe: !!current.summary.likedByMe, likeCount: Number(current.summary.likeCount || 0) };
    current.summary.likedByMe = !before.likedByMe;
    current.summary.likeCount = Math.max(0, before.likeCount + (current.summary.likedByMe ? 1 : -1));
    updateInteractionSummaryDom(prefix);
    try {
      const payload = await apiCall("/api/interactions/likes/toggle", {
        method: "POST",
        body: JSON.stringify({
          targetType: current.targetType,
          targetId: current.targetId,
          subjectKind: "target",
        }),
      });
      current.summary.likedByMe = !!payload.liked;
      current.summary.likeCount = Number(payload.likeCount || 0);
      updateInteractionSummaryDom(prefix);
    } catch (err) {
      current.summary.likedByMe = before.likedByMe;
      current.summary.likeCount = before.likeCount;
      updateInteractionSummaryDom(prefix);
      showInlineMessage("点赞未保存：" + apiText(err));
    }
  }

  async function toggleInteractionCommentLike(prefix, commentId) {
    const current = interactionState(prefix);
    const comment = findInteractionComment(current.items, commentId);
    if (!comment) return;
    const before = { likedByMe: !!comment.likedByMe, likeCount: Number(comment.likeCount || 0) };
    comment.likedByMe = !before.likedByMe;
    comment.likeCount = Math.max(0, before.likeCount + (comment.likedByMe ? 1 : -1));
    renderInteractionComments(prefix);
    try {
      const payload = await apiCall("/api/interactions/likes/toggle", {
        method: "POST",
        body: JSON.stringify({
          targetType: current.targetType,
          targetId: current.targetId,
          subjectKind: "comment",
          commentId: commentId,
        }),
      });
      comment.likedByMe = !!payload.liked;
      comment.likeCount = Number(payload.likeCount || 0);
      renderInteractionComments(prefix);
    } catch (err) {
      comment.likedByMe = before.likedByMe;
      comment.likeCount = before.likeCount;
      renderInteractionComments(prefix);
      showInlineMessage("评论点赞未保存：" + apiText(err));
    }
  }

  async function submitInteractionComment(prefix, options) {
    const current = interactionState(prefix);
    const parentId = options && options.parentId ? String(options.parentId) : "";
    const composer = interactionNode(prefix, "CommentInput");
    const body = String(options && options.body ? options.body : composer ? composer.value : "").trim();
    const maxLength = parentId ? 300 : 500;
    if (!body || body.length < 2) {
      showInlineMessage("评论至少输入 2 个字。");
      return;
    }
    if (body.length > maxLength) {
      showInlineMessage((parentId ? "回复" : "评论") + "最多 " + maxLength + " 字。");
      return;
    }
    try {
      const payload = await apiCall("/api/interactions/comments", {
        method: "POST",
        body: JSON.stringify({
          targetType: current.targetType,
          targetId: current.targetId,
          parentId: parentId || undefined,
          body: body,
        }),
      });
      if (parentId) {
        current.replyingToId = "";
        current.replyDraft = "";
      } else if (composer) {
        composer.value = "";
        updateInteractionComposerCount(prefix);
      }
      if (payload && payload.comment && payload.comment.status === "pending") showInlineMessage("评论已提交审核，通过后会公开显示。");
      else showInlineMessage(parentId ? "回复已发送。" : "评论已发布。");
      await refreshInteractionPanel(prefix);
    } catch (err) {
      showInlineMessage((parentId ? "回复失败：" : "评论失败：") + apiText(err));
    }
  }

  function openInteractionReportSheet(prefix, subject) {
    const current = interactionState(prefix);
    current.reportSubject = subject || null;
    const sheet = interactionNode(prefix, "ReportSheet");
    const reason = interactionNode(prefix, "ReportReason");
    const detail = interactionNode(prefix, "ReportDetail");
    if (reason) reason.value = "other";
    if (detail) detail.value = "";
    if (sheet) sheet.classList.remove("is-hidden");
  }

  function closeInteractionReportSheet(prefix) {
    const sheet = interactionNode(prefix, "ReportSheet");
    if (sheet) sheet.classList.add("is-hidden");
    interactionState(prefix).reportSubject = null;
  }

  async function submitInteractionReport(prefix) {
    const current = interactionState(prefix);
    const reason = interactionNode(prefix, "ReportReason");
    const detail = interactionNode(prefix, "ReportDetail");
    try {
      await apiCall("/api/interactions/reports", {
        method: "POST",
        body: JSON.stringify({
          targetType: current.targetType,
          targetId: current.targetId,
          commentId: current.reportSubject && current.reportSubject.commentId ? current.reportSubject.commentId : undefined,
          reasonCode: reason ? reason.value : "other",
          detailText: detail && String(detail.value || "").trim() ? String(detail.value || "").trim() : undefined,
        }),
      });
      closeInteractionReportSheet(prefix);
      showInlineMessage("举报已提交，我们会尽快处理。");
    } catch (err) {
      showInlineMessage("举报失败：" + apiText(err));
    }
  }

  async function deleteInteractionComment(prefix, commentId) {
    if (!commentId) return;
    if (!window.confirm("确认删除这条评论吗？删除后会同步更新计数。")) return;
    try {
      await apiCall("/api/interactions/comments/" + encodeURIComponent(commentId), {
        method: "DELETE",
      });
      showInlineMessage("评论已删除。");
      await refreshInteractionPanel(prefix);
    } catch (err) {
      showInlineMessage("删除失败：" + apiText(err));
    }
  }

  function initializeInteractionPanel(prefix, input) {
    const current = interactionState(prefix);
    const changed = current.targetType !== input.targetType || current.targetId !== input.targetId;
    current.targetType = input.targetType;
    current.targetId = input.targetId;
    current.title = input.title || "";
    if (changed) {
      current.items = [];
      current.nextCursor = null;
      current.summary = { likeCount: 0, commentCount: 0, likedByMe: false };
      current.replyingToId = "";
      current.replyDraft = "";
      current.sort = "hot";
    }
    const likeButton = interactionNode(prefix, "LikeButton");
    const reportButton = interactionNode(prefix, "ReportButton");
    const submitButton = interactionNode(prefix, "CommentSubmit");
    const inputNode = interactionNode(prefix, "CommentInput");
    const loadMore = interactionNode(prefix, "LoadMore");
    const sortHot = interactionNode(prefix, "SortHot");
    const sortNew = interactionNode(prefix, "SortNew");
    const reportSubmit = interactionNode(prefix, "ReportSubmit");
    const reportCancel = interactionNode(prefix, "ReportCancel");
    if (likeButton) likeButton.onclick = function () { toggleInteractionTargetLike(prefix); };
    if (reportButton) reportButton.onclick = function () { openInteractionReportSheet(prefix, null); };
    if (submitButton) submitButton.onclick = function () { submitInteractionComment(prefix, { body: inputNode ? inputNode.value : "" }); };
    if (inputNode) {
      inputNode.oninput = function () { updateInteractionComposerCount(prefix); };
      updateInteractionComposerCount(prefix);
    }
    if (loadMore) loadMore.onclick = function () { loadInteractionComments(prefix, { append: true }); };
    if (sortHot) sortHot.onclick = function () {
      current.sort = "hot";
      sortHot.classList.add("is-active");
      if (sortNew) sortNew.classList.remove("is-active");
      current.nextCursor = null;
      loadInteractionComments(prefix, { append: false });
    };
    if (sortNew) sortNew.onclick = function () {
      current.sort = "new";
      sortNew.classList.add("is-active");
      if (sortHot) sortHot.classList.remove("is-active");
      current.nextCursor = null;
      loadInteractionComments(prefix, { append: false });
    };
    if (reportSubmit) reportSubmit.onclick = function () { submitInteractionReport(prefix); };
    if (reportCancel) reportCancel.onclick = function () { closeInteractionReportSheet(prefix); };
    renderInteractionComments(prefix);
    void refreshInteractionPanel(prefix);
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
      card.innerHTML =
        (theme.iconUrl ? imageTag(theme.iconUrl, "topic-chip-image", theme.name || "分类图标", true) : '<span class="topic-chip-fallback" aria-hidden="true"></span>') +
        '<strong>' + escapeHtml(theme.name) + '</strong>';
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
      btn.innerHTML =
        (category.iconUrl ? imageTag(category.iconUrl, "category-chip-image", category.name || "分类图标", true) : "") +
        '<span>' + escapeHtml(category.name) + '</span>';
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

  function appendMembershipPurchaseAction(host, membershipEntry, summary) {
    if (!host || !membershipEntry || !membershipEntry.product) return;
    const isActive = summary.status === "active";
    const action = document.createElement("div");
    action.className = "channel-actions membership-purchase-action";
    action.innerHTML =
      '<p class="stack-note">' + escapeHtml(isActive
        ? "会员有效期内续费会从当前到期日顺延。"
        : "完成支付后将恢复会员主频道与对应内容权益。") + '</p>' +
      '<button class="primary-button" type="button">' + (isActive ? "立即续费" : "开通会员") + "</button>";
    action.querySelector("button").addEventListener("click", function () {
      startPurchase(membershipEntry);
    });
    host.appendChild(action);
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
      $("membershipCopy").textContent = "支付成功后，只会进入你实际拥有权益对应的频道；可随时续费延长有效期。";
    } else {
      badge.textContent = summary.status === "expired" ? "已到期" : "未开通";
      badge.className = "status-badge status-warning";
      $("membershipHeadline").textContent = summary.status === "expired" ? "恢复会员权益" : "理解权益，再决定购买方式";
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
      appendMembershipPurchaseAction(membershipHost, membershipEntry, summary);
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
          window.location.assign("./h5-pay.html?orderNo=" + encodeURIComponent(order.orderNo));
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
      ? "会员内容会在详情页直接展示频道入口；可在「会员」页续费。"
      : (membershipSummary.status === "expired" ? "会员已到期，可在「会员」页恢复权益。" : "会员与内容包购买入口在「会员」页。");
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
    const playback = getDetailPlaybackStatus(detail);
    if (playback && !playback.errorClass && playback.action === "play_full") {
      return { text: "播放完整", handler: function () { startManagedPlayback(detail); } };
    }
    if (playback && !playback.errorClass && playback.action === "preview") {
      return { text: "试看", handler: function () { startManagedPlayback(detail); } };
    }
    if (detail.previewUrl) {
      return { text: "试看", handler: function () { playInlineDetailVideo(); } };
    }
    if (detail.unlocked) {
      return { text: "Telegram 备用观看", handler: function () { openChannelAccess(detail.id); } };
    }
    if (playback && playback.action === "processing") {
      return { text: "转码处理中", handler: function () { showInlineMessage("视频转码处理中，请稍后再试。"); } };
    }
    if (detail.accessType === "membership") {
      return { text: "开通会员", handler: function () { startPurchase(detail); } };
    }
    if (detail.accessType === "package") {
      return { text: "解锁内容包", handler: function () { startPurchase(detail); } };
    }
    return { text: "查看频道预览", handler: function () { openChannelAccess(detail.id); } };
  }

  async function renderDetail(id) {
    if (!id) {
      $("detailContent").innerHTML = '<div class="empty-state">内容 ID 缺失。</div>';
      return;
    }
    // 首次深链进入时，会话初始化会重新触发路由。await 后必须使用本次请求
    // 的稳定结果，不能重新读取可能已被初始化清空的详情缓存。
    let detail = state.detailCache[id] || null;
    if (!detail) {
      state.detailLoading = true;
      $("detailContent").innerHTML = createSkeletonCards(1);
      try {
        detail = await apiCall("/api/contents/" + encodeURIComponent(id));
        if (!detail || typeof detail !== "object" || !detail.id) {
          throw new Error("content_detail_invalid");
        }
        if (state.route.view !== "detail" || state.route.id !== id) return;
        state.detailCache[id] = detail;
      } catch (err) {
        if (state.route.view === "detail" && state.route.id === id) {
          $("detailContent").innerHTML = '<div class="empty-state">加载失败：' + escapeHtml(apiText(err)) + "</div>";
        }
        state.detailLoading = false;
        return;
      }
      state.detailLoading = false;
    }
    if (!detail || typeof detail !== "object" || !detail.id) {
      $("detailContent").innerHTML = '<div class="empty-state">内容加载异常，请返回后重新打开。</div>';
      return;
    }
    trackAnalytics("content_opened", { contentId: detail.id, sourceModule: state.route.fromTab || "home" });
    // 详情页使用服务端已合并的 SEO/GEO：单条内容优先，未设置时自动回退平台默认。
    // 页面维持 noindex，不输出付费内容的 VideoObject JSON-LD。
    updatePageSeo(detail.effectiveSeo || null);
    updateOgImage(detail.coverUrl || "");
    updateJsonLd(null);

    const playback = getDetailPlaybackStatus(detail);
    const primaryAction = getPrimaryDetailAction(detail);
    const pendingOrder = detail.product ? pendingOrderForProduct(detail.product.id) : null;
    // 详情页只保留一个 16:9 媒体位：有试看直接播放试看；无试看才展示封面。
    // 这样不会把同一张封面和同一段视频上下重复展示，首屏也更聚焦。
    const managedPlaybackEnabled = hasManagedPlayback(detail);
    const canRenderPlayer = !!detail.previewUrl || managedPlaybackEnabled;
    const previewUpgradeEnabled = !detail.unlocked && !!detail.product &&
      (detail.accessType === "membership" || detail.accessType === "package");
    const previewUpgradeText = detail.accessType === "membership" ? "开通会员" : "解锁内容包";
    const mediaSlot = canRenderPlayer
      ? '<section class="detail-media detail-media-preview" aria-label="免费试看">' +
        '<video class="detail-preview-video" controls playsinline preload="metadata"' +
          (detail.previewUrl ? ' src="' + escapeHtml(detail.previewUrl) + '"' : "") +
          (detail.coverUrl ? ' poster="' + escapeHtml(detail.coverUrl) + '"' : '') + '>' +
          '当前浏览器不支持视频在线播放。' +
        '</video>' +
        '<div class="detail-media-label"><strong>' + escapeHtml(playback && playback.action === "play_full" ? "受控播放" : "免费试看") + '</strong><span>' +
          escapeHtml(playback && playback.action === "play_full"
            ? "完整播放走服务端会话与短时鉴权。"
            : managedPlaybackEnabled
              ? "试看将优先使用服务端签发的私有 HLS。"
              : "试看不需要开通会员") +
        '</span></div>' +
        (previewUpgradeEnabled
          ? '<div id="previewUpgradeGate" class="detail-preview-gate is-hidden" role="status" aria-live="polite">' +
            '<div class="detail-preview-gate-copy"><span>试看结束</span><strong>开通后继续观看完整内容</strong>' +
            '<button id="previewUpgradeButton" class="primary-button" type="button">' + escapeHtml(previewUpgradeText) + '</button></div>' +
            '</div>'
          : '') +
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
      '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(playback && playback.action === "play_full"
        ? "已解锁，可直接受控播放"
        : detail.unlocked
          ? "已解锁，可走备用交付"
          : getAccessLabel(detail)) + '</div>' +
      '<div class="stack-subtitle">' + escapeHtml(playback && playback.action === "play_full"
        ? "当前账户已满足权益，可创建完整播放会话。"
        : playback && playback.action === "preview" && !playback.errorClass
          ? "当前可直接试看；试看结束后可继续开通对应权益。"
          : detail.unlocked && playback && playback.errorClass
            ? "完整 Web 播放仍保持关闭，当前请先使用 Telegram 备用观看。"
            : detail.unlocked
        ? "该内容已归属到你当前账户的有效权益。"
        : detail.accessType === "membership"
          ? "该内容通过会员主频道交付。"
          : detail.accessType === "package"
            ? "该内容通过所属内容包频道交付。"
            : "该内容为公开预览，可直接查看。") + '</div></div>' +
      '<div class="status-badge' + ((playback && playback.action === "play_full") || detail.unlocked ? "" : " status-warning") + '">' +
      escapeHtml((playback && playback.action === "play_full") || detail.unlocked ? "已解锁" : "未解锁") + "</div></div>" +
      (pendingOrder ? '<div class="stack-note">当前有待支付订单：' + escapeHtml(pendingOrder.orderNo) + '，可在「我的 > 我的订单」继续支付。</div>' : "") +
      '</div>' +
      (detail.accessType !== "public" ? '<div class="detail-purchase-list"></div>' : "") +
      renderInteractionPanelShell("detail", {
        targetType: "video_content",
        targetId: detail.id,
        title: detail.title || "视频内容",
      }) +
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
    const previewUpgradeButton = $("previewUpgradeButton");
    if (previewUpgradeButton) previewUpgradeButton.addEventListener("click", function () { startPurchase(detail); });
    $("detailBackButton").addEventListener("click", function () {
      setHashForTab(state.route.fromTab || "home");
    });
    initializeInteractionPanel("detail", {
      targetType: "video_content",
      targetId: detail.id,
      title: detail.title || "视频内容",
    });
    attachDetailPlayer(detail);
    void prefetchDetailPreview(detail);
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
      setHashForTab("me");
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
      writePlayerProgress({ id: activeContentId }, {
        eventName: eventName,
        positionSec: activeVideo.ended ? activeVideo.duration || activeVideo.currentTime || 0 : activeVideo.currentTime || 0,
        durationSec: activeVideo.duration || null,
        quality: "auto",
      });
    }
    clearManagedPlaybackState();
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
    state.player.managed = false;
    state.player.currentQuality = "auto";
    state.player.bufferStartedAt = 0;

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
        trackAnalytics(state.player.managed ? "playback_started" : "preview_started", {
          contentId: detail.id,
          deliveryVariant: state.player.deliveryVariant || "preview",
        });
      }
      writePlayerProgress(detail, {
        eventName: "start",
        positionSec: video.currentTime || 0,
        durationSec: video.duration || detail.durationSeconds || null,
        quality: state.player.currentQuality || "auto",
      });
    });

    video.addEventListener("playing", function () {
      if (state.player.managed && state.player.playRequestedAt) {
        trackManagedAnalytics(detail, "playback_first_frame", {
          elapsedMs: Math.max(0, Date.now() - state.player.playRequestedAt),
        });
        state.player.playRequestedAt = 0;
      }
      if (state.player.managed && state.player.bufferStartedAt) {
        trackManagedAnalytics(detail, "playback_buffer_end", {
          bufferDurationMs: Math.max(0, Date.now() - state.player.bufferStartedAt),
        });
        state.player.bufferStartedAt = 0;
      }
      if (!state.player.managed && video.videoHeight) {
        state.player.currentQuality = inferQualityLabelFromHeight(video.videoHeight);
      }
    });

    video.addEventListener("waiting", function () {
      if (!state.player.managed || state.player.bufferStartedAt) return;
      state.player.bufferStartedAt = Date.now();
      trackManagedAnalytics(detail, "playback_buffer_start", {
        bufferDurationMs: 0,
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
      writePlayerProgress(detail, {
        eventName: "progress",
        positionSec: current,
        durationSec: video.duration || detail.durationSeconds || null,
        quality: state.player.currentQuality || "auto",
      });
    });

    video.addEventListener("pause", function () {
      if (video.ended) return;
      writePlayerProgress(detail, {
        eventName: "pause",
        positionSec: video.currentTime || 0,
        durationSec: video.duration || detail.durationSeconds || null,
        quality: state.player.currentQuality || "auto",
      });
    });

    video.addEventListener("ended", function () {
      trackAnalytics(state.player.managed ? "playback_completed" : "preview_completed", {
        contentId: detail.id,
        deliveryVariant: state.player.deliveryVariant || "preview",
      });
      writePlayerProgress(detail, {
        eventName: "complete",
        positionSec: video.duration || video.currentTime || detail.durationSeconds || 0,
        durationSec: video.duration || detail.durationSeconds || null,
        quality: state.player.currentQuality || "auto",
      });
      if (!detail.unlocked && detail.product && (detail.accessType === "membership" || detail.accessType === "package")) {
        const gate = $("previewUpgradeGate");
        if (gate) {
          gate.classList.remove("is-hidden");
          trackAnalytics("paywall_shown", { contentId: detail.id, accessType: detail.accessType });
        }
      }
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

  function hasUsdtCheckout(product) {
    if (!product) return false;
    return product.usdtPriceMinor != null || String(product.currency || "").toUpperCase() === "USDT";
  }

  function choosePurchaseMethod(detail) {
    return new Promise(function (resolve) {
      const product = detail && detail.product ? detail.product : null;
      const starsAvailable = isStarsProduct(product);
      const usdtAvailable = hasUsdtCheckout(product);
      if (state.env.isTelegram && tg && typeof tg.showPopup === "function" && starsAvailable && usdtAvailable) {
        tg.showPopup({
          title: "选择支付方式",
          message: "Telegram 内默认优先推荐 Stars，同时也保留 USDT-TRC20。",
          buttons: [
            { id: "stars", type: "default", text: "Stars 支付" },
            { id: "usdt", type: "default", text: "USDT-TRC20" },
            { type: "cancel", id: "cancel" },
          ],
        }, function (buttonId) {
          resolve(buttonId === "usdt" ? "usdt" : buttonId === "stars" ? "stars" : null);
        });
        return;
      }
      if (state.env.isTelegram && starsAvailable) return resolve("stars");
      if (usdtAvailable) return resolve("usdt");
      if (starsAvailable) return resolve("stars");
      resolve(null);
    });
  }

  async function startPurchase(detail) {
    if (!detail || !detail.product) {
      showInlineMessage("当前内容没有可用商品。");
      return;
    }
    const paymentMethod = await choosePurchaseMethod(detail);
    if (!paymentMethod) {
      showInlineMessage("当前内容暂时没有可用的支付方式。");
      return;
    }
    trackAnalytics("payment_method_selected", {
      contentId: detail.id,
      productId: detail.product.id,
      paymentMethod: paymentMethod === "stars" ? "telegram_stars" : "usdt_trc20",
    });
    trackAnalytics("unlock_clicked", { productId: detail.product.id, paymentMethod: paymentMethod === "stars" ? "telegram_stars" : "usdt_trc20" });
    if (paymentMethod === "stars") {
      trackAnalytics("checkout_open", {
        contentId: detail.id,
        productId: detail.product.id,
        paymentMethod: "telegram_stars",
      });
      await createStarsOrderAndPay(detail);
      return;
    }
    trackAnalytics("checkout_open", {
      contentId: detail.id,
      productId: detail.product.id,
      paymentMethod: "usdt_trc20",
    });
    window.location.assign("./h5-pay.html?productId=" + encodeURIComponent(detail.product.id) + "&paymentMethod=usdt");
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
    if (routeState.categoryId) state.library.categoryId = routeState.categoryId;
    if (routeState.view !== "detail") trackAnalytics("page_viewed", { pageName: routeState.view === "article" ? "library" : (routeState.view === "history" ? "watch_history" : routeState.view === "community" ? "community_detail" : routeState.tab) });
    const isDetail = routeState.view === "detail";
    const isArticle = routeState.view === "article";
    const isCommunityDetail = routeState.view === "community";
    const isHistory = routeState.view === "history";
    const isFocusView = isDetail || isArticle || isCommunityDetail || isHistory;
    const titleMap = {
      home: ["同频", ""],
      library: ["片库", "搜索、分类与筛选"],
      community: ["社区", "浏览已发布帖子，图文发布先审核后公开"],
      me: ["我的", "资产、订单、频道入口与绑定"],
    };
    const isHome = !isFocusView && routeState.tab === "home";

    $("backButton").hidden = !isFocusView;
    $("bottomNav").classList.toggle("is-hidden", isFocusView);
    $("appHeader").classList.toggle("is-home", isHome);
    $("appHeader").classList.toggle("is-article-detail", isArticle);
    const isCommunityArticles = routeState.tab === "community" && routeState.communitySection === "articles";
    $("headerTitle").textContent = isDetail ? "视频详情" : (isArticle ? "" : (isCommunityDetail ? "帖子详情" : (isHistory ? "观看历史" : (isCommunityArticles ? "文章" : titleMap[routeState.tab][0]))));
    $("headerSubtitle").textContent = isDetail
      ? "查看权益与购买方式"
      : isArticle
        ? ""
      : isCommunityDetail
        ? "社区帖子详情与互动"
      : isHistory
        ? "按最近播放时间排序，可删除单条或清空记录"
      : (isHome ? "真实表达，在理解与边界中被看见" : (isCommunityArticles ? "关于边界、沟通与亲密关系的中文导读" : titleMap[routeState.tab][1]));
    $("headerSubtitle").hidden = isArticle;
    $("headerEyebrow").hidden = isHome || isArticle;

    ["home", "library", "community", "me"].forEach(function (tab) {
      $(tab + "View").classList.toggle("is-hidden", isFocusView || routeState.tab !== tab);
    });
    $("articlesView").classList.toggle("is-hidden", isFocusView || routeState.tab !== "community" || !isCommunityArticles);
    $("communityPostsPanel").classList.toggle("is-hidden", isCommunityArticles);
    document.querySelectorAll("[data-community-section]").forEach(function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-community-section") === (isCommunityArticles ? "articles" : "posts"));
    });
    $("detailView").classList.toggle("is-hidden", !isDetail);
    $("articleDetailView").classList.toggle("is-hidden", !isArticle);
    $("communityDetailView").classList.toggle("is-hidden", !isCommunityDetail);
    $("watchHistoryView").classList.toggle("is-hidden", !isHistory);

    document.querySelectorAll(".nav-item").forEach(function (button) {
      button.classList.toggle("is-active", !isFocusView && button.getAttribute("data-tab") === routeState.tab);
    });

    if (isDetail) {
      renderDetail(routeState.id);
      return;
    }
    if (isArticle) {
      renderArticleDetail(routeState.id);
      return;
    }
    if (isCommunityDetail) {
      renderCommunityDetail(routeState.id);
      return;
    }
    if (isHistory) {
      if (!state.watch.loaded) loadWatchProgress(1, false);
      renderWatchHistory();
      return;
    }

    if (!state.library.loaded && routeState.tab === "library") loadLibrary();
    if (routeState.tab === "community" && !isCommunityArticles) {
      if (!state.community.loaded) loadCommunityFeed();
      else renderCommunityFeed();
      if (state.community.myPostsLoaded) renderMyCommunityPosts();
    }
    if (routeState.tab === "me" && routeState.packageId) {
      const target = (state.library.items || []).find(function (item) { return item.packageId === routeState.packageId; });
      if (target) {
        openContentDetail(target.id, "me", { autoplay: false, resumePositionSec: 0 });
        return;
      }
    }
    if (isCommunityArticles) {
      loadArticles();
      renderArticles();
    }
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
      // Deep links may render before Telegram/H5 session verification has
      // completed. Drop that anonymous detail response so the second route
      // pass receives the viewer's actual playback eligibility.
      state.detailCache = {};
      await resolveTrafficEntryAttribution();
      trackAnalytics("session_started", { entrySource: state.env.isTelegram ? "telegram_mini_app" : "h5_direct" });
      await loadHome();
      await loadLibrary();
      await Promise.all([loadOrders(), loadEntitlements(), loadChannels(), loadWatchProgress(1, false)]);
      routeTo(parseHash());
    } catch (err) {
      showBootError("暂时无法建立会话", apiText(err));
    }
  }

  async function resolveTrafficEntryAttribution() {
    const code = new URLSearchParams(window.location.search).get("te");
    if (!code) return;
    try {
      const payload = await apiCall("/api/traffic-entries/resolve?code=" + encodeURIComponent(code));
      state.trafficEntry = payload && payload.entry ? payload.entry : null;
      if (state.trafficEntry) {
        trackAnalytics("traffic_entry_open", Object.assign({}, currentTrafficEntryPayload() || {}, {
          contentId: state.trafficEntry.destinationType === "content" ? state.trafficEntry.destinationId : null,
        }));
      }
    } catch (_) {
      state.trafficEntry = null;
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
    $("communityPublishButton").addEventListener("click", function () {
      openCommunityComposer();
    });
    document.querySelectorAll("[data-community-section]").forEach(function (button) {
      button.addEventListener("click", function () {
        setHashForTab(button.getAttribute("data-community-section") === "articles" ? "articles" : "community");
      });
    });
    $("communityMyPostsButton").addEventListener("click", function () {
      if (!state.session || !state.session.userId) {
        showInlineMessage("登录后即可查看我的帖子。");
        return;
      }
      $("communityMyPostsSection").classList.remove("is-hidden");
      if (!state.community.myPostsLoaded) {
        loadMyCommunityPosts();
        return;
      }
      renderMyCommunityPosts();
      $("communityMyPostsSection").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("communityLoadMoreButton").addEventListener("click", function () {
      if (state.community.loading || !state.community.nextCursor) return;
      loadCommunityFeed(state.community.nextCursor);
    });
    $("communityMyPostsLoadMoreButton").addEventListener("click", function () {
      if (state.community.myPostsLoading || !state.community.myPostsNextCursor) return;
      loadMyCommunityPosts(state.community.myPostsNextCursor);
    });
    $("communityComposerClose").addEventListener("click", closeCommunityComposer);
    $("communityComposerSubmit").addEventListener("click", function () {
      submitCommunityPost();
    });
    $("communityComposerModal").addEventListener("click", function (event) {
      if (event.target === $("communityComposerModal")) closeCommunityComposer();
    });
    $("communityComposerBody").addEventListener("input", function (event) {
      $("communityComposerCount").textContent = String((event.target.value || "").length) + "/2000";
    });
    $("communityComposerImages").addEventListener("change", function (event) {
      const files = Array.prototype.slice.call(event.target.files || []);
      if (files.length > 9) {
        showInlineMessage("首期最多上传 9 张图片。");
      }
      $("communityComposerFiles").textContent = files.length
        ? "已选择 " + Math.min(files.length, 9) + " 张：" + files.slice(0, 9).map(function (file) { return file.name; }).join("、")
        : "";
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
        writePlayerProgress({ id: state.player.contentId }, {
          eventName: "leave",
          positionSec: state.player.video.currentTime || 0,
          durationSec: state.player.video.duration || null,
          quality: "auto",
        });
      }
    });
    window.addEventListener("pagehide", function () {
      if (state.player.video && state.player.contentId) {
        writePlayerProgress({ id: state.player.contentId }, {
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
