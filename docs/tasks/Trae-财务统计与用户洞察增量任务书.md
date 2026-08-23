# InTune · 财务统计、运营埋点与用户偏好增量任务书

> 状态：需求已确认，待开发排期。  
> 目标：让运营能看清收款、转化和内容偏好；不以牺牲用户隐私为代价。  
> 适用端：管理后台、H5、Telegram Mini App、服务端。

## 0. 不可突破的边界

- 不向前端、日志、审计字段返回或写入完整 USDT 收款地址、交易哈希、Bot Token、私密频道 ID、邀请链接。
- 财务后台仅 `finance` 与 `super_admin` 可见；收款地址明文仍仅 `super_admin` 在二次确认后查看，默认全部脱敏。
- 埋点使用服务端生成的匿名/用户 HMAC 标识；不得把 Telegram 用户 ID、IP、设备指纹、钱包地址作为分析维度明文发送到第三方。
- 偏好采集只能由用户主动选择；不得把浏览行为推断成敏感身份、私密实践、健康、政治、宗教或精确位置标签。
- 首期不接第三方广告追踪 SDK；全部写入自有 PostgreSQL，由后端聚合。

---

## 1. 管理后台：财务统计

### 1.1 新增菜单与权限

菜单：`财务中心 > 收款概览`、`财务中心 > 地址池监控`、`财务中心 > 订单对账`。

| 能力 | finance | super_admin | 其他角色 |
| --- | --- | --- | --- |
| 看财务汇总、订单统计、脱敏地址统计 | 允许 | 允许 | 禁止 |
| 导出汇总 CSV | 允许，记录审计 | 允许，记录审计 | 禁止 |
| 查看单个地址明文 | 禁止 | 二次确认后允许，记录审计 | 禁止 |
| 新增、停用、轮换收款地址 | 禁止 | 允许，双人复核/审计 | 禁止 |

### 1.2 收款概览页（MVP）

筛选：今天、7 天、30 天、自定义日期、支付方式、订单状态、商品类型。

核心指标：

- 已确认 GMV：Stars、USDT-TRC20、人工确认分别统计；同时显示合计。
- 退款金额、净收入、支付成功订单数、付费用户数、客单价、支付成功率。
- 待确认 USDT 金额、待支付订单数、过期订单数、退款订单数。
- USDT 从发现到达到确认数的平均耗时；Stars 从建单到成功的平均耗时。
- 近 30 日趋势：订单数、已确认金额、退款金额、净收入、支付方式占比。

金额规则：

- Stars 与 USDT 不直接相加；先分别展示。若后台设置了明确、带时间戳的内部结算汇率，才允许显示“估算折合”，并标注“估算，不作为账务凭证”。
- 以 `order.status=paid`、确认交易记录为收入事实；创建订单、链上 detected/confirming 均不得计入已确认收入。
- 退款以 `order.status=refunded` 计入退款；净收入 = 已确认收入 - 已退款金额。

### 1.3 地址池监控页

每个地址仅展示：`addressMasked`、状态、创建/最近使用时间、已分配订单数、已确认订单数、确认中订单数、过期释放数、退款关联数、最近监听时间、异常状态。

全局告警：

- 可用地址低于阈值（默认 3 个）。
- 24 小时监听未成功扫描。
- 任一地址连续监听失败达到阈值。
- 单地址订单量异常偏高、尾数空间耗尽、地址状态被人工改变。
- 链上到账与订单金额、网络、收款地址、确认数不匹配。

禁止事项：后台不展示链上余额，不自动发起转账，不保存私钥；地址池只能作为收款归集监控，不是钱包管理系统。

### 1.4 订单对账页

- 按订单号、时间、支付方式、状态、商品过滤。
- 显示：订单金额、支付方式、订单状态、确认时间、确认耗时、脱敏收款地址、结构化异常码。
- 支持仅导出汇总或最小必要明细；每次导出写 `admin.financial.export` 审计。
- 对账差异仅显示计数/金额和结构化原因；不向页面回传原始数据库错误、完整交易哈希或钱包地址。

### 1.5 服务端/API 交付

建议路由：

```text
GET /api/admin/finance/overview
GET /api/admin/finance/trends
GET /api/admin/finance/address-pool
GET /api/admin/finance/reconciliation
GET /api/admin/finance/export       # 异步导出，需审计
```

查询必须参数化；金额全部以 `BigInt`/字符串安全序列化，禁止把 BigInt 直接交给 JSON。

---

## 2. 用户数据埋点与运营漏斗

### 2.1 漏斗定义

```text
访问首页
  → 匿名会话建立
  → 浏览内容列表
  → 打开内容详情
  → 点击解锁 / 创建订单
  → 支付确认成功
  → 权益已激活
  → 频道访问交付成功
  → 7 日再次访问 / 再次购买
```

每一步统计人数、转化率、流失率、按内容分类/渠道/终端的分组结果。

### 2.2 首期事件字典

| 事件 | 触发时机 | 必填安全字段 |
| --- | --- | --- |
| `session_started` | 访客会话或 Telegram 登录成功 | sessionHmac、platform、entrySource |
| `page_viewed` | 首页/发现/会员/订单/我的/详情打开 | pageName、contentIdHmac 可选 |
| `content_impression` | 内容卡片进入可视区域 | contentIdHmac、position、sourceModule |
| `content_opened` | 打开内容详情 | contentIdHmac、sourceModule |
| `unlock_clicked` | 点击 Stars/USDT 解锁 | productIdHmac、paymentMethod |
| `order_created` | 服务端订单创建成功 | orderNoHmac、productIdHmac、paymentMethod |
| `payment_confirmed` | Stars/USDT/人工确认首次成功 | orderNoHmac、paymentMethod、productIdHmac |
| `entitlement_activated` | 权益首次生效 | resourceType、resourceIdHmac |
| `channel_access_delivered` | 受控跳转/私信交付成功 | deliveryType、resourceType |
| `preference_saved` | 用户保存偏好 | selectedCount、source |

禁止发送：完整 URL query、订单号、Telegram ID、IP、设备 ID、钱包地址、邀请链接、交易哈希、原始错误消息。

### 2.3 数据结构与保留

新增 `analytics_events`：`id`、`occurred_at`、`event_name`、`anonymous_id_hmac`、`user_id_hmac?`、`session_id_hmac`、`platform`、`properties_json`（字段白名单）、`created_at`。

- 事件入库由后端批量接口验证白名单；客户端不能自定义 event/properties。
- 明细保留 90 天；按日聚合表保留 24 个月；用户删除/注销时删除其可关联明细。
- 管理后台只看聚合结果，不能逆向查看单一用户路径。

### 2.4 后台运营数据页

新增菜单：`数据中心 > 漏斗分析`、`数据中心 > 内容表现`、`数据中心 > 留存分析`。

- 漏斗：按日期、端（H5/Mini App）、来源、内容分类、支付方式筛选。
- 内容表现：曝光、详情打开率、解锁点击率、建单率、支付成功率、复购贡献。
- 留存：次日/7 日/30 日回访；只显示群体聚合。
- 数据低于最小样本（建议 10 人）时显示“样本不足”，不显示小样本细分。

---

## 3. 用户主动偏好采集

### 3.1 触发与体验

- 首次建立访客会话后，不强制弹窗；在“发现”页空状态、“我的 > 内容偏好”及完成首次浏览后轻引导。
- 用户可以跳过；以后可在“我的 > 内容偏好”修改、清空或关闭个性化推荐。
- 文案：`选择你更想看到的主题，我们仅用它优化同频内的内容排序。你可以随时修改或清除。`

### 3.2 可采集字段（首期）

1. 内容主题：由后台启用的内容分类/标签，多选，最多 5 个。
2. 内容形式：精选点播、创作者访谈、社区讨论、活动预告，多选。
3. 发现方式：最新优先、精选优先、关注优先。
4. 通知偏好：订单状态、权益提醒、公开频道更新、活动通知，分别开关。

禁止采集：法律身份、性取向、私密实践、身体/医疗信息、精确地理位置、通讯录、钱包资产、Telegram 私聊内容。

### 3.3 数据模型/API

```text
user_content_preferences
  id, user_id, category_id?, preference_type,
  value_key, is_enabled, source, updated_at

POST /api/me/preferences
GET  /api/me/preferences
DELETE /api/me/preferences
```

- 访客偏好先保存在服务端匿名会话下；绑定 Telegram 后由用户确认迁移，不能自动合并。
- 每次保存记录业务审计（不写明细偏好值），只记录 `preference.updated` 与数量。
- 推荐首期仅做“优先排序”，不得锁死内容池；保留“查看全部/重置推荐”入口。

---

## 4. 开发顺序与验收

### P0：数据与安全基础

1. 事件白名单、HMAC 标识、服务端批量埋点入口。
2. 财务汇总查询与地址池健康监控，不暴露明文地址。
3. 权限、审计、BigInt JSON 安全序列化、导出最小化。

### P1：后台与用户体验

1. 财务中心三页。
2. 漏斗、内容表现、留存三个聚合报表。
3. 我的偏好设置页和轻量偏好引导。

### 必须通过的验收

- finance 看不到完整地址；非 finance/super_admin 全部 403。
- 订单、退款、链上确认数据与财务汇总一致；Stars/USDT 不错误相加。
- 同一支付确认事件只记一次 `payment_confirmed`。
- 任一分析 API 返回中不含 Telegram ID、订单号、地址、交易哈希、邀请链接或原始异常。
- 用户可跳过、修改、清空偏好；关闭个性化后不再使用偏好排序。
- 漏斗的支付确认数与 `paid` 订单数可对账，差异必须有结构化原因。
