# InTune · 私密频道视频关联与完整视频限制任务书

> 优先级：P0（阶段一 Telegram 交付的内容运营闭环）

## 1. 必须落实的限制

### 完整视频限制

- `public` 内容**禁止**上传、选择、保存或发布 `fullVideoAssetId` / 完整视频。
- 完整视频仅允许 `membership` 或 `package` 内容；`package` 必须已绑定已发布内容包。
- 单个文件最大 **8 GB**；服务端在签发上传、完成上传、创建/编辑内容、创建 Telegram 发布任务四层重复校验。
- `public` 只允许：封面、30–60 秒试看视频、标题、说明、公开频道引流文案。
- 不允许只靠前端禁用；任何绕过请求必须返回 `400 full_video_not_allowed_for_public`。

## 2. 用户问题与正确产品闭环

运营在 Telegram 私密频道手工发出视频后，Mini App 不会自动知道这条消息属于哪条内容卡。必须建立“频道消息 ↔ 内容”关联，而不是让运营复制私密频道链接。

```text
私密频道的视频消息
        ↓ Telegram webhook: channel_post
频道消息收件箱（未关联）
        ↓ 后台选择“关联到内容”
Content.telegramMessageId / 发布记录
        ↓
Mini App 内容卡 + 已购权益
        ↓
POST /api/resources/:contentId/access-link
        ↓
后端 302 到短时、单次私密频道邀请
```

频道 ID、邀请链接、Bot Token、完整文件 ID 均不返回前端。

## 3. 两种发布模式

### A. Bot 代发（首选）

后台“内容编辑 → 频道发布与关联”中选择：

- `public_free_preview`：仅试看视频，自动加 Mini App/H5 链接和 Telegram 标签。
- `membership_full`：仅 membership 内容的完整视频。
- `package_full`：仅 package 内容的完整视频，强制选择该内容关联的内容包频道。

Bot `sendVideo` 成功后，服务端直接获得 `chatId/messageId/fileId`，自动创建已关联发布记录。运营不需要再做一次关联。

### B. 运营手工发频道（必须支持）

1. Bot 必须为目标频道管理员，Webhook 接收 `channel_post`。
2. 每条接收到的视频/图片消息写入 `telegram_channel_messages`，初始 `associationStatus=unlinked`；只保存加密/受控引用，前端只展示频道名称、消息时间、媒体类型、封面缩略图、脱敏消息号。
3. 后台内容页新增独立一级操作：**“频道发布与关联”**，不再隐藏在“手工登记”说明里。
4. 选定内容后，点击 **“从频道消息关联”**：只加载与内容访问类型匹配的未关联消息。
5. 运营选中一条消息后，服务端校验频道用途：
   - public 内容只能关联免费频道的试看消息；
   - membership 内容只能关联会员主频道；
   - package 内容只能关联该 package 的私密频道。
6. 服务端短事务写入关联，标记消息 `linked`；同一消息不可重复关联到不同内容。成功后 Mini App 卡片即时可见该内容状态。

## 4. 数据模型

### `telegram_channel_messages`

```prisma
model TelegramChannelMessage {
  id                    String   @id @default(uuid())
  managedChannelId      String   @map("managed_channel_id")
  messageId             BigInt   @map("message_id")
  mediaKind             String   @map("media_kind") // video | photo | document | text
  telegramFileIdCipher  String?  @map("telegram_file_id_cipher")
  previewFileIdCipher   String?  @map("preview_file_id_cipher")
  captionFingerprint    String?  @map("caption_fingerprint")
  postedAt              DateTime @map("posted_at")
  associationStatus     String   @default("unlinked") @map("association_status")
  contentId             String?  @unique @map("content_id")
  linkedAt              DateTime? @map("linked_at")
  linkedBy              String?  @map("linked_by")
  createdAt             DateTime @default(now()) @map("created_at")

  @@unique([managedChannelId, messageId])
  @@index([managedChannelId, associationStatus, postedAt])
  @@map("telegram_channel_messages")
}
```

注意：`contentId @unique` 确保首期“一条内容对应一条完整交付消息”；若后续一内容多频道发布，改为独立关联表，不要删除历史记录。

## 5. 接口

| 方法 | 路径 | 权限 | 作用 |
|---|---|---|---|
| `GET` | `/api/admin/contents/:id/linkable-channel-messages` | `content:edit` | 仅返回当前内容允许关联的未关联频道消息 |
| `POST` | `/api/admin/contents/:id/link-channel-message` | `content:publish` | 关联 `{ channelMessageId, reason }` |
| `POST` | `/api/admin/contents/:id/unlink-channel-message` | `super_admin` | 解除错误关联，必须审计、二次确认 |
| `GET` | `/api/admin/channel-messages` | `content:view` | 频道消息收件箱；可按用途、状态筛选 |

关联成功返回仅业务字段：`contentId`、`messageKind`、`postedAt`、`channelLabel`、`status`。不得返回私密邀请、完整频道 ID 或 Telegram `file_id`。

## 6. 后台交互

内容编辑抽屉新增 Tab：**频道发布与关联**。

- 顶部显示：`未关联` / `已关联 · 会员主频道 · 发布于 …`。
- 两个主按钮：`由 Bot 发布`、`从频道消息关联`。
- 手工关联弹窗显示最近 30 条可关联消息卡片，支持时间/视频类型筛选；每张卡只有缩略图、时长、文案摘要、发布时间和“选择”。
- 若没有可关联消息，文案明确：`请确认 @InTune_bdsm_bot 是该频道管理员，并在发布视频后等待 Webhook 收到 channel_post。`
- 完整视频上传区在 public 内容中完全隐藏，并展示：`完整视频（public 类型禁止上传，请改用 membership/package）≤ 8GB`。

## 7. Webhook 与审计

- `channel_post` 接收视频消息后写入收件箱，Webhook 幂等键为 `botKey + chatIdHmac + messageId`。
- 不调用 `getUpdates`，继续使用 Webhook 单通道。
- 记录审计：`content.channel_message.link`、`content.channel_message.unlink`、`telegram.channel_message.ingested`；审计仅写 channel 指纹和 messageId，不写频道明文、邀请链接、fileId、caption 原文。

## 8. 验收

1. public 创建/编辑/发布请求携带完整视频均 400。
2. 8 GB+1 byte 在服务端拒绝；8 GB 文件的分片上传、取消、校验可完成。
3. 手工向会员频道发布视频 → webhook 入库 1 条 unlinked 消息 → 后台只可在 membership 内容中选择。
4. 会员频道消息不能关联 public/package 内容；内容包消息只能关联所属 package。
5. 同一频道消息第二次关联返回 409；关联后 Mini App 详情显示可交付状态。
6. Bot 发布后自动生成关联，不出现在未关联收件箱。
7. 任意 API 响应、浏览器 DOM、审计与日志均不包含私密邀请链接、频道完整 ID、Bot Token 或 Telegram fileId。
8. 全量测试、`tsc --noEmit`、后台构建通过；真实 staging 验证“手工发视频 → 关联 → 已购用户 POST 跳转频道”。
