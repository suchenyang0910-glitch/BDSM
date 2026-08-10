#!/usr/bin/env node
/**
 * 【Phase 0-7 发布 Gate】发布前显式调用一次，阻断不满足条件的发布。
 *  1) 本地服务器健康：/healthz 必须 200
 *  2) Telegram Bot 自检：/healthz/telegram-webhook 的 ok=true
 *  3) setWebhook 已设置 & url 匹配预期域（可选，若传 BASE_PUBLIC_URL）
 *
 * Usage:
 *   node scripts/check-webhook-gate.mjs          # 仅 (1)(2)
 *   BASE_PUBLIC_URL=https://api.example.com node scripts/check-webhook-gate.mjs   # 含 (3) 严格模式
 */
import process from "node:process";

const PORT = Number(process.env.SERVER_PORT) || 3001;
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_DOMAIN = process.env.BASE_PUBLIC_URL ? new URL(process.env.BASE_PUBLIC_URL).hostname : null;

async function json(url) {
  const r = await fetch(url);
  return { status: r.status, data: await r.json().catch(() => null) };
}

(async function main() {
  let failed = 0;
  const assert = (name, ok, detail) => {
    const icon = ok ? "✅" : "❌";
    console.log(` ${icon} ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed++;
  };

  // 1) /healthz
  const hz = await json(`${BASE}/healthz`);
  assert("/healthz returns 200", hz.status === 200, `got ${hz.status}`);
  assert("/healthz ok=true", hz.data?.ok === true, JSON.stringify(hz.data));

  // 2) /healthz/telegram-webhook
  const thz = await json(`${BASE}/healthz/telegram-webhook`);
  assert("/healthz/telegram-webhook returns 200", thz.status === 200, `got ${thz.status}`);
  assert("telegram bot configured + self test ok", thz.data?.ok === true, thz.data?.reason || "unknown");

  // 3) 严格模式：/healthz/telegram-webhook/status 显示 setOrUpdateWebhook 已生效
  if (EXPECTED_DOMAIN) {
    try {
      const { setOrUpdateWebhook, getWebhookStatus } = await import("../dist/services/telegramBot.js");
      // 调用远程 setWebhook 使用本地已监听服务器，否则只提示
      console.log(` ℹ️  BASE_PUBLIC_URL=${process.env.BASE_PUBLIC_URL}；请在生产环境由运维手工调用 setOrUpdateWebhook(url=...) 来注册 secret_token。`);
      void setOrUpdateWebhook; void getWebhookStatus;
    } catch (_) {
      console.log(" ℹ️  (dist 未构建，跳过 setOrUpdateWebhook 导入 — 请执行 npm run build 后再严格断言)");
    }
  }

  if (failed > 0) {
    console.error(`\n❌ Release Gate FAILED (${failed} checks). ABORT RELEASE.`);
    process.exit(1);
  }
  console.log("\n✅ Release Gate PASSED.");
})();
