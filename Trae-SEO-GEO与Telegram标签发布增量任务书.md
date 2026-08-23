# InTune · SEO / GEO 与 Telegram 标签发布增量任务书

> 优先级：P1（不阻断已存在的内容、支付和频道发布链路）
> 目标：平台可以维护默认 SEO / GEO；每条视频可覆盖默认值；发布到 Telegram 时自动追加规范化标签。

## 1. 业务规则（不可变）

### 1.1 配置继承

| 范围 | 字段 | 生效规则 |
|---|---|---|
| 平台默认 | SEO 标题、SEO 描述、SEO 关键词、GEO 关键词 | 全站默认值 |
| 单条视频 | 同一组字段 | 非空即覆盖平台默认；空值则继承平台默认 |
| Telegram 标签 | 视频标签 `tags` + 可选发布标签 | 发布时合并、去重、规范化；不使用 SEO/GEO 关键词自动生成公开频道标签 |

`GEO` 在本需求中指面向生成式搜索/答案引擎的主题关键词与实体短语，不表示用户地理位置；不得收集、推断或展示用户定位数据。

### 1.2 前台使用方式

- 公共 HTML 页面：输出 `<title>`、`meta[name=description]`、`meta[name=keywords]`、Open Graph 标题/描述/封面，以及 `VideoObject` JSON-LD。
- Mini App：不依赖 SEO 抓取，但应从同一内容接口取得 `effectiveSeo`，供分享卡片、详情标题和后续 H5 共用。
- 单条视频没有配置时，接口必须明确返回平台默认值的合成结果，不让前端各自重复合并逻辑。

### 1.3 Telegram 发布标签规则

1. 运营在内容编辑页填写普通标签，例如：`束缚技巧, 新手, 关系沟通`；前端不要求手工加 `#`。
2. 服务端生成 Telegram 标签，例如：`#束缚技巧 #新手 #关系沟通`，再放到 caption 的最后一行。
3. 允许中英文、数字、下划线；清除 `#`、空格、标点和不可见字符。空结果丢弃。
4. 单个标签最大 32 个字符，单次最多 10 个，大小写无关去重；保留内容原有顺序。
5. 只允许 `tags` 与本次发布的 `telegramTags` 合并；**不得自动把 SEO/GEO 关键词、频道 ID、订单号、用户信息变为公开 Telegram 标签。**
6. caption 仍必须满足 Telegram 上限（视频 caption 最大 1024 字符）。预留标签行空间：文案超长时先截断正文，再写标签；标签不能被截断成半个。
7. 全部标签仅由服务端生成；后台预览可显示最终效果，但不可把未规范化值直接发送给 Telegram。

示例：

```text
《边界与信任》
本期试看内容……

点击进入 Mini App：同频 Mini App
#边界沟通 #新手 #关系信任
```

## 2. 数据模型与迁移

新建独立迁移，建议编号接在当前最新迁移之后；不得修改已部署迁移。

### 2.1 `platform_metadata`（单行设置）

```prisma
model PlatformMetadata {
  id              String   @id @default("default")
  seoTitle        String?  @map("seo_title") @db.VarChar(120)
  seoDescription  String?  @map("seo_description") @db.VarChar(300)
  seoKeywords     String[] @default([]) @map("seo_keywords")
  geoKeywords     String[] @default([]) @map("geo_keywords")
  updatedAt       DateTime @updatedAt @map("updated_at")
  updatedBy       String?  @map("updated_by")

  @@map("platform_metadata")
}
```

### 2.2 `contents` 新增可空覆盖字段

```prisma
seoTitle        String?  @map("seo_title") @db.VarChar(120)
seoDescription  String?  @map("seo_description") @db.VarChar(300)
seoKeywords     String[] @default([]) @map("seo_keywords")
geoKeywords     String[] @default([]) @map("geo_keywords")
```

说明：空数组视为“未覆盖”，由后端继承平台默认；不要使用 `null` 与 `[]` 表达两种不同的产品语义。编辑接口保存空数组时应删除视频级覆盖（恢复继承）。

## 3. 后端接口与权限

### 3.1 平台设置

| 接口 | 权限 | 作用 |
|---|---|---|
| `GET /api/admin/platform-metadata` | `settings:view` | 读取平台默认 SEO/GEO |
| `PUT /api/admin/platform-metadata` | `settings:manage` 或 `super_admin` | 更新默认值并写审计 `platform_metadata.update` |

请求体：

```json
{
  "seoTitle": "同频 InTune",
  "seoDescription": "…",
  "seoKeywords": ["成人兴趣社区", "边界", "尊重"],
  "geoKeywords": ["共识沟通", "关系教育"]
}
```

服务端校验：标题 120、描述 300；每组最多 20 个关键词，每个 40 字符。存储、审计和日志不得包含 Telegram 私密邀请链接、频道 ID、钱包地址或用户身份资料。

### 3.2 内容接口

- 扩展内容创建/编辑 DTO，支持 `seoTitle`、`seoDescription`、`seoKeywords`、`geoKeywords`。
- `GET /api/contents/:id` 与首页内容卡片按需返回：

```ts
effectiveSeo: {
  title: string | null;
  description: string | null;
  keywords: string[];
  geoKeywords: string[];
  source: { title: "content" | "platform" | "none"; /* 其余字段同理 */ };
}
```

- 一律由服务端合成 `effectiveSeo`；公开接口仅返回公开内容已有的数据。

### 3.3 Telegram 发布任务

- 扩展 `POST /api/admin/contents/:id/start-telegram-publish`：可选 `telegramTags: string[]`，最大 10 项；缺省为 `[]`。
- 将原始 `telegramTags` 保存到 `telegram_publish_jobs` 的 JSON 字段或单独关联表，便于重试时生成完全相同的 caption；不要只存已拼接 caption。
- `buildPreviewVideoCaption()` 改为统一调用 `buildTelegramHashtags()`；会员主频道和内容包频道的完整视频也使用同一标签逻辑（若该类频道定义不显示文案，则明确保留空 caption，而不是绕过验证）。
- 重试任务必须复用首次入队时保存的规范化标签，不得因平台默认关键词更新而改变历史发布文案。

## 4. 后台 UI

### 4.1 新入口：系统设置 → SEO 与 GEO

- **首期必须预留并上线此入口**，菜单名称固定为「平台 SEO / GEO」；即使 H5 仍处于 `noindex` 阶段，运营也可以先维护全站默认元数据，供后续开启收录、分享卡片及内容继承直接使用。
- 表单分为「搜索展示」和「生成式搜索主题」两组。
- 关键词用可编辑 Tag 输入；实时显示数量与字符上限。
- 给出提示：“视频未填写时继承这里的默认值”。
- 保存前二次确认，保存后显示生效时间；无权限仅可只读。

### 4.2 内容编辑抽屉

新增「SEO / GEO（可选，未填则继承平台）」折叠区：

- SEO 标题、SEO 描述、SEO 关键词、GEO 关键词。
- 显示当前继承预览和“恢复平台默认”按钮。
- 标签字段继续是内容标签；不要把 SEO/GEO 字段混入内容标签。

### 4.3 发布进度页

- 在发布确认步骤新增“Telegram 标签”输入，支持粘贴 `#标签1 #标签2` 或普通词；前端只做预校验。
- 显示“最终发送预览”，标签以服务端响应的 `normalizedTelegramTags` 为准。
- 不展示私密频道 ID、邀请链接、Bot Token。

## 5. 前台 H5 / Mini App

- H5 内容详情按 `effectiveSeo` 设置 title/meta/OG；使用封面和预览视频生成 `VideoObject`。
- 默认 `robots` 为 `noindex, nofollow`，直到运营确认内容许可、成年人准入、投诉下架与地区策略完成后才允许平台级改为可索引。Telegram Mini App 保持不依赖搜索收录。
- 内容不存在、未发布、用户无访问权时不得输出内容的 SEO、GEO、频道或视频信息。

## 6. 测试与验收（必须）

1. 视频未填：内容接口 `effectiveSeo` 等于平台默认。
2. 视频仅填其中 1 个字段：只覆盖该字段，其余仍继承默认。
3. 平台更新后：未覆盖的视频实时取得新默认；已覆盖的视频不变化。
4. 标签输入 `#边界 沟通, #New_User #new_user`：结果为 `#边界 #沟通 #New_User`（按最终规范大小写策略断言）。
5. 超长正文 + 10 标签：caption 不超过 1024，所有标签完整保留。
6. 任务重试：caption 与初次发布一致。
7. 无 `settings:manage` 权限访问/更新平台设置均为 403；每次成功更新恰好 1 条审计。
8. 在公开接口、日志和审计字段中扫描：不得出现 Bot Token、完整私密邀请链接、频道 ID、钱包地址。
9. 管理后台 `npm run build`、服务端 `tsc --noEmit`、全量测试必须通过。

## 7. 实施顺序

1. Prisma schema + 迁移 + 平台设置服务/权限/审计；
2. 内容 DTO/查询 `effectiveSeo`；
3. Telegram 标签规范化函数、队列持久化、caption 生成与测试；
4. 后台平台设置页、内容编辑区、发布预览；
5. H5 meta/OG/JSON-LD（默认 noindex）；
6. 完整回归、迁移 dry-run 与部署说明。
