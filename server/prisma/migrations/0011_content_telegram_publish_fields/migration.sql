-- 0011：Content 发布到 Telegram 频道的审计字段
-- P1-#5：后台 sendVideo 后写回 messageId、发送时间、目标频道指纹（注意：明文 chatId 绝不写表）
ALTER TABLE "contents"
  ADD COLUMN "telegram_message_id" BIGINT;

ALTER TABLE "contents"
  ADD COLUMN "telegram_sent_at" TIMESTAMPTZ;

-- 指纹：chatIdFingerprint（来自 utils/crypto.ts 的 chatIdIndexKey，HMAC 不可逆），用于审计对账/不暴露明文
ALTER TABLE "contents"
  ADD COLUMN "telegram_chat_fingerprint" VARCHAR(128);

CREATE INDEX "idx_contents_telegram_message_id"
  ON "contents" ("telegram_message_id")
  WHERE "telegram_message_id" IS NOT NULL;
