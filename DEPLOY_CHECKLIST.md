# 同频 InTune · 生产上线前 Checklist（P1 交付）

> 结论前置（2026-08-06 E2E 报告）：**核心流程联调通过，Telegram 交付待真实配置复测**，尚未达到「完整上线验收」。
> 本清单覆盖「代码层自动拦截的安全项 ✅」与「部署前必须手动完成的配置项 🔧」。

---

## Part A · 代码层已自动拦截的安全项 ✨（生产启动即强校验）

全部已在代码中实现，未达标直接 `process.exit(1)` 拒绝启动。

- [x] **A1. 演示登录路由（/api/__demo/*）生产完全禁用**
  代码: [index.ts](file:///E:/BDSM/server/src/index.ts#L72-L98)
  - 仅当 `NODE_ENV === "development"` 才注册（staging/production 整段不存在路由，即使你有 token 也 404）
  - 开发环境需 `x-demo-token: ${DEV_DEMO_TOKEN || "intune-dev-only"}` 请求头（彻底移除了此前 `?bypass=1` 一键登录漏洞）
  - 所有响应加 `x-dev-only: demo-login`，WAF 层可直接拦

- [x] **A2. 默认 seed 管理员密码（ChangeMeSuperAdmin!123 / ChangeMeOperator!456）生产启动自毁**
  代码: [selfCheckDefaultAdminPasswords](file:///E:/BDSM/server/src/index.ts#L32-L64)
  - `NODE_ENV=production` 启动时对所有 active 管理员 bcrypt.compare 逐一命中
  - 未修改默认密码 → 抛 `FATAL ABORTING STARTUP` 列受影响账号后 exit(1)

- [x] **A3. prisma:seed 生产拒绝 wipe/reseed**
  代码: [seed.ts](file:///E:/BDSM/server/prisma/seed.ts#L6-L57)
  - `NODE_ENV=production` 未显式设 `ADMIN_SEED_FORCE=1` 直接 exit(2)，防误删全库
  - seed 同时自检 `SEED_SUPERADMIN_PASSWORD / SEED_OPERATOR_PASSWORD`：生产仍使用默认值 → throw；开发环境 warn

- [x] **A4. SESSION_SECRET 生产必填** (index.ts main 入口) + Bot Token 生产必真（stub=真 token 缺失生产直接 abort）

---

## Part B · 部署前必须手动完成的配置项 🔧（未完成不能上线）

对应你在联调报告末尾提出的 5 条上线要求。

### B1. Telegram 基础配置（让「获取邀请链接」接口真正返回 200）

- [ ] **B1.1 部署时替换 `server/.env` 里的占位符频道 ID**
  ```
  # 从占位符 (-1000000000001) → 你的真实私密收费频道数字 ID (-100xxxxxxx)
  TELEGRAM_CHANNEL_MEMBERSHIP=-100你的真实收费频道ID
  TELEGRAM_CHANNEL_PACKAGE=-100你的真实内容包频道ID（若有）
  ```
  验证：`POST /api/resources/topic-02/access-link` 应返回 `200 { inviteLink: "https://t.me/+xxxxxx" }`（不再是 502）

- [ ] **B1.2 把邀请 Bot 设为该频道管理员**
  Bot 用户名：在 `server/.env` 中填入的 `TELEGRAM_BOT_USERNAME`（默认 @InTune_bdsm_bot）
  必要权限：✅ 邀请用户、✅ 创建邀请链接（单次/1h 有效）、✅ 踢人（到期自动踢）
  失败征兆：`POST /resources/topic-02/access-link` 返回 502 `bot_api_error` 且 detail = "not enough rights"

### B2. 初始化管理员与密码

- [ ] **B2.1 覆盖所有默认管理员账号（2 个都改）**
  不要用 seed 默认值，在 DB 里执行 SQL 更新或部署前通过 prisma:seed + 环境变量：
  ```env
  SEED_SUPERADMIN_EMAIL=your_real_admin@example.com
  SEED_SUPERADMIN_PASSWORD=至少16位含大小写数字符号
  SEED_OPERATOR_EMAIL=your_operator@example.com
  SEED_OPERATOR_PASSWORD=另一段至少16位强密码
  ADMIN_SEED_FORCE=1
  NODE_ENV=production
  ```
  验证：`GET /healthz` 返回 200 且日志含 `[intune-server:admin-passwords] ✅ N active admin users — no default seed password reuse.`

- [ ] **B2.2 如已跳过 seed，手动在 Prisma Studio / psql 重置 2 位管理员 passwordHash**（bcrypt hash，hash 轮次=10）
  验证：用新密码登录 admin 后台 → 成功后登出 → seed 旧密码应当 401 被拒

### B3. 端到端真实链路复测（不能只用 __demo 登录）

- [ ] **B3.1 用真 Telegram 打开 Mini App，走 Telegram WebApp `initData` 登录链路**
  1. 把 Mini App 挂到 BotFather `/newapp` 命令对应域名（同源 `/mini-app/` 路径下部署）
  2. 真用户从 Telegram → 打开 Mini App
  3. 前端 SDK 发送 `window.Telegram.WebApp.initData` → `POST /api/telegram/session` → 返回 201 + session cookie
  验证：同域名 `GET /api/home` 返回 `unlocked` 按真实用户 entitlement 状态（不是 demo user）

- [ ] **B3.2 真支付 → 真补单 → 真发邀请 全链路**（当前我们已验证补单后权益发放；先把补单跑稳再接正式 Stars/微信回调是合理划分）
  1. 用户真金白银完成支付（Telegram Stars / 微信转账截图回传运营）
  2. 运营进 admin 搜订单号 → pending + 待补单 Tag → 「人工标记已支付」必填 reason（**不能空！**后端双校验 Zod + service）
  3. 确认后订单状态 = paid，抽屉「已发放权益」出现 `membership_channel / membership-main`
  4. 用户回到 Mini App 刷新 → `/api/home.unlocked = true` → 点任意 membership 内容「前往频道观看」→ `POST /resources/<id>/access-link` 返回 200 真实 t.me/+xxx 链接 → 点开加入频道
  5. 审计记录 Tab 能看到：操作人（邮箱 + 角色）、备注=你填的 reason、客户端 IP=127.0.0.1/真实公网 IP

### B4. 网络/域名/Cookie 安全

- [ ] **B4.1 Mini App / Admin / Server 建议同源部署（Nginx path-based 路由）**，不要跨域：
  - `https://intune.example.com/` → admin SPA dist
  - `https://intune.example.com/mini-app/` → telegram-mini-app 静态目录（已由 fastify static 提供）
  - `https://intune.example.com/api/*` → server :3001 upstream
  这样 Cookie `SameSite=Lax + Secure + HttpOnly` 完全生效，无需配置 CORS。

- [ ] **B4.2 `NODE_ENV=production` 时显式设置强随机 SESSION_SECRET（至少 32 字节）**
  绝不能用默认 `development-only-session-secret-change-me-32chars`（代码在 A1/A4 已经会拦生产空值，但长随机更安全）

---

## Part C · 一键验证命令（上线前最后 1 分钟）

全部通过再切流量：

```powershell
# 1. Server TS check
cd e:\BDSM\server
npm run typecheck          # 期望 0 errors

# 2. Unit tests (orders + entitlements 原子化)
$env:NODE_ENV="test"
node --import tsx --test tests/orders.test.ts tests/entitlements.test.ts
# 期望: pass 2 fail 0

# 3. 生产启动自检（NODE_ENV=production 先起一次，确认不因默认密码/缺 Bot token 崩）
$env:NODE_ENV="production"
# 设置好所有 env 后
npm run build ; node dist/index.js
# 期望日志:
# [intune-server:admin-passwords] ✅ N active admin users — no default seed password reuse.
# [intune-server:bot] ✅ Real Bot OK: @xxx id=yyy — invites enabled.
# [intune-server] listening on :3001

# 4. E2E HTTP Smoke (开发环境)
powershell -ExecutionPolicy Bypass -File .\tmp_e2e_verify.ps1
# 期望: security 2/2 PASS + 功能 5/5 PASS，最后 POST access-link 返回 200（真频道）或 502（仍占位符≠403 仅说明频道 ID 未配，权限链路 OK）
```

---

## Part D · 交付范围边界说明（与联调报告一致）

已闭环（=当前可跑通，上线仅缺配置）
- ✅ Mini App 3 视图 / 订单 / 权益 / 内容详情页 解锁态 UI
- ✅ Admin 运营台：管理员登录、订单搜索分页、人工标记支付（reason 必填校验 + 权限校验 MARK_PAID_ROLES）
- ✅ 补单事务 3 件套（Order → Entitlement → AdminAuditLog 同 $transaction）
- ✅ Audit 抽屉 List + Timeline 双视图（操作人 / 备注 / IP 全部写入 DB）
- ✅ Hourly cron：过期扫幂等 + 3d 到期提醒 + 到期踢频道（send 失败仅 warn，notify3dAt/notifyExpiredAt 保持 NULL 下次重试）
- ✅ 续费语义：新 membership entitlement `startsAt = max(现有 active 会员 expiresAt)` 非覆盖，已在 E2E 验证（原年会员到期 2027-08 → 补单 30 天后到 2027-09-05）

尚未闭环（=先把补单跑稳，下一迭代接入，你在报告中的划分「合理」）
- ⏸️ Telegram Stars / 微信官方支付真回调 + 自动免人工发货
- ⏸️ 真用户首次 Mini App 注册 → 自动发频道邀请（当前先 E2E 用 `/api/__demo` 模拟，生产你会用 initData 实机跑 B3.1）
