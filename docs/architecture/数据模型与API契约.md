# 同频 InTune 数据模型与 API 契约

## 1. 核心数据表

### users

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 内部主键 |
| telegram_user_id | bigint, unique | Telegram 用户唯一 ID |
| username | varchar, nullable | Telegram 用户名 |
| display_name | varchar | 显示名 |
| photo_url | text, nullable | 头像地址 |
| status | enum | active / frozen / deleted |
| created_at | timestamptz | 创建时间 |

### contents

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 内容 ID |
| title | varchar | 标题 |
| cover_url | text | 封面 |
| description | text | 简介 |
| duration_seconds | integer | 时长 |
| access_type | enum | public / single / package / membership |
| status | enum | draft / pending_review / published / offline / archived |
| is_recommended | boolean | 是否推荐 |
| is_featured | boolean | 是否精选 |
| featured_sort | integer, nullable | 首页推荐排序权重 |
| recommend_starts_at | timestamptz, nullable | 推荐起始时间 |
| recommend_ends_at | timestamptz, nullable | 推荐结束时间 |
| channel_id | bigint, nullable | Telegram 资源频道 ID |
| package_id | uuid, nullable | 所属内容包 |
| product_id | uuid, nullable | 对应商品 |
| published_at | timestamptz, nullable | 上架时间 |

### products

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 商品 ID |
| type | enum | single / package / membership |
| title | varchar | 商品名称 |
| price_minor | bigint | 最小货币单位金额 |
| currency | varchar | 货币代码 |
| duration_days | integer, nullable | 会员有效天数；一次性商品为空 |
| status | enum | active / inactive |

### content_packages

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 内容包 ID |
| title | varchar | 名称 |
| cover_url | text | 封面 |
| channel_id | bigint | 对应私密频道 |
| product_id | uuid | 对应商品 |
| status | enum | draft / published / offline |

### categories

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 分类 ID |
| name | varchar | 分类名称 |
| slug | varchar, unique | API 标识 |
| icon_url | text, nullable | 图标/封面 |
| sort_order | integer | 前端排序 |
| status | enum | active / inactive |

### banners

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | Banner ID |
| title | varchar | 标题 |
| description | varchar | 短文案 |
| image_url | text | 16:9 横幅图 |
| action_label | varchar | 按钮文案 |
| target_type | enum | content / package / category / external_link |
| target_id | varchar, nullable | 对应对象 ID |
| external_url | text, nullable | 合规外链 |
| sort_order | integer | 首页排序 |
| starts_at / ends_at | timestamptz | 展示周期 |
| status | enum | draft / active / inactive |

### orders

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 订单 ID |
| order_no | varchar, unique | 人类可读订单号 |
| user_id | uuid | 用户 |
| product_id | uuid | 商品 |
| amount_minor | bigint | 应付金额 |
| currency | varchar | 币种 |
| payment_provider | varchar | Telegram Stars / 其他合法支付服务 |
| provider_order_id | varchar, nullable | 三方订单号 |
| status | enum | pending / processing / paid / failed / refunded / cancelled / expired |
| paid_at | timestamptz, nullable | 支付成功时间 |

### entitlements

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 权益 ID |
| user_id | uuid | 用户 |
| resource_type | enum | content / package / membership_channel |
| resource_id | uuid | 内容/包/频道逻辑 ID |
| source_order_id | uuid, nullable | 来源订单 |
| starts_at | timestamptz | 生效时间 |
| expires_at | timestamptz, nullable | 到期时间 |
| status | enum | active / revoked / expired |

### telegram_invites

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 记录 ID |
| user_id | uuid | 用户 |
| entitlement_id | uuid | 对应权益 |
| channel_id | bigint | 频道 |
| invite_link | text | 加密存储或脱敏日志 |
| expires_at | timestamptz | 失效时间 |
| used_at | timestamptz, nullable | 使用时间 |

### admin_audit_logs

记录管理员操作：操作者、动作、对象、前后值、原因、IP/会话、时间。

## 2. 用户端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/telegram/session` | 接收 `initData`，验签并建立会话 |
| GET | `/api/home` | Banner、分类、推荐/精选内容配置 |
| GET | `/api/contents` | 两列列表数据；支持 type/category/sort/page |
| GET | `/api/contents/:id` | 内容详情与当前用户权限 |
| GET | `/api/packages` | 内容包列表 |
| POST | `/api/orders` | 创建订单；传入 productId |
| GET | `/api/orders/:id` | 查询订单状态 |
| GET | `/api/me` | 当前用户、会员和权益摘要 |
| GET | `/api/me/entitlements` | 已解锁内容/内容包 |
| POST | `/api/resources/:id/access-link` | 核验权益后生成短时 Telegram 邀请链接 |
| POST | `/api/support/tickets` | 支付/入口/举报支持工单 |

### `/api/telegram/session` 示例响应

```json
{
  "user": { "id": "uuid", "telegramUserId": "123456", "displayName": "InTune User" },
  "access": { "membership": "active", "expiresAt": "2026-09-01T00:00:00Z" },
  "sessionExpiresAt": "2026-08-07T00:00:00Z"
}
```

### `/api/resources/:id/access-link` 规则

- 未登录：401。
- 无有效权益：403。
- 内容下架/频道未配置：409。
- 成功：创建或复用短时、单次 invite link，记录 `telegram_invites`，返回 `{ "url": "https://t.me/+...", "expiresAt": "..." }`。
- 不返回频道 ID、长期链接或 Bot Token。

## 3. 管理后台 API

| 模块 | 路径前缀 | 必须能力 |
| --- | --- | --- |
| 看板 | `/api/admin/dashboard` | 日期筛选、收入/订单/用户漏斗 |
| 首页运营位 | `/api/admin/banners`、`/api/admin/categories`、`/api/admin/recommendations` | Banner、分类、推荐/精选的 CRUD、排序、定时上下线 |
| 内容 | `/api/admin/contents` | CRUD、审核、上/下架、频道映射 |
| 内容包 | `/api/admin/packages` | CRUD、内容关联、价格、频道映射 |
| 商品 | `/api/admin/products` | 价格、币种、状态、有效期 |
| 用户 | `/api/admin/users` | 搜索、查看、冻结、权益调整 |
| 订单 | `/api/admin/orders` | 筛选、回调记录、人工补单、退款流转 |
| 财务 | `/api/admin/finance` | 日/月汇总、对账、CSV 导出 |
| Telegram | `/api/admin/telegram` | 频道配置、邀请记录、权限同步 |
| 审计 | `/api/admin/audit-logs` | 操作追踪 |

## 4. 支付与权益状态机

```text
创建订单(pending)
  → 发起支付(processing)
  → 已验证回调(paid)
  → 创建权益(active)
  → 用户请求访问链接
  → 发放短时邀请

退款(refunded) / 到期(expired) / 风险冻结(revoked)
  → 撤销权益
  → 移除频道成员或停止发放新入口
```

支付回调必须使用支付服务商的签名进行验证，并以 `provider_order_id + event_id` 做幂等锁。任何异常进入人工订单队列，不能自动给权益。

## 5. Bot 权限操作

- Bot 必须是目标私密频道管理员，并具备创建邀请链接、批准/管理成员所需的最小权限。
- 发放入口时使用短过期时间、`member_limit=1` 的邀请参数（具体参数以当前 Telegram Bot API 为准）。
- 退款、到期、冻结：调用 Telegram 成员限制/移除能力并记录结果；若 API 失败，写入重试任务与人工异常队列。
- 所有频道操作都应可追溯到用户、权益、订单和管理员动作。
