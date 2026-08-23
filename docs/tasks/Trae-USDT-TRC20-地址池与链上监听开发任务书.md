# InTune · USDT-TRC20 地址池后台与链上监听开发任务书

> 目标：补齐后台“USDT 收款地址”入口，并新增**只读、无私钥**的 TRON 链监听 Worker。用户支付后由 Worker 调用现有内网认单接口，服务端完成订单确认、权益发放与 Telegram VIP 频道交付。

## P0 安全加固：地址池、链上监听与数据库防护

> 以下要求是上线门槛。发现完整性异常时，系统必须停止自动确认并告警，不能继续给用户发权益。

### A. 收款地址池：不可篡改、不可静默改写

1. **地址永不原地修改**：已创建地址不提供 edit/update 地址接口；需要变更时，只能“停用旧地址 → 新建新地址”。禁止 hard delete。
2. **双人复核**：财务角色只能提交新增/停用申请（`pending_approval`）；不同账号的 `super_admin` 才能批准为 `active`。同一管理员不可申请并批准。
3. **冷却期**：新增地址批准后至少 10 分钟才可用于新订单；停用或强制取消有活跃订单的地址必须二次确认、写明原因。
4. **不可伪造完整性签名**：每个地址行保存 `integrity_mac`，由服务器环境变量/KMS 中独立的 `PAYMENT_ADDRESS_INTEGRITY_KEY` 对以下规范化字段 HMAC-SHA256：

   ```text
   addressId | network | normalizedAddress | createdAt | createdBy | lifecycleVersion
   ```

   读取、分配、停用前都校验 MAC；不匹配立即冻结该地址、停止自动入账、写安全事件 `payment_address_integrity_failed` 并触发告警。密钥绝不存数据库、日志、审计或前端。
5. **变更链**：`payment_address_change_events` 只追加不更新，保存前一事件哈希与本事件哈希，形成 hash chain；每日把地址池快照和最后事件哈希推送到独立加密备份存储。数据库被单独篡改时可被对账发现。
6. **展示最小化**：列表始终脱敏；完整地址仅 `super_admin` 临时 reveal，必须记录原因、审计和短时展示。地址本身不是私钥，但属于资金流关键数据，不得出现在普通日志或接口批量响应中。

### B. 收款确认：链上事实唯一可信

1. 用户提交的 txid、截图、金额、时间都只能作为客服线索，**不能**触发自动到账。
2. Worker 只接受 TronGrid（或已审批备用 RPC）的链上数据，且必须同时满足：
   - `network === tron_trc20`；
   - USDT 合约等于服务端白名单；
   - `toAddress` 属于完整性校验通过、状态为 `assigned` 的地址；
   - 链上金额精确等于订单 `expectedAmountMinor`（含唯一尾数）；
   - 达到确认阈值；
   - `txHash + logIndex` 未处理过。
3. **同一地址、同一时间窗口不是充分匹配条件**；唯一尾数仅用于辅助区分，最终必须以“订单分配地址 + 精确金额 + 合约 + 已确认交易”四项匹配。
4. Worker 只有链上读取权限，**不保存 TRON 私钥/助记词，也不拥有任何转出、归集或提现能力**。
5. Worker 到 API 的内部回调仅走 `127.0.0.1` 或私有网络，使用独立 HMAC `USDT_WORKER_SECRET`；Caddy 和公网不得暴露 `/internal/usdt/*`。
6. 每笔链上事件必须先幂等落库，再在短事务内更新订单/交易/权益；网络调用和数据库事务严格分离。

### C. 注入与数据库防护

1. 所有外部输入使用 Zod `.strict()` 白名单校验；地址、订单号、txHash、分页、排序字段均限制格式和长度。
2. 禁止 `queryRawUnsafe`、字符串拼接 SQL、动态字段名/动态排序直接透传。所有 Prisma 查询使用参数化 API；确需原生 SQL 时只可使用带参数的 `$queryRaw`，并新增针对该查询的安全测试。
3. 数据库不对公网开放 5432；应用和 Worker 使用不同最小权限数据库账户。Migration 和备份使用独立账号。
4. 生产连接启用 TLS；`DATABASE_URL`、TronGrid Key、HMAC Key 只在服务器/KMS 存放。备份加密，恢复演练至少每月一次。
5. 任何数据库异常只记录结构化错误类别与指纹，禁止输出 SQL、连接串、表名、收款地址、交易哈希原文或用户资料。

### D. 监控、冻结与对账

| 事件 | 阈值/动作 |
|---|---|
| 地址完整性 MAC / 变更链校验失败 | 立即冻结自动确认，P0 告警 |
| 新地址批准、地址停用、强制取消活跃订单 | 即时通知 + 审计 1:1 对账 |
| 可用地址少于安全水位 | 告警但不复用尾数 |
| TronGrid 401/403/429、连续失败、监听滞后 | 告警；滞后超阈值暂停“已确认”判定 |
| 链上到账无法匹配订单 / 金额不符 / 错合约 | 隔离到人工对账队列，绝不自动发权益 |
| 同 txHash/logIndex 重复投递 | 记录幂等命中，不重复付款或发权益 |

每日任务：以链上已确认 USDT 转入记录、数据库交易表、订单状态、权益发放记录做四方对账；差异自动生成不可修改报告，需财务与超管共同关闭。

### E. 必须新增的安全测试

1. 尝试更新已激活地址正文 → 405/409；地址新建必须经不同管理员批准才能分配。
2. 篡改 `normalizedAddress`、`network`、`createdAt` 或 `integrity_mac` 任一字段 → 分配/监听冻结、0 权益发放、告警记录。
3. 伪造前端 chain-event、错误 HMAC、外网访问 internal 路径 → 401/403。
4. SQL 注入字符串、超长 txHash、异常分页/排序字段 → 400，日志无原文。
5. 相同地址/金额但错误 USDT 合约、未达到确认数、重复 txHash/logIndex → 不发权益。
6. Provider 429/超时、数据库临时错误、Worker 重启中断 → 游标和幂等状态可恢复，订单不会重复确认。
7. 全量测试、静态 `rg "queryRawUnsafe|$executeRawUnsafe" server` 为零命中（允许白名单注释豁免须安全评审）。

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
