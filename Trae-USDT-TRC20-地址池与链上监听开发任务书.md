# InTune · USDT-TRC20 地址池后台与链上监听开发任务书

> 目标：补齐后台“USDT 收款地址”入口，并新增**只读、无私钥**的 TRON 链监听 Worker。用户支付后由 Worker 调用现有内网认单接口，服务端完成订单确认、权益发放与 Telegram VIP 频道交付。

## 0. 先读现有实现：不要重写的部分

现有服务端已具备以下能力，必须复用：

- 地址池 API：`server/src/routes/orders.ts`
  - `GET /api/admin/payment-addresses`
  - `POST /api/admin/payment-addresses`
  - `POST /api/admin/payment-addresses/:id/reveal`
  - `POST /api/admin/payment-addresses/:id/retire`
  - `POST /api/admin/payment-addresses/_release-expired-now`
- USDT 下单和唯一尾数分配：`POST /api/orders/usdt`
- 链上事件认单入口：`POST /internal/usdt/chain-event`
  - 仅允许本机 Worker 调用，Header 为 `x-intune-usdt-worker-secret`
  - 已具备金额、TRC-20 合约、确认数、订单状态、过期时间和幂等校验
- 地址 20 分钟占用和过期自动释放：`server/src/services/usdtPool.ts`
- 既有支付交易幂等：`payment_transactions.raw_event_hash` 唯一

**禁止：**

1. 不要把 TRON 钱包私钥、助记词或交易签名能力放进项目、数据库、后台或 Worker。
2. 不要让浏览器/Mini App 调用 `/internal/usdt/*`。
3. 不要以“转账金额约等于”认单，必须精确按 `amountMinor`（USDT 六位小数）匹配。
4. 不要接受 ERC-20、BEP-20 或任意代币；仅认 TRON 主网 USDT-TRC20 指定合约。

---

## 1. 管理后台：新增「USDT 收款地址」页面

### 1.1 路由、菜单与权限

- 新增页面：`/admin/payment-addresses`
- 左侧菜单位置：`订单与权益` 下，名称为 **USDT 收款地址**。
- `finance`、`super_admin` 可见；其余角色不展示且服务端仍以 403 拦截。
- 页面组件建议：`admin/src/pages/PaymentAddresses.tsx`
- 在 `admin/src/main.tsx` 注册路由。
- 在 `admin/src/components/AdminLayout.tsx` 新增菜单和标题映射。

### 1.2 页面能力

顶部状态卡：

- 可用地址数（available）
- 占用地址数（assigned）
- 已停用地址数（retired）
- TRC-20 监听状态：`正常 / 延迟 / 不可用`，显示最后成功扫描时间（不得显示 API Key）。

地址列表字段：

- 地址（默认脱敏，例如 `TAbc…9xY`）
- 网络（固定显示 `USDT-TRC20`）
- 状态（可用 / 订单占用 / 已停用）
- 占用订单号（如服务端当前 API 未返回 orderNo，可先显示“已占用”；不得泄露其他用户资料）
- 分配时间、预计释放时间、停用时间
- 停用原因

操作：

1. **添加收款地址**
   - 只接受 `T` 开头、Base58 格式的 TRON 地址。
   - 网络固定为 `tron_trc20`，前端不提供网络切换。
   - 明确提示“只填写公开收款地址，绝不填写私钥/助记词”。
2. **查看明文地址**
   - 仅 `super_admin` 显示；点击后必须二次确认。
   - 复用现有 reveal API；前端只短暂展示，不写 localStorage、不打印控制台。
3. **停用地址**
   - 复用现有 retire API。
   - 已被未过期订单占用时，默认禁止停用；强制操作必须二次确认并明确展示会取消对应待支付订单。
4. **立即回收过期地址**
   - 复用现有 `_release-expired-now` API。
   - 仅 finance / super_admin；操作完成显示释放数和失败数。
5. 筛选：状态、关键词、分页；单页 `pageSize <= 100`。

### 1.3 前端 API 类型

在 `admin/src/api/types.ts` 与 `admin/src/api/client.ts` 增加完整类型及封装。地址列表服务端返回字段为 `items`，不是 `data`；调用方必须使用：

```ts
type PaymentAddressItem = {
  id: string;
  network: string;
  addressMasked: string;
  status: "available" | "assigned" | "retired";
  assignedOrderId: string | null;
  assignedAt: string | null;
  releaseAt: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  createdAt: string;
};
```

---

## 2. 新增独立 USDT-TRC20 监听 Worker

### 2.1 进程边界

新增独立进程目录：`server/src/workers/usdtTrc20Monitor.ts`，并增加 npm script：

```json
"usdt:monitor": "tsx src/workers/usdtTrc20Monitor.ts"
```

生产以独立 systemd 服务运行：`intune-usdt-monitor.service`。Worker 不对公网开放端口，只主动请求：

1. TronGrid/可信 TRON 数据源 HTTPS API；
2. 本机 `http://127.0.0.1:3001/internal/usdt/chain-event`。

Worker 使用单独运行用户；`/etc/intune/intune.env` 权限保持受限，严禁输出 env 内容。

### 2.2 配置（仅服务器 env/KMS，不进 Git）

```env
TRON_GRID_BASE_URL=https://api.trongrid.io
TRON_GRID_API_KEY=<server-secret>
USDT_MONITOR_POLL_INTERVAL_MS=15000
USDT_MONITOR_LOOKBACK_MS=3600000
USDT_MONITOR_MAX_ADDRESSES_PER_CYCLE=100
USDT_CONFIRMATIONS_TARGET=19
USDT_ACCEPTED_TOKEN_CONTRACTS=<USDT-TRC20-contract>
USDT_WORKER_SECRET=<existing-server-secret>
```

约束：

- `TRON_GRID_API_KEY` 只放请求 Header `TRON-PRO-API-KEY`，绝不出现在日志、响应、审计或前端。
- 主网地址与合约值必须由运维在服务器填写；任务文档、测试和 Git 中只用占位符。
- 监听器启动时如缺少必要配置，应输出**配置键名称**后退出，不得输出值。

### 2.3 扫描规则

使用 TronGrid V1 的每地址 TRC-20 历史接口：

```text
GET /v1/accounts/{address}/transactions/trc20
  ?only_confirmed=true
  &only_to=true
  &contract_address={accepted-contract}
  &min_timestamp={cursor-or-lookback}
  &limit=200
  &order_by=block_timestamp,asc
```

该接口支持 `fingerprint` 分页，单页上限 200；生产请求需要 API Key。参考：[TronGrid TRC-20 history](https://developers.tron.network/docs/get-trc20-transaction-history)。

每条入账必须同时满足：

1. `to` 与地址池中的地址完全一致（Base58 比较）。
2. 合约地址在 `USDT_ACCEPTED_TOKEN_CONTRACTS` 白名单中。
3. token decimals 必须为 6，金额转换后以整数 `amountMinor` 传递，禁止 JavaScript `Number` 参与金额计算。
4. 仅接受转入；忽略 approval、转出、失败交易、非 USDT 代币。
5. 交易 hash、区块高度、发起地址、接收地址、链上时间字段完整。

### 2.4 向现有认单服务投递

逐条事件 POST 本机接口：

```http
POST http://127.0.0.1:3001/internal/usdt/chain-event
x-intune-usdt-worker-secret: <USDT_WORKER_SECRET>
Content-Type: application/json
```

Payload 只使用以下现有契约：

```json
{
  "source": "tron_listener_v1",
  "network": "tron_trc20",
  "txHash": "<transaction-hash>",
  "tokenContract": "<accepted-usdt-contract>",
  "fromAddress": "<sender-address>",
  "toAddress": "<pool-address>",
  "amountMinor": "<integer-6-decimal-usdt>",
  "blockNumber": "<integer>",
  "confirmations": 19,
  "confirmationsTarget": 19,
  "receivedAt": "<ISO-8601>"
}
```

处理语义：

- `200`：已确认或幂等，推进 cursor。
- `202`：确认数不足，保留该交易，下轮重试，不发权益。
- `422`：业务拒绝（金额不对、订单过期、地址非当前订单等），记录**错误类别**与交易 hash 指纹，推进 cursor，绝不自动补单。
- `401/500/502/网络错误`：不推进 cursor，指数退避重试；连续失败触发告警。

### 2.5 Cursor、幂等与恢复

新增迁移和表 `usdt_monitor_cursors`，至少包含：

- `address_id`（唯一，关联 `payment_addresses.id`）
- `last_block_timestamp`
- `last_tx_hash_fingerprint`（不可保存完整敏感上下文）
- `last_success_at`
- `last_error_class`
- `consecutive_failures`
- `updated_at`

要求：

- 首次扫描回看 `USDT_MONITOR_LOOKBACK_MS`；之后从 cursor 往前额外回看 2 分钟，防数据源延迟。
- 重叠扫描是允许的，最终由既有 `raw_event_hash` 唯一约束保证幂等。
- 不得因为 Worker 重启、TronGrid 429、网络断线漏记交易。
- 每轮优先扫描 `assigned` 地址；同时保留近期释放地址的短期回看，确保迟到转账可被记录为拒绝，而不是静默消失。

### 2.6 监控与告警

新增只读健康状态文件或数据库状态（不得含地址明文/API Key）：

- 最后成功扫描时间
- 最近区块高度
- 本轮扫描地址数、发现交易数、确认成功数、拒绝数
- 连续失败次数
- 最近错误类别：`provider_429` / `provider_5xx` / `network_timeout` / `internal_auth_failed` / `db_error`

告警规则：

- 连续 3 个周期失败，或 2 分钟没有成功扫描 → 服务端安全日志 + 运维告警。
- 地址池 `available < 3` → 管理后台红色提醒。
- 不在日志里输出完整地址、完整交易 hash、订单号、用户资料、API Key 或 Worker Secret；仅输出脱敏指纹。

---

## 3. 自动化验收（必须新增）

### 后台页面

1. finance 能访问地址池页、添加合法 TRON 地址、查看脱敏列表、手动回收过期地址。
2. operator/auditor/customer_service 访问页面或 API 均为 403。
3. super_admin 可二次确认查看明文；finance 不可 reveal。
4. 非 `T` 开头、重复地址、已占用地址的危险停用均给出明确错误。

### Worker

1. Mock TronGrid：合法精确金额 + 19 确认 → 内部接口 200，订单 paid，权益仅发放一次。
2. 18 确认 → 内部接口 202，订单不可发权益；下轮 19 确认后成功。
3. 金额、合约、接收地址任一不匹配 → 422/rejected，零权益发放。
4. 同一 tx 重复返回/Worker 重启 → 只有一条 `payment_transactions` 与一次权益。
5. TronGrid 429/超时 → cursor 不推进、指数退避、产生脱敏告警。
6. Worker 不监听公网端口；内部 Secret 错误时服务端拒绝 401。

## 4. 交付与上线顺序

1. 先完成后台地址池页与 API 联调；只添加测试地址，不导入任何私钥。
2. Worker 用 TRON 测试网或 Mock 做全量验收。
3. 主网启用前，由项目负责人在服务器 env 填入 TronGrid API Key 与允许合约白名单。
4. systemd 启动 Worker，验证健康状态、单笔小额真实支付、确认数等待、权益发放、VIP 频道邀请四步闭环。
5. 真实验收通过后再开放用户 USDT 支付入口。

## 5. Trae 完成定义

只有同时满足以下条件才可交付：

- 后台存在可用的“USDT 收款地址”入口；
- 地址只以脱敏形式常规展示，私钥从未进入系统；
- Worker 已在独立服务中运行并具备重启恢复、幂等、退避和告警；
- 现有 `/internal/usdt/chain-event` 契约未被破坏；
- 新增自动化测试全部通过；
- 提供 migration、systemd 文件、`.env.example` 占位说明和脱敏部署步骤；
- 未把任何 API Key、Worker Secret、真实地址、私密频道信息提交进 Git。
