-- ===== Sprint 2: 客服工单 + 事件流 =====

-- TicketStatus: open / in_progress / resolved / closed
CREATE TYPE "TicketStatus" AS ENUM ('open', 'in_progress', 'resolved', 'closed');

-- TicketPriority: low / normal / high / urgent
CREATE TYPE "TicketPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- TicketCategory: payment / entitlement / access / refund / other
CREATE TYPE "TicketCategory" AS ENUM ('payment', 'entitlement', 'access', 'refund', 'other');

-- TicketEventType: 8 类事件流
CREATE TYPE "TicketEventType" AS ENUM ('created', 'assigned', 'note_internal', 'note_public', 'status_changed', 'resolved', 'closed', 'action_taken');

-- 工单主表
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "ticket_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'normal',
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "description" TEXT,
    "telegram_user_id" BIGINT,
    "order_id" TEXT,
    "entitlement_id" TEXT,
    "assigned_to_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- 工单事件流（每条操作/备注一条，构建时间线）
CREATE TABLE "ticket_events" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "type" "TicketEventType" NOT NULL,
    "author_type" TEXT NOT NULL,
    "author_user_id" TEXT,
    "author_admin_id" TEXT,
    "note" TEXT,
    "action_ref" TEXT,
    "old_status" "TicketStatus",
    "new_status" "TicketStatus",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- 工单唯一 ticket_no 索引
CREATE UNIQUE INDEX "support_tickets_ticket_no_key" ON "support_tickets"("ticket_no");

-- 工单多条件查询索引
CREATE INDEX "support_tickets_user_id_status_idx" ON "support_tickets"("user_id", "status");
CREATE INDEX "support_tickets_status_priority_created_at_idx" ON "support_tickets"("status", "priority", "created_at");
CREATE INDEX "support_tickets_assigned_to_id_status_idx" ON "support_tickets"("assigned_to_id", "status");
CREATE INDEX "support_tickets_order_id_idx" ON "support_tickets"("order_id");
CREATE INDEX "support_tickets_entitlement_id_idx" ON "support_tickets"("entitlement_id");
CREATE INDEX "support_tickets_telegram_user_id_idx" ON "support_tickets"("telegram_user_id");

-- 事件流查询索引
CREATE INDEX "ticket_events_ticket_id_created_at_idx" ON "ticket_events"("ticket_id", "created_at");
CREATE INDEX "ticket_events_author_admin_id_idx" ON "ticket_events"("author_admin_id");
CREATE INDEX "ticket_events_author_user_id_idx" ON "ticket_events"("author_user_id");

-- 工单外键
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_entitlement_id_fkey"
    FOREIGN KEY ("entitlement_id") REFERENCES "entitlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_to_id_fkey"
    FOREIGN KEY ("assigned_to_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 事件流外键
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_author_admin_id_fkey"
    FOREIGN KEY ("author_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;