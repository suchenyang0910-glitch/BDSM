-- Migration 0013: H5 匿名访客身份体系设备会话表 + 用户合并标记
-- 创建日期：2026-08-23
-- 说明：
--   1. users 表新增 merged_into_user_id（FK -> users.id），标记匿名访客已合并到 Telegram 身份
--   2. 新建 h5_device_sessions 表：存 64hex SHA256(Token) 作为 PK，关联 User，30 天有效期，lastUsedAt 用于过期清理
--   3. 所有 FK 均用 onDelete 安全策略；device session 删除不影响用户数据（Cascade 仅清理用户级 orphans）
--   4. 【未部署红线】本 migration 未在生产 DB 执行；必须先 DB 备份 + 0009~0012 顺序执行 + dry-run 回填后再运行本迁移

ALTER TABLE "users"
  ADD COLUMN "merged_into_user_id" TEXT;

ALTER TABLE "users"
  ADD CONSTRAINT "users_merged_into_user_id_fkey"
    FOREIGN KEY ("merged_into_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX "idx_users_merged_into_user_id"
  ON "users"("merged_into_user_id");

CREATE TABLE "h5_device_sessions" (
  "token_hash" VARCHAR(64) NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "last_used_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_ip" VARCHAR(45),
  "user_agent" VARCHAR(512),
  CONSTRAINT "h5_device_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX "idx_h5_device_sessions_user_id"
  ON "h5_device_sessions"("user_id");

CREATE INDEX "idx_h5_device_sessions_last_used_at"
  ON "h5_device_sessions"("last_used_at");

-- 【兼容声明】users.telegram_user_id 在 Prisma schema 中已从 NOT NULL 改为可空（允许 guest 匿名用户
--   telegramUserId=null）。
-- 若旧数据库列上有显式 NOT NULL DDL 约束（取决于历史 migration），需额外：
--   ALTER TABLE "users" ALTER COLUMN "telegram_user_id" DROP NOT NULL;
-- 本迁移显式判断后执行：
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'users'
       AND column_name = 'telegram_user_id'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "users" ALTER COLUMN "telegram_user_id" DROP NOT NULL;
  END IF;
END $$;
