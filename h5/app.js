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
    single_channel_delivery_unavailable: "单条购买内容当前仅支持站内 HLS 播放，不提供频道备用交付。",
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
      pagination: { page: 1, pageSize: 8, total: 0, totalPages: 1 },
      showExtraCategories: false,
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
      managed: false,
      playbackSessionId: "",
      deliveryVariant: "",
      hls: null,
      currentQuality: "auto",
      bufferStartedAt: 0,
      playRequestedAt: 0,
      prefetchContentId: "",
      prefetchedSession: null,
      previewHintShown: false,
      paywallShown: false,
      previewCompletionTracked: false,
    },
    trafficEntry: null,
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

  const H5_INSTALL_GUIDE_STORAGE_KEY = "samewave_h5_install_guide_seen_v1";
  const HOME_PROMO_DISMISS_PREFIX = "samewave_home_promo_dismissed_";
  // A generic inline avatar for device-based H5 sessions. It carries no user
  // identifier and remains available when an external Telegram image expires.
  const DEFAULT_ACCOUNT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%23794ee8'/%3E%3Cstop offset='1' stop-color='%232b2148'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='96' height='96' rx='48' fill='url(%23g)'/%3E%3Ccircle cx='48' cy='37' r='16' fill='%23f6f1ff' fill-opacity='.92'/%3E%3Cpath d='M19 84c4-17 16-25 29-25s25 8 29 25' fill='%23f6f1ff' fill-opacity='.92'/%3E%3C/svg%3E";
  let librarySearchTimer = 0;

  function isStandaloneH5() {
    return window.matchMedia && window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function isTouchFirstDevice() {
    return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  }

  function dismissInstallGuide() {
    $("installGuide").classList.add("is-hidden");
    try { window.localStorage.setItem(H5_INSTALL_GUIDE_STORAGE_KEY, "1"); } catch (_) {}
  }

  function showInstallGuideOnFirstH5Visit() {
    if (state.env.isTelegram || isStandaloneH5() || !isTouchFirstDevice()) return;
    try {
      if (window.localStorage.getItem(H5_INSTALL_GUIDE_STORAGE_KEY) === "1") return;
    } catch (_) {}
    $("installGuide").classList.remove("is-hidden");
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

  function accountAvatarUrl(session) {
    const candidate = session && session.identity === "telegram" ? String(session.photoUrl || "") : "";
    return /^https:\/\//i.test(candidate) ? candidate : DEFAULT_ACCOUNT_AVATAR;
  }

  function accountAvatarMarkup(session, className, alt) {
    return imageTag(accountAvatarUrl(session), className || "account-avatar-image", alt || "用户头像", true);
  }

  // A legacy catalog row can refer to a cover that has since been removed
  // from storage. Keep the card geometry stable rather than showing a broken
  // image icon or a black block; the API never falls back to a durable media
  // URL for this case.
  document.addEventListener("error", function (event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.dataset.fallbackApplied === "1") return;
    image.dataset.fallbackApplied = "1";
    if (image.classList.contains("account-avatar-image")) {
      image.src = DEFAULT_ACCOUNT_AVATAR;
      return;
    }
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
    state.player.previewHintShown = false;
    state.player.paywallShown = false;
    state.player.previewCompletionTracked = false;
  }

  function reportPlaybackError(detail, errorCode) {
    trackAnalytics("playback_error", {
      contentId: detail && detail.id ? detail.id : null,
      deliveryVariant: state.player.deliveryVariant || null,
      errorCode: errorCode || "unknown",
    });
  }

  function classifyPlaybackApiError(err) {
    var code = err && err.payload ? (err.payload.error || err.payload.errorClass || "") : "";
    if (code === "video_delivery_disabled") {
      return { errorCode: "playback_session_disabled", message: "试看暂时不可用，请稍后再试。", stage: "session" };
    }
    if (code === "video_delivery_not_configured") {
      return { errorCode: "playback_session_not_configured", message: "播放器仍在准备中，请稍后再试。", stage: "session" };
    }
    if (code === "video_not_ready") {
      return { errorCode: "playback_session_not_ready", message: "试看转码尚未完成，请稍后再试。", stage: "session" };
    }
    if (code === "playback_device_limit") {
      return { errorCode: "playback_session_device_limit", message: "当前播放设备数已达上限，请先关闭其他设备后再试。", stage: "session" };
    }
    if (code === "unauthorized") {
      return { errorCode: "playback_session_unauthorized", message: "请先完成登录后再试看。", stage: "session" };
    }
    if (code === "playback_session_inactive") {
      return { errorCode: "heartbeat_session_inactive", message: "当前试看会话已失效，请重新进入详情页再试。", stage: "heartbeat" };
    }
    return {
      errorCode: code ? "playback_session_" + code : "playback_session_failed",
      message: "创建播放会话失败，请稍后再试。",
      stage: "session",
    };
  }

  function classifyHlsFatalError(data) {
    var details = String(data && data.details || "").toLowerCase();
    var type = String(data && data.type || "").toLowerCase();
    var responseCode = data && data.response && data.response.code != null ? data.response.code : null;
    if (/manifest/.test(details)) {
      return {
        errorCode: responseCode ? "manifest_load_failed_" + responseCode : "manifest_load_failed",
        message: "试看清单加载失败，请稍后重试。",
        stage: "manifest",
      };
    }
    if (/frag|level|audio.*track|key.*load/.test(details)) {
      return {
        errorCode: responseCode ? "segment_load_failed_" + responseCode : "segment_load_failed",
        message: "试看分片加载失败，请检查网络后重试。",
        stage: "segment",
      };
    }
    if (type === "mediaerror" || /buffer|append|parsing|codec/.test(details)) {
      return {
        errorCode: "player_runtime_media_failed",
        message: "浏览器暂时无法解析当前试看流，请稍后重试。",
        stage: "player_runtime",
      };
    }
    return {
      errorCode: "player_runtime_failed",
      message: "播放器初始化失败，请稍后重试。",
      stage: "player_runtime",
    };
  }

  function classifyVideoPlayError(err) {
    var name = String(err && err.name || "").toLowerCase();
    if (name === "notallowederror") {
      return {
        errorCode: "video_play_blocked",
        message: "浏览器阻止了自动播放，请再次点击试看。",
        stage: "player_runtime",
      };
    }
    if (name === "aborterror") {
      return {
        errorCode: "video_play_aborted",
        message: "试看初始化被中断，请重新点击试看。",
        stage: "player_runtime",
      };
    }
    return {
      errorCode: "video_play_failed",
      message: "播放器启动失败，请稍后重试。",
      stage: "player_runtime",
    };
  }

  function classifyVideoElementError(video) {
    var code = video && video.error ? Number(video.error.code || 0) : 0;
    if (code === 2) {
      return { errorCode: "video_network_failed", message: "试看媒体加载失败，请检查网络后重试。", stage: "segment" };
    }
    if (code === 3) {
      return { errorCode: "video_decode_failed", message: "浏览器无法解码当前试看流，请稍后重试。", stage: "player_runtime" };
    }
    if (code === 4) {
      return { errorCode: "video_src_not_supported", message: "当前浏览器暂不支持该试看流。", stage: "player_runtime" };
    }
    return { errorCode: "video_element_failed", message: "播放器发生未知错误，请稍后重试。", stage: "player_runtime" };
  }

  function surfacePlaybackFailure(detail, classification) {
    var classified = classification || { errorCode: "unknown", message: "试看暂时不可用，请稍后再试。", stage: "player_runtime" };
    reportPlaybackError(detail, classified.errorCode);
    showInlineMessage(classified.message);
    return classified;
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

  function createManagedRequest(url, init, detail) {
    const request = new Request(url, Object.assign({}, init || {}, {
      credentials: "include",
      cache: "no-store",
      headers: Object.assign({}, (init && init.headers) || {}, {
        "Cache-Control": state.player.deliveryVariant === "full" ? "no-store" : "no-cache",
        Pragma: "no-cache",
      }),
    }));
    return request;
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
          return createManagedRequest(context.url, init, detail);
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
          surfacePlaybackFailure(detail, classifyHlsFatalError(data));
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
      var classifiedApiError = classifyPlaybackApiError(err);
      reportPlaybackError(detail, classifiedApiError.errorCode);
      if (detail.previewUrl) {
        showInlineMessage("完整播放暂时不可用，先为你展示当前试看。");
        playInlineDetailVideo();
        return;
      }
      if (detail.unlocked) {
        showInlineMessage("完整 Web 播放仍保持关闭，请先使用 Telegram 备用观看。");
        return;
      }
      showInlineMessage(classifiedApiError.message);
      return;
    }

    state.player.managed = true;
    state.player.playbackSessionId = created.sessionId || "";
    state.player.deliveryVariant = created.deliveryVariant || "";
    try {
      loadManagedVideoSource(video, created.manifestUrl, detail);
    } catch (err) {
      surfacePlaybackFailure(detail, {
        errorCode: "player_init_threw",
        message: "播放器初始化失败，请稍后重试。",
        stage: "player_runtime",
      });
      return;
    }
    const gate = $("previewUpgradeGate");
    if (gate) gate.classList.add("is-hidden");
    const playback = video.play();
    if (playback && typeof playback.catch === "function") playback.catch(function (err) {
      surfacePlaybackFailure(detail, classifyVideoPlayError(err));
    });
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

  function clearLandingQueryParams() {
    const url = new URL(window.location.href);
    ["content", "te", "category", "package", "membership"].forEach(function (key) {
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
      return { view: "tab", id: "", tab: "membership", fromTab: "home", packageId: queryPackageId };
    }
    if (queryParams.get("membership") === "1") {
      return { view: "tab", id: "", tab: "membership", fromTab: "home" };
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
    if (params.get("view") === "wallet") {
      return { view: "wallet", id: "", tab: "me", fromTab: "me" };
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
    return { view: "tab", id: "", tab: tab, fromTab: tab, categoryId: params.get("categoryId") || "" };
  }

  function setHashForTab(tab, categoryId) {
    clearLandingQueryParams();
    const params = new URLSearchParams();
    params.set("tab", tab);
    if (tab === "library" && categoryId && categoryId !== "all") params.set("categoryId", categoryId);
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

  function setHashForWallet() {
    clearLandingQueryParams();
    const params = new URLSearchParams();
    params.set("view", "wallet");
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

  function copyText(value, successMessage) {
    const text = String(value || "");
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showInlineMessage(successMessage || "已复制"); }).catch(function () { showInlineMessage("复制失败，请长按选择复制。"); });
      return;
    }
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "readonly");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    try { document.execCommand("copy"); showInlineMessage(successMessage || "已复制"); } catch (_) { showInlineMessage("复制失败，请长按选择复制。"); }
    document.body.removeChild(input);
  }

  function createSkeletonCards(count) {
    const out = [];
    for (let i = 0; i < count; i += 1) out.push('<div class="skeleton"></div>');
    return out.join("");
  }

  function getAccessLabel(item) {
    if (item.unlocked) return "已解锁";
    if (item.accessType === "public") return "公开预览";
    if (item.accessType === "single") return "单条解锁";
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
      node.querySelector(".card-tag").textContent = item.categoryName || (item.tags || []).join(" · ") || getAccessLabel(item);
      node.querySelector(".card-title").textContent = item.title || "未命名内容";
      node.querySelector(".card-desc").textContent =
        [item.categoryName, formatDateShort(item.publishedAt)].filter(Boolean).join(" · ")
        || item.description
        || "暂无描述";
      node.querySelector(".card-price").textContent = item.accessType === "public"
        ? "公开预览"
        : formatAvailablePrices(item);
      node.querySelector(".card-access").textContent = getAccessLabel(item);
      const card = node.querySelector(".content-card");
      const openDetail = function () {
        openContentDetail(item.id, fromTab, { autoplay: false, resumePositionSec: 0 });
      };
      card.addEventListener("click", openDetail);
      card.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openDetail();
      });
      host.appendChild(node);
    });
  }

  function renderBannerList() {
    const home = state.home;
    const host = $("homeBannerList");
    const section = document.querySelector(".home-banner-section");
    host.innerHTML = "";
    const banners = home && home.banners ? home.banners.filter(function (banner) { return banner.slot !== "home_popup"; }) : [];
    if (!banners.length) {
      if (section) section.classList.add("is-hidden");
      return;
    }
    if (section) section.classList.remove("is-hidden");
    banners.forEach(function (banner) {
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

  function renderHomePopup() {
    const modal = $("homePromoModal");
    const popup = state.home && state.home.banners
      ? state.home.banners.find(function (banner) { return banner.slot === "home_popup"; })
      : null;
    const isHome = state.route && state.route.view === "tab" && state.route.tab === "home";
    if (!popup || !isHome) {
      modal.classList.add("is-hidden");
      return;
    }
    const storageKey = HOME_PROMO_DISMISS_PREFIX + popup.id;
    try {
      if (window.sessionStorage.getItem(storageKey) === "1") {
        modal.classList.add("is-hidden");
        return;
      }
    } catch (_) {}
    $("homePromoImage").innerHTML = imageTag(popup.imageUrl, "home-promo-cover", popup.title || "首页活动", true);
    $("homePromoTitle").textContent = popup.title || "发现本周精选";
    $("homePromoLabel").textContent = popup.actionLabel || "查看详情";
    modal.classList.remove("is-hidden");
    $("homePromoClose").onclick = function () {
      try { window.sessionStorage.setItem(storageKey, "1"); } catch (_) {}
      modal.classList.add("is-hidden");
    };
    $("homePromoAction").onclick = function () {
      try { window.sessionStorage.setItem(storageKey, "1"); } catch (_) {}
      modal.classList.add("is-hidden");
      handleBannerAction(popup);
    };
  }

  function renderFeaturedCard() {
    const host = $("homeFeaturedCard");
    const section = document.querySelector(".home-featured-section");
    const featured = state.home && state.home.featuredContent ? state.home.featuredContent : null;
    if (!featured) {
      if (section) section.classList.add("is-hidden");
      host.innerHTML = "";
      return;
    }
    if (section) section.classList.remove("is-hidden");
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
      '<article class="resume-card resume-card-compact">' +
      '<button class="resume-inline-copy" type="button" aria-label="继续播放 ' + escapeHtml(recent.title) + '">' +
      '<span class="resume-inline-label">继续播放</span>' +
      '<strong>' + escapeHtml(recent.title || "未命名内容") + '</strong>' +
      '<span class="resume-inline-meta">' + escapeHtml(getLastPlayedSubtitle(recent)) + '</span>' +
      '</button>' +
      '<div class="resume-inline-actions">' +
      '<span class="resume-inline-progress" aria-hidden="true"><span style="width:' + escapeHtml(String(Math.max(0, Math.min(100, recent.progressPercent || 0)))) + '%"></span></span>' +
      '<button class="primary-button" type="button">继续播放</button>' +
      "</div>" +
      "</article>";
    host.querySelector(".resume-inline-copy").addEventListener("click", function () {
      openContentDetail(recent.contentId, "home", { autoplay: true, resumePositionSec: recent.resumePositionSec || 0 });
    });
    host.querySelector(".resume-inline-actions .primary-button").addEventListener("click", function () {
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
        '<div class="desktop-profile-identity">' +
          '<span class="account-avatar desktop-account-avatar">' + accountAvatarMarkup(state.session, "account-avatar-image", "用户头像") + '</span>' +
          '<div><p class="eyebrow">MY ACCOUNT</p>' +
          '<strong>' + escapeHtml(profileName) + '</strong></div>' +
        '</div>' +
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
      .slice(0, 6);
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
      const sample = ((state.home.latestContents || []).concat(state.home.contents || [])).find(function (item) {
        return item.categoryId === theme.id || (item.categories || []).some(function (category) { return category.id === theme.id; });
      });
      card.className = "popular-type-card" + (sample && sample.coverUrl ? " has-image" : "");
      card.innerHTML =
        imageTag(sample && sample.coverUrl, "popular-type-image", theme.name || "热门类型", true) +
        '<span class="popular-type-shade"></span>' +
        '<span class="popular-type-copy"><strong>' + escapeHtml(theme.name) + '</strong><small>' +
          escapeHtml(String(theme.publishedContentCount || 0)) + ' 条内容</small></span>';
      card.addEventListener("click", function () {
        setHashForTab("library", theme.id);
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
    if (state.home.latestContents && state.home.latestContents.length) {
      renderContentCards("homeLatestGrid", state.home.latestContents || [], "home");
    } else {
      $("homeLatestGrid").innerHTML = '<div class="empty-state">内容即将上线</div>';
    }
    renderDesktopRail();
    renderHomePopup();
    updatePageSeo(state.home.seo || null);
    updateOgImage("");
    updateJsonLd(null);
  }

  function getLibraryPageSize() {
    return window.innerWidth >= 1024 ? 12 : 8;
  }

  function shouldUseLibraryInfiniteScroll() {
    return window.innerWidth < 768;
  }

  function libraryHasMorePages() {
    const pagination = state.library.pagination || { page: 1, totalPages: 1 };
    return pagination.page < pagination.totalPages;
  }

  function renderLibraryCategories() {
    const host = $("libraryCategoryList");
    const extraHost = $("libraryCategoryExtras");
    const moreButton = $("libraryCategoryMoreButton");
    const categories = (state.home && state.home.categories) || [];
    host.innerHTML = "";
    extraHost.innerHTML = "";

    const renderCategoryChip = function (category, targetHost, closeAfterSelect) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip" + (state.library.categoryId === category.id ? " is-active" : "");
      btn.textContent = category.name;
      btn.addEventListener("click", function () {
        state.library.categoryId = category.id;
        if (closeAfterSelect) state.library.showExtraCategories = false;
        loadLibrary();
      });
      targetHost.appendChild(btn);
    };

    // 分类是发现内容的主要入口，不能因为屏幕较窄而静默隐藏。
    // 移动端交由 CSS 横向滚动承载全部标签，桌面端自然换行展示。
    categories.forEach(function (category) {
      renderCategoryChip(category, host, false);
    });
    moreButton.classList.add("is-hidden");
    moreButton.setAttribute("aria-expanded", "false");
    extraHost.classList.add("is-hidden");
  }

  function renderLibrary() {
    renderLibraryCategories();
    if (state.library.loading) {
      $("libraryState").textContent = "片库加载中…";
      $("libraryGrid").innerHTML = createSkeletonCards(6);
      $("libraryLoadMoreButton").classList.add("is-hidden");
      $("libraryInfiniteSentinel").classList.add("is-hidden");
      return;
    }
    const items = state.library.items || [];
    const pagination = state.library.pagination || { page: 1, pageSize: getLibraryPageSize(), total: items.length, totalPages: 1 };
    const hasMorePages = pagination.page < pagination.totalPages;
    const useInfiniteScroll = shouldUseLibraryInfiniteScroll();
    $("libraryState").textContent = items.length
      ? "共 " + pagination.total + " 条内容" + (state.library.search ? " · 搜索“" + state.library.search + "”" : "")
      : "没有匹配结果。";
    if (!items.length) {
      $("libraryGrid").innerHTML = '<div class="inline-state">当前没有匹配内容。</div>';
      $("libraryLoadMoreButton").classList.add("is-hidden");
      $("libraryInfiniteSentinel").classList.add("is-hidden");
      return;
    }
    renderContentCards("libraryGrid", items, "library");
    $("libraryLoadMoreButton").classList.toggle("is-hidden", useInfiniteScroll || !hasMorePages);
    $("libraryInfiniteSentinel").classList.toggle("is-hidden", !useInfiniteScroll || !hasMorePages);
    if (useInfiniteScroll && hasMorePages) {
      window.setTimeout(maybeLoadLibraryOnScroll, 0);
    }
  }

  function maybeLoadLibraryOnScroll() {
    if (!shouldUseLibraryInfiniteScroll()) return;
    if (!state.route || state.route.view !== "tab" || state.route.tab !== "library") return;
    if (state.library.loading || !libraryHasMorePages()) return;
    const sentinel = $("libraryInfiniteSentinel");
    if (!sentinel || sentinel.classList.contains("is-hidden")) return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.top <= window.innerHeight + 120) {
      loadLibrary({ append: true });
    }
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
        : "完成支付后即可在网页、H5 与 Mini App 观看全部会员内容。") + '</p>' +
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
      $("membershipHeadline").textContent = "会员权益已生效";
      $("membershipCopy").textContent = "有效期内可在网页、H5 与 Mini App 观看全部会员内容；频道与 Bot 是可选的关注入口。";
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
      membershipHost.innerHTML = '<div class="inline-state">当前还没有配置月度会员商品。</div>';
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
        '<div class="stack-meta"><span>' + escapeHtml(formatAvailablePrices(item)) + '</span><span>' + escapeHtml(item.unlocked ? "可直接观看包内内容" : "购买后解锁包内完整内容") + "</span></div>" +
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
        '<div class="channel-actions" style="margin-top:12px;"><button class="primary-button" type="button">查看内容</button></div>';
      card.querySelector("button").addEventListener("click", function () {
        openContentDetail(item.id, "me", { autoplay: item.accessType === "single" || item.accessType === "membership", resumePositionSec: 0 });
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
      primary.textContent = order.status === "pending"
        ? "继续支付"
        : order.status === "paid"
          ? "查看内容"
          : "查看内容";
      primary.addEventListener("click", function () {
        if (order.status === "pending") {
          var paymentMethod = order.paymentMethod === "telegram_stars" ? "stars" : "usdt";
          openCheckoutPage({ orderNo: order.orderNo, paymentMethod: paymentMethod });
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
    const profileName = session && session.displayName ? session.displayName : "同频成员";
    $("profileTitle").textContent = isTelegram
      ? "我的昵称 · " + profileName
      : profileName;
    $("profileSubtitle").textContent = isTelegram
      ? "已连接 Telegram，可跨设备恢复订单与权益。"
      : "已自动登录；绑定 Telegram 后可跨设备恢复订单与权益。";
    const profileAvatar = $("profileAvatar");
    if (profileAvatar) profileAvatar.src = accountAvatarUrl(session);

    const membershipSummary = state.entitlements.data && state.entitlements.data.summary
      ? state.entitlements.data.summary.membership
      : { status: "none", expiresAt: null };
    $("meMembershipText").textContent = membershipSummary.status === "active"
      ? (membershipSummary.expiresAt ? "已开通至 " + formatDateShort(membershipSummary.expiresAt) : "已开通")
      : "未开通";
    $("meMembershipHint").textContent = membershipSummary.status === "active"
      ? "会员有效期内可直接观看全部会员内容；可在「会员」页续费。"
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

  function renderWallet() {
    const membershipSummary = state.entitlements.data && state.entitlements.data.summary
      ? state.entitlements.data.summary.membership
      : { status: "none", expiresAt: null };
    const active = membershipSummary.status === "active";
    $("walletMembershipStatus").textContent = active ? "已开通" : "未开通";
    $("walletMembershipExpiry").textContent = active
      ? (membershipSummary.expiresAt ? "有效至 " + formatDateShort(membershipSummary.expiresAt) : "会员权益有效")
      : "开通后即可观看会员完整内容。";
    $("walletMembershipCopy").textContent = active
      ? "会员已生效。支付记录与待处理订单统一保存在这里。"
      : "在这里查看订单、继续支付待完成订单，或前往会员页开通权益。";

    const host = $("walletOrdersList");
    host.innerHTML = "";
    if (state.orders.loading) {
      host.innerHTML = createSkeletonCards(2);
      return;
    }
    if (!state.orders.items.length) {
      host.innerHTML = '<div class="inline-state">暂无支付记录。开通会员或解锁一条内容后，账单会显示在这里。</div>';
      return;
    }
    state.orders.items.slice(0, 20).forEach(function (order) {
      const card = document.createElement("article");
      card.className = "stack-card wallet-order-card";
      const method = order.paymentMethod === "telegram_stars" ? "Telegram Stars" : "USDT-TRC20";
      const statusText = order.status === "paid" ? "已支付" : order.status === "pending" ? "待支付" : order.status;
      card.innerHTML =
        '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(order.product && order.product.title ? order.product.title : "内容订单") +
        '</div><div class="stack-subtitle">' + escapeHtml(method) + ' · ' + escapeHtml(formatDate(order.createdAt)) +
        '</div></div><div class="status-badge' + (order.status === "pending" ? " status-warning" : "") + '">' + escapeHtml(statusText) +
        '</div></div><div class="stack-meta"><span>' + escapeHtml(formatPriceMinor(order.amountMinor, order.currency)) + '</span><span>订单号 ' + escapeHtml(order.orderNo) +
        '</span></div><div class="wallet-order-actions"></div>';
      const actions = card.querySelector(".wallet-order-actions");
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "ghost-button";
      copyButton.textContent = "复制订单号";
      copyButton.addEventListener("click", function () { copyText(order.orderNo, "订单号已复制"); });
      actions.appendChild(copyButton);
      if (order.status === "pending") {
        const payButton = document.createElement("button");
        payButton.type = "button";
        payButton.className = "primary-button";
        payButton.textContent = "继续支付";
        payButton.addEventListener("click", function () {
          openCheckoutPage({ orderNo: order.orderNo, paymentMethod: order.paymentMethod === "telegram_stars" ? "stars" : "usdt" });
        });
        actions.appendChild(payButton);
      }
      host.appendChild(card);
    });
  }

  function pendingOrderForProduct(productId) {
    return (state.orders.items || []).find(function (order) {
      return ["pending", "processing"].indexOf(order.status) >= 0 && order.product && order.product.id === productId;
    }) || null;
  }

  function getPreviewDurationSeconds(detail) {
    const seconds = Number(detail && detail.previewDurationSeconds);
    return seconds > 0 ? Math.floor(seconds) : 60;
  }

  function isPreviewPlaybackActive() {
    return !state.player.deliveryVariant || state.player.deliveryVariant === "preview";
  }

  function getPlaybackAnalyticsEventName(prefix) {
    return isPreviewPlaybackActive() ? "preview_" + prefix : "playback_" + prefix;
  }

  function getPurchaseActionText(detail) {
    if (!detail) return "立即购买";
    if (detail.accessType === "single") return "解锁本视频";
    if (detail.accessType === "package") return "解锁内容包";
    return "开通会员";
  }

  function getProductActionText(product, detail) {
    if (product && product.type === "single") return "单条解锁";
    if (product && product.type === "package") return "解锁内容包";
    return getPurchaseActionText(detail);
  }

  function getDetailUnlockProduct(detail) {
    return detail && detail.unlockProduct ? detail.unlockProduct : null;
  }

  function getCheckoutReturnTarget(detail) {
    if (detail && detail.id) {
      var params = new URLSearchParams();
      params.set("view", "content");
      params.set("id", detail.id);
      params.set("from", state.route && state.route.fromTab ? state.route.fromTab : "home");
      return "#" + params.toString();
    }
    return window.location.hash || "#tab=home";
  }

  function getPaywallGateNote(detail, pendingOrder) {
    if (pendingOrder) {
      return "检测到待支付订单，继续支付后即可立刻观看完整内容。";
    }
    if (!detail) return "完整内容仅对已解锁用户开放。";
    if (detail.accessType === "membership") {
      var unlockProduct = getDetailUnlockProduct(detail);
      return detail.product && detail.product.usdtPriceMinor
        ? "完整内容仅限会员观看。" + formatPriceMinor(detail.product.usdtPriceMinor, "USDT") + " / 月。"
          + (unlockProduct && unlockProduct.usdtPriceMinor ? " 也可单条解锁：" + formatPriceMinor(unlockProduct.usdtPriceMinor, "USDT") + "。" : "")
        : "完整内容仅限会员观看，开通后可继续播放。" + (unlockProduct ? " 如已配置，也可选择单条解锁。" : "");
    }
    if (detail.accessType === "single") {
      return detail.product && detail.product.usdtPriceMinor
        ? "解锁当前视频后即可继续完整播放。" + formatPriceMinor(detail.product.usdtPriceMinor, "USDT") + "。"
        : "解锁当前视频后即可继续完整播放。";
    }
    if (detail.accessType === "package") {
      return "解锁所属内容包后即可继续观看完整内容。";
    }
    return "完整内容仅对已解锁用户开放。";
  }

  function openCheckoutPage(query) {
    var params = [];
    Object.keys(query || {}).forEach(function (key) {
      if (query[key] == null || query[key] === "") return;
      params.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(query[key])));
    });
    window.location.assign("/h5-pay.html" + (params.length ? "?" + params.join("&") : ""));
  }

  async function continueStarsOrderAndPay(order, detail) {
    if (!order || !order.orderNo) {
      showInlineMessage("待支付订单不存在或已失效。");
      return;
    }
    var returnTo = getCheckoutReturnTarget(detail);
    if (!tg || typeof tg.openInvoice !== "function") {
      openCheckoutPage({ orderNo: order.orderNo, paymentMethod: "stars", returnTo: returnTo });
      return;
    }
    try {
      const resp = await apiCall("/api/orders/" + encodeURIComponent(order.orderNo) + "/continue-stars", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const invoiceLink = resp && resp.invoiceLink ? resp.invoiceLink : null;
      if (!invoiceLink) {
        openCheckoutPage({ orderNo: order.orderNo, paymentMethod: "stars", returnTo: returnTo });
        return;
      }
      tg.openInvoice(invoiceLink, function (status) {
        loadOrders();
        loadEntitlements();
        if (status === "paid") {
          showInlineMessage("Stars 支付成功，正在刷新权益。");
          state.detailCache = {};
          renderDetail(detail.id);
          return;
        }
        if (status === "pending") {
          showInlineMessage("Stars 支付处理中，请稍后查看订单状态。");
          return;
        }
        if (status === "cancelled") {
          showInlineMessage("已保留待支付订单，可稍后继续支付。");
          return;
        }
        showInlineMessage("Stars 支付未完成，请稍后重试。");
      });
    } catch (err) {
      showInlineMessage("继续 Stars 支付失败：" + apiText(err));
    }
  }

  function continuePendingOrder(order, detail) {
    if (!order || !order.orderNo) {
      showInlineMessage("未找到可继续的订单。");
      return;
    }
    var paymentMethod = order.paymentMethod === "telegram_stars" ? "telegram_stars" : "usdt_trc20";
    trackAnalytics("checkout_open", {
      contentId: detail && detail.id ? detail.id : null,
      orderNo: order.orderNo,
      productId: order.product && order.product.id ? order.product.id : null,
      paymentMethod: paymentMethod,
      reopen: true,
    });
    if (paymentMethod === "telegram_stars") {
      void continueStarsOrderAndPay(order, detail);
      return;
    }
    openCheckoutPage({ orderNo: order.orderNo, paymentMethod: "usdt", returnTo: getCheckoutReturnTarget(detail) });
  }

  function showPreviewUpgradeGate(detail, options) {
    var gate = $("previewUpgradeGate");
    var hint = $("previewEndingHint");
    var note = $("previewUpgradeNote");
    if (hint) hint.classList.add("is-hidden");
    if (!gate || state.player.paywallShown) return;
    state.player.paywallShown = true;
    gate.classList.remove("is-hidden");
    if (note) {
      var pendingOrder = detail && detail.product ? pendingOrderForProduct(detail.product.id) : null;
      note.textContent = getPaywallGateNote(detail, pendingOrder);
    }
    trackAnalytics("paywall_shown", {
      contentId: detail && detail.id ? detail.id : null,
      accessType: detail && detail.accessType ? detail.accessType : null,
      trigger: options && options.trigger ? options.trigger : "preview_limit",
      positionSec: options && options.positionSec != null ? options.positionSec : null,
    });
  }

  function completePreviewPlayback(detail, positionSec, durationSec) {
    if (state.player.previewCompletionTracked) return;
    state.player.previewCompletionTracked = true;
    trackAnalytics("preview_completed", {
      contentId: detail && detail.id ? detail.id : null,
      deliveryVariant: state.player.deliveryVariant || "preview",
    });
    writePlayerProgress(detail, {
      eventName: "complete",
      positionSec: positionSec || 0,
      durationSec: durationSec || detail.durationSeconds || null,
      quality: state.player.currentQuality || "auto",
    });
  }

  function getPrimaryDetailAction(detail) {
    const playback = getDetailPlaybackStatus(detail);
    const pendingOrder = detail && detail.product ? pendingOrderForProduct(detail.product.id) : null;
    if (playback && !playback.errorClass && playback.action === "play_full") {
      return { text: "观看完整视频", handler: function () { startManagedPlayback(detail); } };
    }
    if (detail.unlocked && detail.accessType === "single") {
      return {
        text: playback && playback.action === "processing" ? "转码处理中" : "观看完整视频",
        handler: function () {
          if (playback && !playback.errorClass && playback.action === "play_full") {
            startManagedPlayback(detail);
            return;
          }
          showInlineMessage("完整视频正在准备中，请稍后再试。");
        },
      };
    }
    if (detail.unlocked) {
      return {
        text: playback && playback.action === "processing" ? "转码处理中" : "观看完整视频",
        handler: function () {
          if (playback && !playback.errorClass && playback.action === "play_full") {
            startManagedPlayback(detail);
            return;
          }
          showInlineMessage("完整视频正在准备中，请稍后再试。");
        },
      };
    }
    if (pendingOrder) {
      return { text: "继续支付", handler: function () { continuePendingOrder(pendingOrder, detail); } };
    }
    if (playback && playback.action === "processing") {
      return { text: "转码处理中", handler: function () { showInlineMessage("视频转码处理中，请稍后再试。"); } };
    }
    if (playback && !playback.errorClass && playback.action === "preview") {
      return { text: getPurchaseActionText(detail), handler: function () { startPurchase(detail); } };
    }
    if (detail.previewUrl) {
      return { text: getPurchaseActionText(detail), handler: function () { startPurchase(detail); } };
    }
    if (detail.accessType === "membership") {
      return { text: "开通会员", handler: function () { startPurchase(detail); } };
    }
    if (detail.accessType === "single") {
      return { text: "解锁本视频", handler: function () { startPurchase(detail); } };
    }
    if (detail.accessType === "package") {
      return { text: "解锁内容包", handler: function () { startPurchase(detail); } };
    }
    return { text: "查看频道预览", handler: function () { openChannelAccess(detail.id); } };
  }

  function renderDetailTags(detail) {
    const tags = [];
    if (detail && detail.accessType) tags.push(getAccessLabel(detail));
    if (detail && Array.isArray(detail.tags)) {
      detail.tags.forEach(function (tag) {
        if (tag && tags.indexOf(tag) < 0) tags.push(tag);
      });
    }
    if (detail && Array.isArray(detail.categories)) {
      detail.categories.forEach(function (category) {
        if (category && category.name && tags.indexOf(category.name) < 0) tags.push(category.name);
      });
    }
    return tags.slice(0, 6).map(function (tag) {
      return '<span class="detail-tag">' + escapeHtml(tag) + '</span>';
    }).join("");
  }

  function renderDetailDescription(detail) {
    const description = escapeHtml(detail && detail.description ? detail.description : "暂无内容介绍。");
    const expandable = String(detail && detail.description || "").length > 72;
    return '<div id="detailDescription" class="detail-description">' +
      '<div class="detail-description-copy">' + description + '</div>' +
      (expandable ? '<button id="detailDescriptionToggle" class="detail-description-toggle" type="button">展开简介</button>' : '') +
      '</div>';
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
    // 应用详情页不输出付费内容元数据给 OG/JSON-LD；公开发现只由首页和片库承担。
    updatePageSeo(null);
    updateOgImage("");
    updateJsonLd(null);

    const playback = getDetailPlaybackStatus(detail);
    const primaryAction = getPrimaryDetailAction(detail);
    const pendingOrder = detail.product ? pendingOrderForProduct(detail.product.id) : null;
    const unlockProduct = getDetailUnlockProduct(detail);
    const unlockPendingOrder = unlockProduct ? pendingOrderForProduct(unlockProduct.id) : null;
    // 详情页只保留一个 16:9 媒体位：有试看直接播放试看；无试看才展示封面。
    // 这样不会把同一张封面和同一段视频上下重复展示，首屏也更聚焦。
    const managedPlaybackEnabled = hasManagedPlayback(detail);
    const canRenderPlayer = !!detail.previewUrl || managedPlaybackEnabled;
    const previewUpgradeEnabled = !detail.unlocked && !!detail.product &&
      (detail.accessType === "membership" || detail.accessType === "package" || detail.accessType === "single");
    const previewUpgradeText = pendingOrder ? "继续支付" : getPurchaseActionText(detail);
    const mediaLabel = playback && playback.action === "play_full"
      ? ""
      : '<div class="detail-media-label"><strong>免费试看</strong><span>试看不需要开通会员</span></div>';
    const mediaSlot = canRenderPlayer
      ? '<section class="detail-media detail-media-preview" aria-label="免费试看">' +
        '<video class="detail-preview-video" controls playsinline preload="metadata"' +
          (detail.previewUrl ? ' src="' + escapeHtml(detail.previewUrl) + '"' : "") +
          (detail.coverUrl ? ' poster="' + escapeHtml(detail.coverUrl) + '"' : '') + '>' +
          '当前浏览器不支持视频在线播放。' +
        '</video>' +
        '<div id="previewEndingHint" class="detail-preview-hint is-hidden" role="status" aria-live="polite">完整内容将在 <strong id="previewEndingCountdown">10</strong> 秒后结束试看</div>' +
        mediaLabel +
        (previewUpgradeEnabled
          ? '<div id="previewUpgradeGate" class="detail-preview-gate is-hidden" role="status" aria-live="polite">' +
            '<div class="detail-preview-gate-copy"><span>试看结束</span><strong>开通后继续观看完整内容</strong>' +
            '<p id="previewUpgradeNote" class="detail-preview-gate-note">' + escapeHtml(getPaywallGateNote(detail, pendingOrder)) + '</p>' +
            '<button id="previewUpgradeButton" class="primary-button" type="button">' + escapeHtml(previewUpgradeText) + '</button>' +
            (unlockProduct
              ? '<button id="previewSecondaryUnlockButton" class="ghost-button" type="button">' +
                escapeHtml(unlockPendingOrder ? "继续单条解锁" : getProductActionText(unlockProduct, detail)) +
                '</button>'
              : '') +
            '</div>' +
            '</div>'
          : '') +
        '</section>'
      : '<div class="detail-cover' + (detail.coverUrl ? ' has-image' : '') + '">' +
        imageTag(detail.coverUrl, "detail-image", detail.title || "内容封面", true) +
        '</div>';
    $("detailContent").innerHTML =
      mediaSlot +
      '<div class="detail-copy">' +
      '<h2>' + escapeHtml(detail.title || "") + '</h2>' +
      '<div class="detail-meta"><span>' + escapeHtml(detail.duration || "—") + '</span><span>' + escapeHtml(detail.categories && detail.categories[0] ? detail.categories[0].name : "未分类") + '</span><span>' + escapeHtml(formatDateShort(detail.publishedAt)) + '</span></div>' +
      '<div class="detail-tags">' + renderDetailTags(detail) + '</div>' +
      renderDetailDescription(detail) +
      '<div class="detail-status-card">' +
      '<div class="stack-head"><div><div class="stack-title">' + escapeHtml(playback && playback.action === "play_full"
        ? "已解锁，可直接观看"
        : detail.unlocked
          ? "已解锁，可直接观看"
          : getAccessLabel(detail)) + '</div>' +
      '<div class="stack-subtitle">' + escapeHtml(playback && playback.action === "play_full"
        ? "你的会员权益已生效，可观看完整视频。"
        : playback && playback.action === "preview" && !playback.errorClass
          ? "当前可直接试看；试看结束后可继续开通对应权益。"
          : detail.unlocked && playback && playback.errorClass
            ? "当前已解锁，完整视频正在准备中。"
          : detail.unlocked
        ? "该内容已归属到你当前账户的有效权益，可直接请求完整播放。"
        : detail.accessType === "membership"
          ? "开通会员后可在网页、H5 与 Mini App 观看完整内容。"
          : detail.accessType === "single"
            ? "可先试看，再解锁当前视频的完整内容。"
          : detail.accessType === "package"
            ? "该内容通过所属内容包频道交付。"
            : "该内容为公开预览，可直接查看。") + '</div></div>' +
      '<div class="status-badge' + ((playback && playback.action === "play_full") || detail.unlocked ? "" : " status-warning") + '">' +
      escapeHtml((playback && playback.action === "play_full") || detail.unlocked ? "已解锁" : "未解锁") + "</div></div>" +
      (pendingOrder ? '<div class="stack-note">当前有待支付订单：' + escapeHtml(pendingOrder.orderNo) + '，可直接点击「继续支付」恢复当前订单。</div>' : "") +
      '</div>' +
      (detail.accessType !== "public" ? '<div class="detail-purchase-list"></div>' : "") +
      '<div class="sticky-action-bar"><button id="detailPrimaryButton" class="primary-button" type="button">' + escapeHtml(primaryAction.text) + '</button><button id="detailBackButton" class="ghost-button" type="button">返回</button></div>' +
      "</div>";

    const purchaseHost = $("detailContent").querySelector(".detail-purchase-list");
    if (purchaseHost) {
      if (detail.accessType === "membership") {
        purchaseHost.innerHTML =
          '<div class="detail-purchase-item"><strong>推荐购买方式</strong><p class="detail-note">开通会员后，可在网页、H5 与 Mini App 观看全部会员内容。' +
          (state.env.isTelegram
            ? ' 请使用 Telegram Stars 完成开通。'
            : (detail.product && detail.product.usdtPriceMinor
              ? ' 站外 H5 支持 USDT-TRC20：' + escapeHtml(formatPriceMinor(detail.product.usdtPriceMinor, "USDT")) + '。'
              : '')) + '</p></div>';
        if (unlockProduct) {
          purchaseHost.innerHTML +=
            '<div class="detail-purchase-item"><strong>或单条解锁</strong><p class="detail-note">' +
            escapeHtml(unlockPendingOrder
              ? "当前有待支付的单条解锁订单，可直接继续完成支付。"
              : (unlockProduct.usdtPriceMinor
                ? "如果你只想观看这一条内容，也可以单条解锁：" + formatPriceMinor(unlockProduct.usdtPriceMinor, "USDT") + "。"
                : "如果你只想观看这一条内容，也可以直接单条解锁。")) +
            '</p><button id="detailSecondaryUnlockButton" class="ghost-button" type="button">' +
            escapeHtml(unlockPendingOrder ? "继续单条解锁" : "单条解锁") +
            '</button></div>';
        }
      } else if (detail.accessType === "single") {
        purchaseHost.innerHTML =
          '<div class="detail-purchase-item"><strong>单条解锁</strong><p class="detail-note">' +
          escapeHtml(pendingOrder
            ? "当前已存在待支付订单，继续支付后即可观看完整视频，系统不会重复建单。"
            : "先免费试看，再解锁当前视频的完整内容。") +
          '</p></div>';
      } else if (detail.accessType === "package") {
        purchaseHost.innerHTML =
          '<div class="detail-purchase-item"><strong>推荐购买方式</strong><p class="detail-note">1. 解锁所属内容包；2. 若你已经拥有该包权益，可直接前往频道。</p></div>';
      }
    }

    $("detailPrimaryButton").addEventListener("click", primaryAction.handler);
    const previewUpgradeButton = $("previewUpgradeButton");
    if (previewUpgradeButton) previewUpgradeButton.addEventListener("click", function () {
      if (pendingOrder) {
        continuePendingOrder(pendingOrder, detail);
        return;
      }
      startPurchase(detail);
    });
    const previewSecondaryUnlockButton = $("previewSecondaryUnlockButton");
    if (previewSecondaryUnlockButton) previewSecondaryUnlockButton.addEventListener("click", function () {
      if (unlockPendingOrder) {
        continuePendingOrder(unlockPendingOrder, detail);
        return;
      }
      startPurchase(detail, { product: unlockProduct });
    });
    const detailSecondaryUnlockButton = $("detailSecondaryUnlockButton");
    if (detailSecondaryUnlockButton) detailSecondaryUnlockButton.addEventListener("click", function () {
      if (unlockPendingOrder) {
        continuePendingOrder(unlockPendingOrder, detail);
        return;
      }
      startPurchase(detail, { product: unlockProduct });
    });
    $("detailBackButton").addEventListener("click", function () {
      setHashForTab(state.route.fromTab || "home");
    });
    const detailDescriptionToggle = $("detailDescriptionToggle");
    if (detailDescriptionToggle) detailDescriptionToggle.addEventListener("click", function () {
      const container = $("detailDescription");
      if (!container) return;
      const expanded = container.classList.toggle("is-expanded");
      detailDescriptionToggle.textContent = expanded ? "收起简介" : "展开简介";
    });
    attachDetailPlayer(detail);
    void prefetchDetailPreview(detail);
    const shouldAutoPreview = !detail.unlocked && ((playback && !playback.errorClass && playback.action === "preview") || detail.previewUrl);
    const shouldResumePlayback = !!(state.resumeIntent && state.resumeIntent.contentId === detail.id && state.resumeIntent.autoplay);
    if (shouldAutoPreview || shouldResumePlayback) {
      window.setTimeout(function () {
        if (hasManagedPlayback(detail)) {
          void startManagedPlayback(detail);
          return;
        }
        playInlineDetailVideo();
      }, 0);
    }
  }

  function handleBannerAction(banner) {
    if (banner.targetType === "content" && banner.targetId) {
      openContentDetail(banner.targetId, "home", { autoplay: false, resumePositionSec: 0 });
      return;
    }
    if (banner.targetType === "category" && banner.targetId) {
      setHashForTab("library", banner.targetId);
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
          photoUrl: payload.user && payload.user.photoUrl ? payload.user.photoUrl : null,
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

  async function loadLibrary(options) {
    if (state.library.loading) return;
    state.library.loading = true;
    renderLibrary();
    try {
      const append = !!(options && options.append);
      const nextPage = append ? Math.max(1, Number(state.library.pagination.page || 1) + 1) : 1;
      const pageSize = getLibraryPageSize();
      const params = new URLSearchParams({
        page: String(nextPage),
        pageSize: String(pageSize),
        sort: state.library.sort,
      });
      if (state.library.categoryId) params.set("categoryId", state.library.categoryId);
      if (String(state.library.search || "").trim()) params.set("keyword", String(state.library.search || "").trim());
      const data = await apiCall("/api/contents?" + params.toString());
      const items = data.items || [];
      state.library.items = append
        ? state.library.items.concat(items.filter(function (item) {
            return !(state.library.items || []).some(function (existing) { return existing.id === item.id; });
          }))
        : items;
      state.library.loaded = true;
      state.library.pagination = data.pagination || { page: nextPage, pageSize: pageSize, total: state.library.items.length, totalPages: 1 };
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
      if (state.route && state.route.view === "wallet") renderWallet();
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
      if (state.route && state.route.view === "wallet") renderWallet();
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
    // A hidden detail view can otherwise keep its media element playing after
    // the user taps Back. Pause first so audio stops synchronously, then tear
    // down HLS and its source before the next route is rendered.
    if (activeVideo) {
      try { activeVideo.pause(); } catch (_) {}
      try { activeVideo.muted = true; } catch (_) {}
    }
    clearManagedPlaybackState();
    if (activeVideo) {
      try { activeVideo.removeAttribute("src"); activeVideo.load(); } catch (_) {}
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
    state.player.managed = false;
    state.player.currentQuality = "auto";
    state.player.bufferStartedAt = 0;
    state.player.previewHintShown = false;
    state.player.paywallShown = false;
    state.player.previewCompletionTracked = false;

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
        trackAnalytics(getPlaybackAnalyticsEventName("started"), {
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

    video.addEventListener("error", function () {
      surfacePlaybackFailure(detail, classifyVideoElementError(video));
    });

    video.addEventListener("stalled", function () {
      if (!state.player.managed) return;
      trackManagedAnalytics(detail, "playback_buffer_start", {
        bufferDurationMs: 0,
      });
    });

    video.addEventListener("loadeddata", function () {
      if (!state.player.managed) return;
      trackManagedAnalytics(detail, "playback_manifest_ready", {
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
      const isPreviewPlayback = !detail.unlocked && isPreviewPlaybackActive();
      if (isPreviewPlayback) {
        const previewDuration = getPreviewDurationSeconds(detail);
        const remainingSeconds = Math.max(0, previewDuration - current);
        const hint = $("previewEndingHint");
        const countdown = $("previewEndingCountdown");
        if (!state.player.previewHintShown && previewDuration > 10 && current >= previewDuration - 10 && current < previewDuration) {
          state.player.previewHintShown = true;
          if (hint) hint.classList.remove("is-hidden");
          if (countdown) countdown.textContent = String(Math.max(1, remainingSeconds));
          trackAnalytics("preview_upgrade_shown", {
            contentId: detail.id,
            accessType: detail.accessType,
            secondsRemaining: Math.max(1, remainingSeconds),
          });
        } else if (state.player.previewHintShown && !state.player.paywallShown && countdown) {
          countdown.textContent = String(Math.max(0, remainingSeconds));
        }
        if (!state.player.paywallShown && current >= previewDuration) {
          completePreviewPlayback(detail, Math.min(current, previewDuration), video.duration || detail.durationSeconds || previewDuration);
          try { video.pause(); } catch (_) {}
          showPreviewUpgradeGate(detail, { trigger: "preview_limit", positionSec: current });
          return;
        }
      }
      if (!video.__debugReportedOverFive && current > 5) {
        video.__debugReportedOverFive = true;
      }
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
      if (isPreviewPlaybackActive()) {
        completePreviewPlayback(detail, video.duration || video.currentTime || detail.durationSeconds || 0, video.duration || detail.durationSeconds || null);
      } else {
        trackAnalytics("playback_completed", {
          contentId: detail.id,
          deliveryVariant: state.player.deliveryVariant || "preview",
        });
        writePlayerProgress(detail, {
          eventName: "complete",
          positionSec: video.duration || video.currentTime || detail.durationSeconds || 0,
          durationSec: video.duration || detail.durationSeconds || null,
          quality: state.player.currentQuality || "auto",
        });
      }
      if (!detail.unlocked && detail.product && (detail.accessType === "membership" || detail.accessType === "package" || detail.accessType === "single")) {
        showPreviewUpgradeGate(detail, {
          trigger: "ended",
          positionSec: Math.floor(video.duration || video.currentTime || 0),
        });
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

  function choosePurchaseMethod(detail, productOverride) {
    return new Promise(function (resolve) {
      const product = productOverride || (detail && detail.product ? detail.product : null);
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

  async function startPurchase(detail, options) {
    const product = options && options.product ? options.product : (detail && detail.product ? detail.product : null);
    if (!detail || !product) {
      showInlineMessage("当前内容没有可用商品。");
      return;
    }
    const pendingOrder = pendingOrderForProduct(product.id);
    if (pendingOrder) {
      continuePendingOrder(pendingOrder, detail);
      return;
    }
    const paymentMethod = await choosePurchaseMethod(detail, product);
    if (!paymentMethod) {
      showInlineMessage("当前内容暂时没有可用的支付方式。");
      return;
    }
    trackAnalytics("payment_method_selected", {
      contentId: detail.id,
      productId: product.id,
      paymentMethod: paymentMethod === "stars" ? "telegram_stars" : "usdt_trc20",
    });
    trackAnalytics("unlock_clicked", { productId: product.id, paymentMethod: paymentMethod === "stars" ? "telegram_stars" : "usdt_trc20" });
    if (paymentMethod === "stars") {
      trackAnalytics("checkout_open", {
        contentId: detail.id,
        productId: product.id,
        paymentMethod: "telegram_stars",
      });
      await createStarsOrderAndPay(detail, product);
      return;
    }
    trackAnalytics("checkout_open", {
      contentId: detail.id,
      productId: product.id,
      paymentMethod: "usdt_trc20",
    });
    openCheckoutPage({ productId: product.id, paymentMethod: "usdt", returnTo: getCheckoutReturnTarget(detail) });
  }

  async function createStarsOrderAndPay(detail, productOverride) {
    const product = productOverride || (detail && detail.product ? detail.product : null);
    if (!tg || typeof tg.openInvoice !== "function") {
      showInlineMessage("请在 Telegram Mini App 内使用 Stars 支付。");
      return;
    }
    if (!product) {
      showInlineMessage("当前内容没有可用商品。");
      return;
    }
    let created;
    try {
      created = await apiCall("/api/orders/stars", {
        method: "POST",
        body: JSON.stringify({ productId: product.id }),
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
    const refreshLibraryForCategory = routeState.tab === "library" && !!routeState.categoryId && routeState.categoryId !== state.library.categoryId;
    state.route = routeState;
    if (routeState.categoryId) state.library.categoryId = routeState.categoryId;
    if (routeState.view !== "detail") trackAnalytics("page_viewed", { pageName: routeState.view === "history" ? "watch_history" : routeState.view === "wallet" ? "wallet" : routeState.tab });
    const isDetail = routeState.view === "detail";
    const isHistory = routeState.view === "history";
    const isWallet = routeState.view === "wallet";
    if (isDetail || isHistory || isWallet || routeState.tab !== "home") $("homePromoModal").classList.add("is-hidden");
    const titleMap = {
      home: ["同频", "免费试看，解锁后继续观看"],
      library: ["片库", "按标题、简介与标签查找内容"],
      membership: ["会员", "查看会员权益、内容包与续费入口"],
      me: ["我的", "查看权益、订单和继续观看记录"],
    };
    const isHome = !isDetail && !isHistory && !isWallet && routeState.tab === "home";

    $("backButton").hidden = !(isDetail || isHistory || isWallet);
    $("bottomNav").classList.toggle("is-hidden", isDetail || isHistory || isWallet);
    $("appHeader").classList.toggle("is-home", isHome);
    $("headerTitle").textContent = isDetail ? "视频详情" : (isHistory ? "观看历史" : (isWallet ? "支付与账单" : titleMap[routeState.tab][0]));
    $("headerSubtitle").textContent = isDetail
      ? "试看后可直接解锁完整内容"
      : isHistory
        ? "按最近播放时间排序，可删除单条或清空记录"
      : isWallet
        ? "查看会员状态、订单与支付记录"
        : titleMap[routeState.tab][1];
    $("headerSubtitle").hidden = false;
    $("headerEyebrow").hidden = isHome;

    ["home", "library", "membership", "me"].forEach(function (tab) {
      $(tab + "View").classList.toggle("is-hidden", isDetail || isHistory || isWallet || routeState.tab !== tab);
    });
    $("detailView").classList.toggle("is-hidden", !isDetail);
    $("watchHistoryView").classList.toggle("is-hidden", !isHistory);
    $("walletView").classList.toggle("is-hidden", !isWallet);
    $("desktopRail").classList.toggle("is-hidden", isDetail || isHistory || isWallet);
    if (!isDetail && !isHistory && !isWallet) renderDesktopRail();

    document.querySelectorAll(".nav-item").forEach(function (button) {
      button.classList.toggle("is-active", !isDetail && !isHistory && !isWallet && button.getAttribute("data-tab") === routeState.tab);
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
    if (isWallet) {
      loadOrders();
      loadEntitlements();
      renderWallet();
      return;
    }

    if ((!state.library.loaded && routeState.tab !== "home") || refreshLibraryForCategory) loadLibrary();
    if (routeState.tab === "membership" && routeState.packageId) {
      const target = (state.library.items || []).find(function (item) { return item.packageId === routeState.packageId; });
      if (target) {
        openContentDetail(target.id, "membership", { autoplay: false, resumePositionSec: 0 });
        return;
      }
    }
    if (routeState.tab === "membership") renderMembership();
    if (routeState.tab === "me") {
      loadOrders();
      loadEntitlements();
      loadChannels();
      if (!state.watch.loaded) loadWatchProgress(1, false);
    }
    renderHomePopup();
  }

  async function bootstrapApp() {
    if (state.booting) return;
    try {
      await bootstrapSession();
      // A deep link renders its detail shell before the asynchronous automatic
      // login finishes. That first request has no user session and therefore
      // carries an unauthorised playback status. Never retain it after the
      // session becomes available, otherwise a valid viewer sees only the
      // cover and never gets the 60-second player.
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
    $("installGuideClose").addEventListener("click", dismissInstallGuide);
    $("installGuideDone").addEventListener("click", dismissInstallGuide);
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
    $("walletShortcutButton").addEventListener("click", setHashForWallet);
    $("accountHistoryShortcutButton").addEventListener("click", function () { setHashForHistory("me"); });
    $("accountPreferencesShortcutButton").addEventListener("click", function () { showInlineMessage("内容偏好设置正在完善中，当前推荐会根据你的观看与解锁记录逐步优化。"); });
    $("accountHelpShortcutButton").addEventListener("click", function () { showInlineMessage("请遵守社区规则、尊重边界并保护隐私；如需帮助，请联系官方 Bot。 "); });
    $("walletMembershipButton").addEventListener("click", function () { setHashForTab("membership"); });
    $("jumpPopularLibraryButton").addEventListener("click", function () { state.library.categoryId = "all"; setHashForTab("library"); });
    $("watchHistoryLoadMore").addEventListener("click", function () {
      if (state.watch.loading) return;
      loadWatchProgress((state.watch.pagination.page || 1) + 1, true);
    });
    $("libraryCategoryMoreButton").addEventListener("click", function () {
      state.library.showExtraCategories = !state.library.showExtraCategories;
      renderLibraryCategories();
    });
    $("libraryLoadMoreButton").addEventListener("click", function () {
      if (state.library.loading) return;
      loadLibrary({ append: true });
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
      if (librarySearchTimer) window.clearTimeout(librarySearchTimer);
      librarySearchTimer = window.setTimeout(function () {
        loadLibrary();
      }, 300);
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
    window.addEventListener("scroll", maybeLoadLibraryOnScroll, { passive: true });
    window.addEventListener("resize", function () {
      renderLibrary();
      maybeLoadLibraryOnScroll();
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
    bootstrapApp().finally(function () {
      window.setTimeout(showInstallGuideOnFirstH5Visit, 500);
    });
  });
})();
