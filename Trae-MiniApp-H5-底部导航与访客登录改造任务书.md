# InTune · Mini App / H5 底部导航、访客自动登录与接口联调任务书

> 目标：将 `https://bdsm.linkx.club/` 改造成可在 Telegram Mini App 与普通浏览器 H5 中使用的统一点播入口；提供标准 App 底部导航、无注册阻力的访客自动登录，以及可验证的“浏览 → 购买 → 权益 → 频道交付”闭环。

## 0. 当前核对结论（编码前必须接受）

### 已正常的服务端能力

| 能力 | 接口 | 当前结果 |
|---|---|---|
| 首页目录 | `GET /api/home` | 正常，返回分类、已发布内容、Banner |
| 内容详情 | `GET /api/contents/:id` | 正常，返回商品、价格、解锁状态 |
| H5 访客会话 | `POST /api/auth/h5/guest-session`、`GET /api/auth/h5/session` | 服务端已实现，但首页未接入 |
| Telegram 登录 | `POST /api/telegram/session` | 已实现，必须校验 Mini App `initData` |
| Stars 订单 | `POST /api/orders/stars` | 已实现，仅 Telegram 场景可唤起 Invoice |
| USDT 订单 | `POST /api/orders/usdt` | 已实现，要求用户已拥有服务端会话 |
| 权益/订单 | `GET /api/user/entitlements`、`GET /api/user/orders` | 已实现，需要登录会话 |
| VIP 频道交付 | `POST /api/resources/:id/access-link` | 已实现，仅允许 **POST** |

### 当前 P0 阻断项（必须修）

1. `telegram-mini-app/app.js` 仅尝试 `POST /api/telegram/session`；在普通浏览器没有 Telegram `initData` 时，会直接回退 demo 数据，**不会创建 H5 访客会话**。
2. `requestChannelLink()` 当前用浏览器 **GET** 打开 `/api/resources/:id/access-link`，而服务端明确只允许 POST，GET 固定返回 405。因此“进入频道观看”目前不可靠。
3. 生产环境 API 失败时不能静默显示 demo 内容，否则运营会误以为真实内容、订单和权益都正常。
4. 当前 UI 只有首页、详情、订单、权益四个 hash 视图，缺少标准底部导航和个人中心。
5. 单个内容当前只关联一个 `productId`。若要让同一权益同时支持 Stars 与 USDT，需增加支付商品变体/映射；不能把 XTR 商品直接提交给 `/api/orders/usdt`。

**验收结论：在本任务完成前，不得对外宣称站外 H5 访客支付和频道交付已可正常使用。**

---

## 1. 产品信息架构：标准五栏底部导航

底栏固定在安全区上方，五项：

| Tab | 路由 | 核心内容 | 访客可用 | 登录后增强 |
|---|---|---|---|---|
| 首页 | `#tab=home` | Banner、推荐、继续浏览、热门分类 | 是 | 显示已解锁/会员状态 |
| 发现 | `#tab=discover` | 分类、筛选、搜索、全部内容两列列表 | 是 | 已解锁内容优先显示 |
| 会员 | `#tab=membership` | 会员权益、内容包、支付入口 | 是 | 展示当前到期日、续费/已开通 |
| 订单 | `#tab=orders` | 待支付、已支付、退款/失效订单 | 自动访客会话后可用 | Telegram 绑定后可跨端恢复 |
| 我的 | `#tab=me` | 访客身份、Telegram 绑定、权益入口、频道入口、退出本设备 | 是 | 显示 Telegram 昵称与绑定状态 |

内容详情是二级页：`#view=content&id=<contentId>`，不占底栏；返回时回到来源 Tab 与滚动位置。

### 首期不做

- 直播、积分、钱包余额、社交动态、私信。
- 单条内容在共享 VIP 频道中的“单独授权”。首期仍只支持会员主频道和独立内容包频道。

---

## 2. 视觉规范

### 品牌基调

成熟、克制、私密、可信；避免竞品式高饱和促销风和暗示性视觉。

| Token | 值 | 用途 |
|---|---|---|
| `bg.base` | `#12111A` | 页面背景 |
| `bg.surface` | `#1C1927` | 卡片/底栏 |
| `bg.elevated` | `#262236` | 弹层/选中卡片 |
| `brand.primary` | `#A66BFF` | 主按钮、激活态 |
| `brand.soft` | `#D9C2FF` | 标签、弱强调 |
| `text.primary` | `#F4F0FF` | 标题 |
| `text.secondary` | `#AAA2BC` | 说明文字 |
| `state.success` | `#6ED6A5` | 已解锁/成功 |
| `state.warning` | `#F4BD6A` | 待支付/提醒 |
| `state.danger` | `#F17D8F` | 失效/错误 |

### 布局规则

- 设计基准：390px 宽移动端；内容最大宽度 680px，桌面居中。
- 8pt 间距体系：8 / 12 / 16 / 24 / 32。
- 视频卡片两列、固定 `16:9` 封面；卡片圆角 14px；标题最多 2 行。
- 底栏高度 64px + `env(safe-area-inset-bottom)`；正文底部预留至少 96px。
- 所有可点击目标至少 44×44px；激活态同时使用颜色、图标填充和文字，不只依赖颜色。
- 页面加载使用骨架屏；业务失败使用可读错误 + “重试”按钮，禁止无提示空白。

### 底栏交互

- 使用 SVG/内置图标，不加载外部 icon CDN。
- 非激活：`text.secondary`；激活：`brand.primary`，上方 3px 指示条。
- 待支付订单可在“订单”图标右上角显示数字徽标，超过 99 显示 `99+`。
- 内容详情、支付页打开时底栏隐藏；返回后恢复。

---

## 3. 统一登录：Telegram 优先，H5 自动访客兜底

### 3.1 启动状态机（必须按此顺序）

```text
页面启动
  ├─ Telegram Mini App 且 initData 存在
  │    └─ POST /api/telegram/session { initData, botKey? }
  │         └─ 成功：Telegram 用户会话
  └─ 非 Telegram / Telegram 校验失败
       ├─ GET /api/auth/h5/session
       │    ├─ 200：恢复已有访客或已绑定用户会话
       │    └─ 401：POST /api/auth/h5/guest-session
       │         └─ 200：创建匿名访客会话
       └─ 任一步 5xx：显示“暂时无法建立会话”与重试，不得回退 demo 数据
```

### 3.2 安全边界

- 所有 fetch 使用 `credentials: "include"`。
- 服务端 `h5_device_token` 是 HttpOnly Cookie；前端不得读取、复制或写入 token。
- 前端不得将 userId、订单、权益写入 localStorage；只保留非敏感 UI 偏好（例如当前 Tab）。
- 访客登录不要求邮箱、密码或手机号；站外用户可先浏览、下单。
- “我的 → 绑定 Telegram”跳转现有 `/api/auth/h5/telegram/callback`，成功后由服务端合并访客订单/权益到 Telegram 用户。
- 当前服务端没有可供用户设置密码的完整 API；**不要先展示“修改密码”入口**，避免假功能。该能力须另立后端需求。

### 3.3 UI 身份文案

- 访客：`访客模式 · 已自动保存本设备订单`，主操作“绑定 Telegram，跨设备恢复权益”。
- 已绑定：显示 Telegram 昵称和“已绑定”。
- 不显示匿名 userId、Cookie、设备指纹或内部数据库 ID。

---

## 4. 支付与频道交付修正

### 4.1 Stars / USDT 的显示规则

- Telegram Mini App：若该权益存在 Stars 商品，显示“Telegram Stars”主按钮；如同一权益存在 USDT 变体，次级显示“USDT-TRC20”。
- 站外 H5：默认显示“USDT-TRC20”；若用户已绑定 Telegram，可同时提示“在 Telegram 内可使用 Stars”。
- USDT 支付页只显示：订单号、精确应付金额、TRC-20 标识、收款地址、复制按钮、20 分钟倒计时、监听状态。禁止复杂钱包/积分流程。

### 4.2 商品变体（P1，支持双支付方式的必要条件）

为同一会员/内容包权益建立支付商品组，而不是让一个商品同时拥有两种货币。

建议新增：

```text
product_group_key: "membership_30d" | "package_x" | ...
payment_method: "telegram_stars" | "usdt_trc20_external"
```

内容详情 API 应返回该权益可购买的 `productVariants[]`。在此改造前：

- XTR 商品只能调用 `/api/orders/stars`；
- USDT 商品只能调用 `/api/orders/usdt`；
- 禁止前端猜测或币种换算。

### 4.3 频道交付 P0 修正

现有接口是：

```text
POST /api/resources/:id/access-link
```

当前 `app.js` 错误使用 GET，必然 405。修复方式：创建临时 HTML form，以 **POST** 提交到同源接口并在新窗口打开；让浏览器自然跟随服务端 302 到 Telegram，不读取、不保存邀请链接。

```js
function openChannelAccess(resourceId) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `/api/resources/${encodeURIComponent(resourceId)}/access-link`;
  form.target = "_blank";
  form.style.display = "none";
  document.body.appendChild(form);
  form.submit();
  form.remove();
}
```

不得使用 GET、不得通过 fetch 读取 `Location`、不得将 `t.me/+...` 邀请链接写进 JavaScript 状态、日志或 localStorage。

---

## 5. 接口契约同步表（Trae 必须逐项核对）

| 用户动作 | 正确接口 | 方法 | 关键响应字段 | 当前状态 |
|---|---|---|---|---|
| 首页加载 | `/api/home` | GET | `banners/categories/contents` | 可用 |
| 发现页分页 | `/api/contents` | GET | `items/pagination` | 可用，注意不是 `contents` |
| 内容详情 | `/api/contents/:id` | GET | `product/unlocked/categories` | 可用 |
| Mini App 会话 | `/api/telegram/session` | POST | `user/access` | 可用 |
| H5 恢复 | `/api/auth/h5/session` | GET | `identity/userId/telegramBound` | 可用但未接入首页 |
| H5 首访 | `/api/auth/h5/guest-session` | POST | `identity=guest` | 可用但未接入首页 |
| Stars 下单 | `/api/orders/stars` | POST | `productId` | 仅 Telegram |
| USDT 下单 | `/api/orders/usdt` | POST | `productId` | 需要已登录会话 |
| 查看订单 | `/api/user/orders` | GET | `items/pagination` | 需要会话 |
| 查看权益 | `/api/user/entitlements` | GET | `summary/memberships/packages/contents` | 需要会话 |
| 进入频道 | `/api/resources/:id/access-link` | **POST** | 302 交付 | 前端当前错误使用 GET，P0 |
| 我的频道 | `/api/user/channels` | GET | `items` | 需要会话 |

---

## 6. 文件改造范围

### 前端

- `telegram-mini-app/index.html`：增加底栏、五个主视图容器、骨架屏与错误态容器。
- `telegram-mini-app/styles.css`：写入本任务书 Token、safe-area、底栏和卡片规范。
- `telegram-mini-app/app.js`：
  - 新增 H5 bootstrap；
  - 统一会话状态；
  - 重构 hash 路由与五栏导航；
  - 修正 POST 频道交付；
  - 生产环境移除 demo fallback；
  - 对响应中的 `items` / `contents` 差异做接口适配层，页面层不得自行猜字段。

### 服务端（仅发现契约确实缺失时改）

- 不重写已存在 H5、Telegram、订单、权益、频道交付接口。
- 双支付商品变体需单独迁移、PRD、测试后再合并。
- 若新增 H5 首页用的只读“我的资料”接口，必须基于 `req.userId`，禁止接受前端传 userId。

---

## 7. 验收清单（必须自动化 + 浏览器真实验收）

### H5 访客

1. 清空 Cookie 打开根域名：自动创建访客会话，首页真实请求 `/api/home` 成功。
2. 刷新：`GET /api/auth/h5/session` 恢复同一会话，不新建用户。
3. 访客可浏览分类、详情、订单空态、权益空态；不存在 demo 假数据。
4. 绑定 Telegram 后，访客订单/权益由服务端合并；再次打开显示已绑定。

### Telegram Mini App

1. 合法 `initData` 建立 Telegram 会话；非法/过期 `initData` 被拒绝。
2. 底栏五项全部可达，返回内容详情后状态正确恢复。
3. Stars 仅在 Telegram 环境展示并可正常唤起；站外不展示不可用 Stars 主操作。

### 订单与交付

1. H5 访客创建 USDT 订单后可在“订单”看到精确金额与状态。
2. 有有效权益的用户点击“进入频道”：请求必须是 POST，服务器返回 302，浏览器进入 Telegram。
3. 无权益用户调用交付接口应被拒绝，不泄露邀请链接。
4. 所有 401/403/409/5xx 均展示明确文案和重试入口，不白屏、不 demo 回退。

### 视觉

1. 375px / 390px / 430px / 桌面宽度均无横向溢出。
2. iOS/Android 安全区不遮挡底栏。
3. 触控目标 ≥44px，文字对比度达可读标准。

## 8. Trae 交付物

1. 前端代码与变更说明。
2. 接口契约差异清单（若发现新增差异，先报告，不可偷偷改字段）。
3. H5 访客、Telegram 会话、POST 频道交付的自动化测试。
4. Playwright 像素级页面截图：首页、发现、会员、订单、我的、详情、H5 初访、Telegram 模拟会话。
5. `node --check telegram-mini-app/app.js`、服务端 `tsc --noEmit`、后台 `npm run build` 和全量测试通过记录。
