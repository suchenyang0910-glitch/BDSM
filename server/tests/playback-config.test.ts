import assert from "node:assert/strict";
import test from "node:test";

import {
  isPlaybackAllowedForPoc,
  loadPlaybackConfig,
  playbackConfigErrorClass,
} from "../src/services/playbackConfig.js";

test("Phase C C0: disabled mode keeps playback closed without requiring CDN config", () => {
  const cfg = loadPlaybackConfig({
    VIDEO_DELIVERY_MODE: "disabled",
  });

  assert.equal(cfg.mode, "disabled");
  assert.equal(cfg.configured, true);
  assert.equal(playbackConfigErrorClass(cfg), "video_delivery_disabled");
});

test("Phase C C0: poc mode requires CDN config and dual whitelists", () => {
  const cfg = loadPlaybackConfig({
    VIDEO_DELIVERY_MODE: "poc",
    VIDEO_CDN_BASE_URL: "https://video.example.com",
    VIDEO_CDN_SIGNING_MODE: "signed_cookie",
    VIDEO_CDN_SIGNING_KEY: "playback-signing-key-with-sufficient-length",
    PLAYBACK_POC_CONTENT_IDS: "content-a,content-b,content-a",
    PLAYBACK_POC_USER_IDS: "user-a,user-b",
  });

  assert.equal(cfg.mode, "poc");
  assert.equal(cfg.configured, true);
  assert.deepEqual(cfg.pocContentIds, ["content-a", "content-b"]);
  assert.deepEqual(cfg.pocUserIds, ["user-a", "user-b"]);
  assert.equal(isPlaybackAllowedForPoc(cfg, { contentId: "content-a", userId: "user-a" }), true);
  assert.equal(isPlaybackAllowedForPoc(cfg, { contentId: "content-a", userId: "user-z" }), false);
});

test("Phase C C0: enabled mode stays fail-closed when delivery secrets are missing", () => {
  const cfg = loadPlaybackConfig({
    VIDEO_DELIVERY_MODE: "enabled",
    VIDEO_CDN_BASE_URL: "",
    VIDEO_CDN_SIGNING_MODE: "edge_token",
    VIDEO_CDN_SIGNING_KEY: "short",
  });

  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.missingKeys, ["VIDEO_CDN_BASE_URL", "VIDEO_CDN_SIGNING_KEY"]);
  assert.equal(playbackConfigErrorClass(cfg), "video_delivery_not_configured");
});

test("Phase C C0: playback numeric settings are clamped to safe ranges", () => {
  const cfg = loadPlaybackConfig({
    VIDEO_DELIVERY_MODE: "poc",
    VIDEO_CDN_BASE_URL: "https://video.example.com/",
    VIDEO_CDN_SIGNING_MODE: "edge_token",
    VIDEO_CDN_SIGNING_KEY: "playback-signing-key-with-sufficient-length",
    PLAYBACK_POC_CONTENT_IDS: "content-a",
    PLAYBACK_POC_USER_IDS: "user-a",
    PLAYBACK_SESSION_TTL_SECONDS: "99999",
    PLAYBACK_MAX_ACTIVE_DEVICES: "0",
    PLAYBACK_HEARTBEAT_INTERVAL_SECONDS: "2",
  });

  assert.equal(cfg.cdnBaseUrl, "https://video.example.com");
  assert.equal(cfg.sessionTtlSeconds, 300);
  assert.equal(cfg.maxActiveDevices, 1);
  assert.equal(cfg.heartbeatIntervalSeconds, 5);
});
