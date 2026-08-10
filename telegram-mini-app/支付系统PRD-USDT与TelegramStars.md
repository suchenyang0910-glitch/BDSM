# InTune 支付、登录与 VIP 频道交付开发基线

> 更新日期：2026-08-08  
> 适用范围：独立 H5、Telegram Mini App、Bot、服务端、管理后台。  
> 本文是 Trae 后续开发与验收的支付基线；与本文冲突的草案实现不得合并或部署。

## 1. 最终业务结构

```text
同一 User / Order / Entitlement
        │
        ├── 独立 H5：Telegram 一键登录 → USDT-TRC20 支付
        └── Telegram Mini App：Telegram Stars 支付
        │
支付确认 → 权益激活 → 受控进入 Telegram VIP 私密频道观看视频
```

- 视频完整资源仅发布在 Telegram VIP 私密频道；H5 和 Mini App 不承载完整视频播放。
- H5 与 Mini App 共用同一用户、订单和权益；统一账户主键为 `telegram_user_id`。
- Telegram Mini App 内销售数字内容时，只展示 Telegram Stars。USDT-TRC20 仅在独立 H5 支付页提供；不得在 Mini App 内展示 USDT 地址、二维码、支付按钮或站外支付引导。Telegram 对 Bot/Mini App 内数字内容支付的官方规则见：[Telegram Stars Payments](https://core.telegram.org/bots/payments-stars)。

## 2. 登录与账户

### 2.1 H5：Telegram 一键登录优先

```text
打开 H5 → 使用 Telegram 登录 → 服务端验证 OIDC 登录凭证
→ 查找/创建同一用户 → 写入安全 Cookie → 进入内容页
```

- 使用 Telegram Login OIDC，服务端验证签名、`iss`、`aud`、过期时间、`state` 与 PKCE。
- 登录 Session 使用 `HttpOnly + Secure + SameSite=Lax` Cookie；禁止将登录 Token 写入 `localStorage`。
- 首次访问无需注册、无需设置密码。
- 密码只是可选的备用登录方式。设置/修改密码、绑定/解绑 Telegram、查看敏感账户信息时，必须再次验证 Telegram 登录态。
- 密码使用 Argon2id 哈希；禁止保存明文、可逆密码或在日志中输出密码相关信息。

### 2.2 Mini App：Telegram 身份验签

- Mini App 使用 Telegram `initData`，后端验签后映射到同一 `telegram_user_id`。
- 不信任前端传入的用户 ID、用户名或支付状态。

## 3. 支付体验

### 3.1 Mini App：Telegram Stars

```text
内容详情 → 立即解锁 → Telegram Stars 原生付款 → successful_payment
→ 订单 paid → 权益 active → 进入 VIP 频道观看
```

- 仅收到 `successful_payment` 后才允许发放权益；`pre_checkout_query` 仅用于预校验。
- 保存 `telegram_payment_charge_id`，用于退款与审计。
- 支付成功自动展示“已解锁”和“进入 VIP 频道观看”，不要求用户进入订单页找内容。

### 3.2 H5：USDT-TRC20 极简支付页

```text
创建订单 → 显示精确金额和收款地址 → 用户外部钱包转账
→ 链上监听检测到账 → 确认中 → 已解锁 → 进入 VIP 频道
```

H5 USDT 页面只展示：

- 应付金额（点击复制）；
- 网络：`TRC-20`；
- 收款地址（点击复制完整地址）；
- 订单 20 分钟倒计时；
- 状态：等待付款 / 已检测到付款 / 正在确认 / 已解锁；
- 已解锁后的“进入 VIP 频道观看”按钮。

禁止让用户：手填交易哈希、上传截图、选择网络、修改金额或理解确认数。链上确认数仅以“正在确认”展示。

## 4. USDT-TRC20 服务端规则

### 4.1 单事务创建订单

以下步骤必须在同一个数据库事务中完成：

```text
创建占位订单 → 锁定并分配地址 → 查询已占用实际尾数
→ 选择尾数 → 写入最终金额和地址关联 → 一次性提交
```

任一步异常必须整体回滚：不得残留 `pending` 订单、`assigned` 地址或半完成审计记录。

### 4.2 正确的唯一尾数算法

金额使用 USDT 最小单位整数（`1 USDT = 1,000,000`），禁止浮点数。

```text
baseTail   = baseAmountMinor % 100
targetTail = 从该地址当前未占用的“实际尾数”中选择
delta      = (targetTail - baseTail + 100) % 100
final      = baseAmountMinor + delta
```

必须满足：

```text
final >= base
final % 100 == targetTail
0 <= delta <= 99
```

API 返回：

```json
{
  "baseAmountMinor": "99000011",
  "finalAmountMinor": "99000037",
  "actualTailMinor": 37,
  "uniqueDeltaMinor": 26,
  "displayAmountDecimal": "99.000037"
}
```

### 4.3 P0：尾数空间耗尽不得静默复用

一个地址在同一有效观察窗口内最多安全使用 100 个实际尾数（`00`–`99`）。

当 100 个尾数已占满时，必须：

```text
当前事务回滚
→ 尝试另一可用地址
→ 若无可用地址，返回通用 503：usdt_address_pool_exhausted
→ 不创建订单、不复用 0 尾数、不产生冲突匹配
```

必须有自动化测试：100 个尾数已占满时，第 101 次创建不会生成重复金额，且订单/地址均无脏写。

### 4.4 P0：数据库原始错误不得写 stdout/stderr

用户响应不得包含 SQL、表名、字段名、完整地址、订单 ID、堆栈、原始错误文本或 Token。

普通服务端 stdout/stderr 同样不得输出原始数据库 `reason`、SQL 或完整业务标识。仅允许输出脱敏结构化事件：

```text
event=usdt_assign_failed
errorClass=db_error
prismaCode=Pxxxx
orderFingerprint=<HMAC>
```

若确需保留原始异常用于排障，只能进入具备访问控制、加密保存、保留期与审计能力的错误追踪系统；禁止使用 `console.error(rawError)`。

错误语义：

| 场景 | HTTP | 用户错误码 |
| --- | ---: | --- |
| 地址池无可用地址 | 503 | `usdt_address_pool_exhausted` |
| 地址池数据库异常 | 500/503 | `usdt_assign_failed` |
| 尾数分配异常 | 500 | `usdt_unique_tail_query_failed` |

## 5. 链上确认与幂等

- 仅支持指定 USDT-TRC20 合约与 TRON 网络。
- 链上监听 Worker 校验：网络、合约、收款地址、精确金额、订单有效期、交易哈希和确认数。
- 确认数不足：订单显示“正在确认”，不得发放权益。
- 达到确认阈值后，在同一事务内完成：支付记录确认、订单 `paid`、权益创建。
- 相同交易哈希/原始事件必须幂等；重复回调不得重复发权益。
- 过期订单到账进入人工复核，不得自动发放权益。

## 6. VIP 私密频道交付

```text
订单 paid → Entitlement.active
→ 用户点击“进入 VIP 频道观看”
→ 后端验证权益
→ 生成单次、短时有效邀请
→ Bot 私信或服务端 302 受控跳转
→ 用户进入 VIP 私密频道观看
```

- 首期主会员频道固定为 `membership-main`；H5 与 Mini App 均读取同一权益。
- 不保存、展示或下发永久 `t.me/+...` 邀请链接。
- 常规 JSON API 不得返回邀请链接；仅允许 Bot 私信或服务端一次性受控跳转。
- 邀请生成、补发、查看完整频道 ID、退款撤权都必须审计并限频。
- 用户未授权 Bot 私信时，提示其启动/授权 Bot 后再领取；不得以永久链接兜底。
- 退款、到期、人工撤权：先更新订单/权益/审计，再异步移除频道成员并发送通知；外部 Telegram 调用失败不得回滚财务状态，需进入受控重试。

## 7. 后台权限与地址池

- `finance`：查看脱敏地址、管理地址池、手动释放过期地址。
- `super_admin`：受控短时查看完整地址，必须二次确认与审计。
- 运营、客服、审计角色不能查看完整地址，不能修改地址池。
- 地址新增、停用、强制取消关联订单、手动释放过期地址与审计日志必须在同一事务提交。
- 活跃订单地址不可直接释放；只有显式取消对应订单后才允许停用。
- 地址私钥、助记词、交易所密码绝不进入业务数据库。

## 8. Trae 开发顺序与验收

1. 修复尾数空间耗尽：切换地址或安全失败，补第 101 笔测试。
2. 移除 stdout/stderr 原始 DB 错误，接入脱敏结构化错误记录。
3. 固化 USDT 单事务建单、真实并发、失败零脏写。
4. 完成 H5 Telegram OIDC 登录、Cookie Session、Telegram 绑定与可选密码。
5. 完成 H5 USDT 极简支付状态页。
6. 完成 Stars 支付成功后的统一权益发放。
7. 完成受控 VIP 频道邀请交付、退款/到期撤权与重试。

上线前最低验收：

- Stars 支付、退款、幂等、权益发放全流程；
- H5 登录、Cookie 过期、退出、Telegram 重新验证；
- USDT 非整百标价、真实并发、100 尾数耗尽、重复链上事件、过期到账；
- 用户/API/stdout/stderr 均不泄露原始 DB 错误或敏感支付数据；
- H5 与 Mini App 支付后进入同一 VIP 权益和同一频道交付闭环。
