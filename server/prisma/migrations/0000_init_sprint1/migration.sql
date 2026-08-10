-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'frozen', 'deleted');

-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('public', 'single', 'package', 'membership');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('draft', 'pending_review', 'scheduled', 'published', 'offline', 'archived');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('single', 'package', 'membership');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('draft', 'published', 'offline');

-- CreateEnum
CREATE TYPE "CategoryStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "BannerStatus" AS ENUM ('draft', 'scheduled', 'active', 'inactive');

-- CreateEnum
CREATE TYPE "BannerTargetType" AS ENUM ('content', 'package', 'category', 'external');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'processing', 'paid', 'failed', 'refunded', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('content', 'package', 'membership_channel');

-- CreateEnum
CREATE TYPE "EntitlementStatus" AS ENUM ('active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('super_admin', 'operator', 'customer_service', 'finance', 'auditor', 'editor');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "username" TEXT,
    "display_name" TEXT NOT NULL,
    "photo_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "icon_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "CategoryStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banners" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "action_label" TEXT NOT NULL DEFAULT '鏌ョ湅',
    "slot" VARCHAR(32) NOT NULL DEFAULT 'home_top',
    "target_type" "BannerTargetType" NOT NULL,
    "target_id" TEXT,
    "external_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "status" "BannerStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "category_id" TEXT,

    CONSTRAINT "banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_packages" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "cover_url" TEXT,
    "channel_id" BIGINT,
    "product_id" TEXT,
    "status" "PackageStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "type" "ProductType" NOT NULL,
    "title" TEXT NOT NULL,
    "price_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XTR',
    "duration_days" INTEGER,
    "status" "ProductStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contents" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "cover_url" TEXT,
    "thumbnail_url" TEXT,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preview_url" TEXT,
    "duration_seconds" INTEGER,
    "access_type" "AccessType" NOT NULL DEFAULT 'single',
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "is_recommended" BOOLEAN NOT NULL DEFAULT false,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "is_new_arrival" BOOLEAN NOT NULL DEFAULT false,
    "featured_sort" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "recommend_starts_at" TIMESTAMP(3),
    "recommend_ends_at" TIMESTAMP(3),
    "scheduled_at" TIMESTAMP(3),
    "channel_id" BIGINT,
    "package_id" TEXT,
    "product_id" TEXT,
    "published_at" TIMESTAMP(3),
    "last_editor_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_categories" (
    "content_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_categories_pkey" PRIMARY KEY ("content_id","category_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XTR',
    "payment_provider" TEXT NOT NULL DEFAULT 'telegram_stars',
    "provider_order_id" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlements" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "resource_type" "ResourceType" NOT NULL,
    "resource_id" TEXT NOT NULL,
    "source_order_id" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "status" "EntitlementStatus" NOT NULL DEFAULT 'active',
    "notify_3d_at" TIMESTAMP(3),
    "notify_expired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_invites" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "entitlement_id" TEXT,
    "channel_id" BIGINT NOT NULL,
    "invite_link" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'operator',
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT,
    "before_value" JSONB,
    "after_value" JSONB,
    "reason" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users"("telegram_user_id");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_status_sort_order_idx" ON "categories"("status", "sort_order");

-- CreateIndex
CREATE INDEX "banners_status_slot_sort_order_idx" ON "banners"("status", "slot", "sort_order");

-- CreateIndex
CREATE INDEX "banners_starts_at_ends_at_idx" ON "banners"("starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "content_packages_product_id_key" ON "content_packages"("product_id");

-- CreateIndex
CREATE INDEX "content_packages_status_idx" ON "content_packages"("status");

-- CreateIndex
CREATE INDEX "products_status_type_idx" ON "products"("status", "type");

-- CreateIndex
CREATE INDEX "contents_status_access_type_idx" ON "contents"("status", "access_type");

-- CreateIndex
CREATE INDEX "contents_is_featured_featured_sort_idx" ON "contents"("is_featured", "featured_sort");

-- CreateIndex
CREATE INDEX "contents_is_recommended_recommend_starts_at_recommend_ends__idx" ON "contents"("is_recommended", "recommend_starts_at", "recommend_ends_at");

-- CreateIndex
CREATE INDEX "contents_sort_order_idx" ON "contents"("sort_order");

-- CreateIndex
CREATE INDEX "contents_package_id_idx" ON "contents"("package_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_no_key" ON "orders"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "orders_provider_order_id_key" ON "orders"("provider_order_id");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "entitlements_user_id_status_idx" ON "entitlements"("user_id", "status");

-- CreateIndex
CREATE INDEX "entitlements_resource_type_resource_id_idx" ON "entitlements"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "entitlements_expires_at_status_idx" ON "entitlements"("expires_at", "status");

-- CreateIndex
CREATE INDEX "entitlements_notify_3d_at_expires_at_status_idx" ON "entitlements"("notify_3d_at", "expires_at", "status");

-- CreateIndex
CREATE INDEX "entitlements_notify_expired_at_expires_at_status_idx" ON "entitlements"("notify_expired_at", "expires_at", "status");

-- CreateIndex
CREATE INDEX "telegram_invites_entitlement_id_idx" ON "telegram_invites"("entitlement_id");

-- CreateIndex
CREATE INDEX "telegram_invites_expires_at_idx" ON "telegram_invites"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_id_created_at_idx" ON "admin_audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_object_type_created_at_idx" ON "admin_audit_logs"("action", "object_type", "created_at");

-- AddForeignKey
ALTER TABLE "banners" ADD CONSTRAINT "banners_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_packages" ADD CONSTRAINT "content_packages_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "content_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_last_editor_id_fkey" FOREIGN KEY ("last_editor_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_categories" ADD CONSTRAINT "content_categories_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_categories" ADD CONSTRAINT "content_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_source_order_id_fkey" FOREIGN KEY ("source_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_invites" ADD CONSTRAINT "telegram_invites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_invites" ADD CONSTRAINT "telegram_invites_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "entitlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

