-- 0010：多免费频道白名单 code 列
-- P1-#7：public 类型内容的免费频道，只能从白名单 freeChannelCode 枚举选，不再允许手写 channelId
ALTER TABLE "contents"
  ADD COLUMN "free_channel_code" VARCHAR(64);

CREATE INDEX "idx_contents_free_channel_code"
  ON "contents" ("free_channel_code");

-- 迁移期：对已有的 access_type='public' 老数据，填默认 'free_preview_main' 避免新校验 immediate 失败
UPDATE "contents"
   SET "free_channel_code" = 'free_preview_main'
 WHERE "access_type" = 'public'
   AND "free_channel_code" IS NULL;
