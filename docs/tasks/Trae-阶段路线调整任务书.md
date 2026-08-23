# InTune 同频｜阶段化交付与独立点播调整任务书（交付 Trae）

> 版本：V1.0  
> 目标：先完成「内容卡 → 合规支付 → 权益 → Telegram 私密频道交付」的低成本商业验证；达到数据门槛后，再建设 DigitalOcean 独立视频点播。  
> 本任务书基于当前仓库 `E:\BDSM` 代码编写。任何未明确列入的 P0 支付安全代码均不得顺带重构。

---

## 0. 总原则与不可突破边界

### 0.1 两阶段路线

| 阶段 | 内容源与交付 | 目标 | 是否本轮开发 |
|---|---|---|---|
| 阶段一：低成本验证 | 完整视频位于 Telegram 私密频道；平台负责目录、支付、权益和邀请交付 | 验证付费、复购、内容偏好 | **是** |
| 阶段二：独立 VOD | DigitalOcean Spaces 私有存储 + 转码 + HLS + 授权播放器 | 改善观看体验、摆脱频道内容目录限制 | **否，仅输出技术预案** |

### 0.2 支付边界

- Telegram Mini App 内的数字视频、内容包、会员订阅：只使用 Telegram Stars（`XTR`）。
- 独立 H5：可以提供 USDT-TRC20；用户仅看到订单金额、收款地址、复制按钮与到账状态。
- 禁止在 Telegram Mini App 内展示、引导或发起 USDT 支付。
- 订单、权益与用户必须共用同一后端数据模型；支付成功后才允许交付。

### 0.3 频道交付边界

- 私密频道邀请链接只能由服务端在用户已有有效权益后生成，单次、短时有效。
- 邀请链接不得出现在普通 JSON 响应、前端状态、日志或审计文本中；允许通过 Bot 私信或服务端 302 跳转交付。
- 频道 ID、Bot Token、收款地址私钥均不得写入前端代码、Git、审计字段或日志。

### 0.4 现有 P0 冻结范围

下列支付与错误脱敏逻辑已验收；本轮不得改变语义、删除测试或用“顺手重构”覆盖：

- `server/src/services/usdtPool.ts`
- `server/src/routes/orders.ts` 中 USDT 尾数与事务逻辑
- `server/src/utils/structuredError.ts`
- `server/src/utils/crypto.ts`
- `server/tests/orders.test.ts` 的 P0 用例

任何确实必须修改上述文件的需求，必须单独说明影响、补回归测试，并先等待确认。

---

## 1. 现状审计：必须先理解的事实

### 1.1 已有能力

| 模块 | 当前代码位置 | 当前状态 |
|---|---|---|
| Mini App | `telegram-mini-app/` | 有内容列表、详情、订单、权益及频道入口 UI |
| 管理后台 | `admin/src/pages/Contents.tsx` | 可建立内容卡、分类、封面 URL、预览 URL、推荐/精选、商品/内容包关联 |
| 内容 API | `server/src/routes/adminCms.ts` | 内容 CRUD、发布、分类与审计已存在 |
| Telegram 登录 | `server/src/routes/telegram.ts` | 校验 Mini App `initData`，建立后端 session |
| 邀请交付 | `server/src/routes/resources.ts` | `POST /api/resources/:id/access-link`，已有权益校验、Bot DM、302 备用交付 |
| 支付 | `server/src/routes/orders.ts` | Stars 与外部 USDT-TRC20 订单基础链路已存在 |

### 1.2 已发现的功能缺口（必须修正）

1. **后台空白页不是前端业务代码问题，而是生产 Caddy 路由问题。**
   已实测 `/admin/assets/index-*.js` 返回 `text/html`，导致 React 脚本无法执行。

2. **`channelId` 前端字段无效且不安全。**
   `admin/src/pages/Contents.tsx` 仍展示“关联频道 ID”输入框；但 `server/src/routes/adminCms.ts` 的 `ZCONTENT_CREATE` 不接受该字段，创建/编辑时也不会持久化。因此运营填写后无效。频道 ID 也不应由运营在浏览器输入。

3. **共享会员频道不能安全地承载“单条内容售卖”。**
   若多个完整视频位于同一个 VIP 频道，给某位购买单条内容的用户发频道邀请，会让其看到频道内其他全部内容。首期不得把 `single` 当作可实际交付的 SKU。

4. **当前后台不支持上传视频文件。**
   内容表只有 `coverUrl`、`thumbnailUrl`、`previewUrl` 等元数据字段；完整视频应继续由运营手工发布到 Telegram 私密频道。

---

## 2. 阶段一开发任务（本轮立即执行）

### S1-0：生产路由修复与可用性 Gate（P0）

#### 目标

让后台、Mini App、API、健康检查走到正确服务，不允许“HTTP 200 但返回错误 HTML”的假健康状态。

#### 修改范围

- 仓库新增/维护：根目录 `Caddyfile`。
- 服务器实际生效文件：通常为 `/etc/caddy/Caddyfile`，由部署人员复制并替换环境变量中的真实路径。
- 不修改支付 P0 文件。

#### Caddy 路由顺序（必须严格遵守）

```caddy
bdsm.linkx.club {
    encode zstd gzip

    @backend path /api/* /healthz /healthz/*
    handle @backend {
        reverse_proxy 127.0.0.1:3000
    }

    redir /admin /admin/ 308

    handle_path /admin/* {
        root * /实际服务器项目路径/admin/dist
        try_files {path} /index.html
        file_server
    }

    handle {
        root * /实际服务器项目路径/telegram-mini-app
        try_files {path} /index.html
        file_server
    }
}
```

#### 验收命令与标准

```bash
# 后台入口
curl -I https://bdsm.linkx.club/admin/

# 后台 JS：必须是 JavaScript，不得是 text/html
curl -I https://bdsm.linkx.club/admin/assets/<构建后的实际文件名>.js

# Fastify 健康检查：必须是 JSON
curl -i https://bdsm.linkx.club/healthz
curl -i https://bdsm.linkx.club/healthz/telegram-webhook
```

验收：

- `/admin/` 显示登录页或后台页面，浏览器无白屏。
- `/admin/assets/*.js` 返回 `text/javascript` 或 `application/javascript`。
- `/healthz` 返回 `application/json` 和 `{ "ok": true }`，绝不能返回 Mini App HTML。
- `/api/health`、`/api/home`、`/api/contents` 返回 Fastify JSON。

---

### S1-1：首期商品与频道交付规则收敛（P0）

#### 首期只允许三种内容形态

| 内容形态 | `accessType` | 完整内容位置 | 发放条件 | 交付频道 |
|---|---|---|---|---|
| 公开预览 | `public` | 公开频道 / 公开预览 URL | 无 | 不创建私密邀请 |
| VIP 会员内容 | `membership` | 会员私密频道 | 有有效 `membership_channel` 权益 | 固定会员频道，由服务端 env/KMS 解析 |
| 主题内容包 | `package` | 每个内容包一个独立私密频道 | 有对应 package 权益 | 内容包绑定频道，由服务端受控映射 |

#### 首期禁止

- 后台不得创建并发布 `accessType=single` 的收费内容。
- UI 不显示“关联频道 ID”明文输入框。
- 不让运营在页面内粘贴 `-100...`、Bot Token、永久邀请链接。
- 不允许把完整 MP4 上传到当前 Droplet 磁盘或暴露公开永久 URL。

#### Trae 任务

1. 修改 `admin/src/pages/Contents.tsx`：
   - 移除 `channelId` 表单项。
   - `accessType` 仅显示 `public`、`membership`、`package`；`single` 如数据库历史数据存在，可在列表标记“旧数据/不可新建”，不可在新建与编辑中选择。
   - 当选择 `membership`：显示只读文案“完整内容交付至会员私密频道（由服务端配置）”。
   - 当选择 `package`：`packageId` 必填；无可用内容包时禁用发布按钮并显示提示。
   - `public`：可填写公开预览 URL；不得显示私密频道相关字段。

2. 修改 `server/src/routes/adminCms.ts`：
   - `ZCONTENT_CREATE` / `ZCONTENT_EDIT` 增加跨字段校验：
     - `membership`：允许 `productId`，禁止 `packageId` 为空之外的错误混配按实际产品模型校验。
     - `package`：`packageId` 必填，且必须存在并启用。
     - `public`：不得绑定收费产品或内容包。
     - `single`：新建/编辑请求返回 `409 single_delivery_not_enabled`。
   - 发布动作再次做同样校验，防止绕过前端直接调用 API。
   - 审计只记录内容 ID、类型、商品/内容包 ID、操作人，不记录频道 ID 或链接。

3. 修改 `server/src/routes/resources.ts`：
   - `membership` 只能走 `refMembershipMain()` 等受控服务端 ChannelRef。
   - `package` 必须从受控内容包映射取得频道，不信任来自客户端的 channel 参数。
   - 如果 package 没有可用频道映射，返回 `409 delivery_channel_not_configured`，不得 fallback 到会员频道。
   - 保持当前“前端 JSON 不返回 inviteLink”的安全设计。

4. 补自动化测试：
   - `single` 新建和发布均为 409。
   - `package` 无 packageId 为 400；package 无频道配置时发放为 409。
   - membership 权益仅能进入会员频道；package 权益仅能进入自己的内容包频道。
   - 断言响应体、审计字段、日志测试输出均不包含频道明文 ID 或 `t.me/+` 邀请链接。

#### 验收标准

```text
后台新建会员内容 → 发布 → 已购会员用户点击进入频道 → Bot 私信/302 单次邀请 → 成功进入会员频道
后台新建内容包内容 → 发布 → 已购该包用户进入该包频道
未购买 / 权益过期 / 权益已撤销 → 403，不创建邀请记录
```

---

### S1-2：内容运营后台最小闭环（P1）

#### 运营操作 SOP

1. 运营先将完整视频发至目标 Telegram 私密频道。
2. 在管理后台创建内容卡：标题、描述、封面 URL、缩略图 URL、时长、分类、标签、推荐位。
3. 选择 `membership` 或 `package`，绑定已经建立的商品/内容包。
4. 保存草稿 → 预览 → 发布/定时发布。
5. 在 Mini App 检查内容卡、解锁状态与“前往频道观看”入口。

#### Trae 任务

1. 内容列表增加筛选与运营状态：草稿、定时、已发布、已下架、推荐、精选、访问类型。
2. 内容编辑页增加“发布前检查”区：
   - 是否有封面；
   - membership 是否有有效商品；
   - package 是否绑定内容包与受控频道；
   - 定时发布时间是否有效。
3. `previewUrl` 仅用于公开预览，需在用户端使用 `rel=noopener`，不自动播放；完整收费视频不放入 `previewUrl`。
4. 新增只读运营提示：完整视频上传到 Telegram 频道后，再建立内容卡；后台本阶段不提供 MP4 上传按钮。
5. 对内容创建、编辑、发布、下架、推荐位调整保持审计；不在审计字段写原始频道 ID、邀请链接、Bot Token。

#### 验收标准

- 运营无需接触任何频道 ID 即可完成“会员内容”与“内容包内容”发布。
- 公开预览不需要登录也可展示；收费内容只有权益用户能获得频道入口。
- 下架后内容详情和频道交付入口均不可继续使用。

---

### S1-3：支付体验与交付状态（P1）

#### H5（外部）

- 入口：H5 可使用 Telegram 登录/受控 session；保留个人中心绑定 Telegram、设置/修改密码的能力。
- USDT-TRC20 页面只展示：订单号、应付精确金额、收款地址、网络 `TRC-20`、复制按钮、倒计时、等待到账状态。
- 禁止：钱包连接、手工输入 TxHash、上传转账截图、网络选择、用户自行确认到账。
- 状态：`待支付 → 检测中 → 已支付/已过期/异常`；轮询只查询当前用户自己的订单。
- 成功后显示“已发放权益”，再提供“进入 VIP 频道”按钮；由原有受控 `POST /api/resources/:id/access-link` 交付。

#### Telegram Mini App

- 只显示 Stars 支付入口，支付成功只以 `successful_payment` 回调为发货依据。
- 不出现 USDT 文案、地址、二维码、外链购买引导。
- 支付后刷新订单和权益，再显示“进入频道观看”。

#### Trae 任务

1. 逐项核对现有 `telegram-mini-app/app.js`、`h5/` 与订单接口；只补缺失的 UI/API 对接，不重写 P0 订单逻辑。
2. 所有支付成功按钮都进入同一“权益已激活”状态页，不直接暴露私密邀请 URL。
3. 增加前端错误码映射：`unauthorized`、`forbidden`、`delivery_channel_not_configured`、`bot_not_configured`、`payment_expired` 均显示可理解中文，不展示 DB/Telegram 原始错误。
4. 为 H5 和 Mini App 各补一份 E2E 验收记录：登录、下单、支付成功模拟、权益刷新、频道入口、无权益拒绝。

---

### S1-4：阶段一数据看板与决策 Gate（P1）

后台首页新增只读数据卡，不引入复杂 BI：

| 指标 | 口径 |
|---|---|
| 付费用户数 | 当月至少 1 笔 paid 订单的去重用户数 |
| 月 GMV | 当月 paid 订单实付总额，按支付方式拆分 |
| 会员续费率 | 到期前后 7 天内续费的会员 / 本期到期会员 |
| 内容包购买率 | 内容包 paid 订单 / 所有 paid 订单 |
| 邀请交付成功率 | 成功创建且用户加入频道的交付 / 成功支付订单 |
| 客服与退款率 | 已退款订单、有效工单 / paid 订单 |

### 阶段二立项门槛

以下四项满足任意两项，才进入独立 VOD 开发：

- 稳定付费会员 ≥ 100；
- 月 GMV ≥ 1,500 USDT；
- 月完整观看 ≥ 3,000 小时；
- 用户调研明确显示 Telegram 频道体验严重影响购买或续费。

---

## 3. 阶段二：DigitalOcean 独立 VOD 技术预案（不在本轮编码）

### 3.1 目标架构

```text
后台选择视频文件
  → 后端签发短期直传凭据
  → DigitalOcean Spaces 私有桶（原始文件）
  → 转码任务队列（FFmpeg）
  → 480P / 720P HLS 文件
  → 私有 CDN / 短时播放授权
  → H5 / Mini App 播放器
```

### 3.2 二期新增模块

| 模块 | 必需能力 |
|---|---|
| 上传 | 分片/断点续传、文件格式和大小校验、上传任务状态 |
| 转码 | 异步队列、HLS 多码率、封面截帧、失败可重试 |
| 存储 | Spaces 私有桶；原文件与转码产物分目录；生命周期归档 |
| 授权 | 已登录 + 有有效权益才签发短时播放令牌；令牌绑定用户/内容/过期时间 |
| 播放 | HLS 自适应码率、续播位置、清晰度切换、错误提示 |
| 风控 | 防盗链、并发设备限制、异常播放告警、水印策略 |
| 数据 | 播放开始、有效观看分钟、完成率、清晰度、失败率 |

### 3.3 二期数据模型建议

新增而非篡改现有 `Content` 主表：

```text
video_assets
  id, content_id, source_object_key, source_size, source_sha256,
  upload_status, transcode_status, duration_seconds, created_at

video_renditions
  id, asset_id, quality, playlist_object_key, bitrate, width, height,
  status, created_at

playback_sessions
  id, user_id, content_id, token_hmac, expires_at, started_at,
  last_position_seconds, ended_at, revoked_at

play_events
  id, session_id, event_type, position_seconds, watched_seconds,
  quality, created_at
```

### 3.4 二期安全要求

- 任何完整视频、HLS manifest、分片不得采用永久公开 URL。
- 后端只在权益有效期内签发短时播放授权；退款、权益到期或撤销后立即阻断新授权。
- 客户端不保存 Spaces Key、DO Token、永久对象路径或完整签名 URL。
- 不将 DRM 作为首期承诺；短时授权、防盗链、并发限制和可见水印只能降低传播，不保证完全防录屏。

---

## 4. Trae 的实施顺序与交付要求

### 实施顺序

1. S1-0：修复 Caddy 并做公开路由 Smoke；
2. S1-1：收敛 SKU/频道交付模型，先补接口与测试；
3. S1-2：后台内容运营闭环；
4. S1-3：H5/Telegram Mini App 支付后交付体验；
5. S1-4：最小数据看板；
6. 只输出阶段二技术设计，不提交 VOD 业务代码。

### 每个小任务必须交付

- 修改文件清单及原因；
- 数据库迁移（如有）及回滚说明；
- 新增/更新自动化测试；
- `npx tsc --noEmit`、`npm test`、`npm run build` 的真实结果；
- 不带密钥、频道 ID、邀请链接和用户资料的部署说明；
- 需要人工完成的 Telegram/服务器步骤单独列为 staging checklist，不伪称自动化已验证。

### 禁止事项

- 不得修改或删除既有 P0 测试来让测试“变绿”。
- 不得把频道 ID、Bot Token、USDT 密钥写入任何前端、日志、审计或测试固定值。
- 不得为赶进度把完整视频改为公开 URL。
- 不得在 Telegram Mini App 内接入或引导 USDT 数字商品支付。

---

## 5. 最终阶段一验收清单

```text
[ ] /admin/ 无白屏；后台 JS 的 Content-Type 正确
[ ] /healthz 和 /healthz/telegram-webhook 为 Fastify JSON
[ ] 运营可建公开预览、会员内容、内容包内容，无频道 ID 输入框
[ ] single 内容无法新建或发布
[ ] H5 USDT：创建订单 → 等待到账 → 权益刷新 → 频道入口
[ ] Mini App Stars：成功回调 → 权益刷新 → 频道入口
[ ] 无权益用户不能生成邀请；过期/退款后不可继续生成
[ ] 私密邀请链接不出现在 JSON、前端状态、日志或审计
[ ] Caddy、Telegram Bot、私密频道权限的 staging 验证记录完整
[ ] P0 支付安全测试与新增阶段一测试全部通过
```
