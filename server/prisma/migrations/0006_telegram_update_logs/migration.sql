-- 0006_telegram_update_logs
-- Sprint 3 Phase 0: Telegram update_id 处理状态机（细节4 锁定）
-- 目标：在同一事务内记录 processing → processed / failed，
--       失败可安全重试，不出现"先记录后处理 → 中间失败造成数据丢失"的漏洞。
--       同时日志中仅保留 HMAC 指纹，不存明文 chatId / inviteLink。

CREATE TYPE "TelegramUpdateProcessStatus" AS ENUM (
  'pending',
  'processing',
  'processed',
  'failed'
);

CREATE TABLE IF NOT EXISTS "telegram_update_logs" (
  "id"           TEXT                        NOT NULL,
  "update_id"    BIGINT                      NOT NULL,
  "bot_key"      VARCHAR(64)                 NOT NULL DEFAULT 'default',
  "status"       "TelegramUpdateProcessStatus" NOT NULL DEFAULT 'pending',
  "event_type"   VARCHAR(32),
  "chat_id_hmac" VARCHAR(64),
  "chat_id_masked" VARCHAR(32),
  "error_class"  VARCHAR(64),
  "started_at"   TIMESTAMPTZ,
  "ended_at"     TIMESTAMPTZ,
  "created_at"   TIMESTAMPTZ                 NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ                 NOT NULL,

  PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "telegram_update_logs_status_created_at_idx"
  ON "telegram_update_logs" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "telegram_update_logs_bot_key_created_at_idx"
  ON "telegram_update_logs" ("bot_key", "created_at");

-- (update_id, bot_key) 组合唯一：同一条 update 同一个 botKey 下只允许一条记录，
--  不同 botKey 允许分别处理（例如主 Bot 和 收费 Bot 分开配置）。
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_update_logs_update_id_bot_key_key"
  ON "telegram_update_logs" ("update_id", "bot_key");
