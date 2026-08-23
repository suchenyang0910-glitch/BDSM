-- 迁移 0009：ContentPackage / Content channelId 加密存库（AES-256-GCM + HMAC 索引）
-- 迁移期策略：保留 BigInt 明文库列 channel_id 作为 deprecated 回读列；
--           新增 channel_id_ciphertext (AES-GCM base64) + channel_id_hmac (SHA-256 HEX 64)
--           两列唯一约束：防止 HMAC 碰撞导致同一频道重复配置
--
-- 【数据回填说明】：
--   若已有 channel_id 非空的历史数据，直接跑部署脚本不会自动加密回填；
--   生产使用前必须运行 `npx tsx prisma/seed-channels-encrypt.ts`
--   （或在 pgAdmin 手动执行加密回填，密钥来自 CRYPTO_CHAT_ID_AES_KEY / CRYPTO_HMAC_SECRET）
--   回填前先备份表；代码层在过渡期同时接受「新加密列优先 + 旧明文列 fallback」。

ALTER TABLE "content_packages"
  ADD COLUMN IF NOT EXISTS "channel_id_ciphertext" TEXT;
ALTER TABLE "content_packages"
  ADD COLUMN IF NOT EXISTS "channel_id_hmac" VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cp_channel_hmac"
  ON "content_packages"("channel_id_hmac")
  WHERE "channel_id_hmac" IS NOT NULL;

ALTER TABLE "contents"
  ADD COLUMN IF NOT EXISTS "channel_id_ciphertext" TEXT;
ALTER TABLE "contents"
  ADD COLUMN IF NOT EXISTS "channel_id_hmac" VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_content_channel_hmac"
  ON "contents"("channel_id_hmac")
  WHERE "channel_id_hmac" IS NOT NULL;
