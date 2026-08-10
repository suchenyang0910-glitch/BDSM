-- InTune Sprint 2 extension: managed channels (0005)
-- AdminManagedChannel: stores all Telegram channels/groups the Bot participates in
-- (auto_scan from getUpdates OR manual_added by super_admin).
-- Enums for AdminManagedChatSource are handled via Prisma schema native enum.

CREATE TYPE "AdminManagedChatSource" AS ENUM ('auto_scan', 'manual_add');

CREATE TABLE "admin_managed_channels" (
    chat_id BIGINT NOT NULL PRIMARY KEY,
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

CREATE INDEX idx_amc_source
    ON "admin_managed_channels" (source);

CREATE INDEX idx_amc_chat_type
    ON "admin_managed_channels" (chat_type);

CREATE INDEX idx_amc_refreshed_at
    ON "admin_managed_channels" (refreshed_at);
