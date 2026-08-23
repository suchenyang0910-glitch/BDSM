CREATE TABLE "telegram_channel_messages" (
  "id" TEXT NOT NULL,
  "managed_channel_id" TEXT NOT NULL,
  "message_id" BIGINT NOT NULL,
  "media_kind" VARCHAR(32) NOT NULL,
  "telegram_file_id_cipher" TEXT,
  "preview_file_id_cipher" TEXT,
  "caption_fingerprint" VARCHAR(64),
  "posted_at" TIMESTAMPTZ NOT NULL,
  "association_status" VARCHAR(32) NOT NULL DEFAULT 'unlinked',
  "content_id" TEXT,
  "linked_at" TIMESTAMPTZ,
  "linked_by" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_channel_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_channel_messages_content_id_key"
  ON "telegram_channel_messages"("content_id");

CREATE UNIQUE INDEX "telegram_channel_messages_managed_channel_id_message_id_key"
  ON "telegram_channel_messages"("managed_channel_id", "message_id");

CREATE INDEX "telegram_channel_messages_managed_channel_id_association_status_posted_at_idx"
  ON "telegram_channel_messages"("managed_channel_id", "association_status", "posted_at" DESC);

CREATE INDEX "telegram_channel_messages_association_status_posted_at_idx"
  ON "telegram_channel_messages"("association_status", "posted_at" DESC);

ALTER TABLE "telegram_channel_messages"
  ADD CONSTRAINT "telegram_channel_messages_managed_channel_id_fkey"
  FOREIGN KEY ("managed_channel_id") REFERENCES "admin_managed_channels"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "telegram_channel_messages"
  ADD CONSTRAINT "telegram_channel_messages_content_id_fkey"
  FOREIGN KEY ("content_id") REFERENCES "contents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "telegram_channel_messages"
  ADD CONSTRAINT "telegram_channel_messages_linked_by_fkey"
  FOREIGN KEY ("linked_by") REFERENCES "admin_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
