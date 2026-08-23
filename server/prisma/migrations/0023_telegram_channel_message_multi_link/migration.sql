-- 同一内容可同时有免费试看消息与私密完整版消息。
-- 旧唯一索引会使第二条发布消息在事务提交时 P2002，导致任务错误重试。
DROP INDEX IF EXISTS "telegram_channel_messages_content_id_key";

CREATE INDEX IF NOT EXISTS "telegram_channel_messages_content_id_idx"
  ON "telegram_channel_messages"("content_id");
