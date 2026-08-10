-- 对齐 AdminManagedChannel 表到 schema.prisma（Phase 0-1 锁定的新结构：UUID id + chatIdCiphertextB64 + chatIdHmac 唯一索引）
-- 背景：原 0005 migration 为 sprint2 草稿（chat_id 明文 PK），但 Phase 0-1 升级为 chatIdHmac 索引 + AES-GCM 密文存储。
-- 策略：DROP 老表（小表，staging/生产未上线无真实数据）重建；若需保留真实数据请走手动 ALTER 脚本。

DROP TABLE IF EXISTS "admin_managed_channels" CASCADE;

CREATE TABLE "admin_managed_channels" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  deprecated_chat_id_big BIGINT,
  chat_id_ciphertext_b64 TEXT NOT NULL,
  chat_id_hmac VARCHAR(64) NOT NULL,
  chat_type TEXT NOT NULL,
  title TEXT,
  username TEXT,
  member_count INTEGER,
  avatar_file_id TEXT,
  is_private BOOLEAN NOT NULL DEFAULT TRUE,
  last_event_at TIMESTAMPTZ,
  refreshed_at TIMESTAMPTZ,
  source "AdminManagedChatSource" NOT NULL DEFAULT 'auto_scan',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX admin_managed_channels_chat_id_hmac_key ON "admin_managed_channels"(chat_id_hmac);
CREATE INDEX idx_amc_source ON "admin_managed_channels"(source);
CREATE INDEX idx_amc_chat_type ON "admin_managed_channels"(chat_type);
CREATE INDEX idx_amc_refreshed_at ON "admin_managed_channels"(refreshed_at);
