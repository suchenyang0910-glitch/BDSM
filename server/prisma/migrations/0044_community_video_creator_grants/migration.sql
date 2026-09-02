CREATE TABLE "community_video_creator_grants" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "reason" VARCHAR(500),
  "granted_by_admin_id" TEXT,
  "revoked_by_admin_id" TEXT,
  "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "community_video_creator_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "community_video_creator_grants_user_id_key"
  ON "community_video_creator_grants"("user_id");

CREATE INDEX "community_video_creator_grants_active_granted_at_idx"
  ON "community_video_creator_grants"("active", "granted_at" DESC);

ALTER TABLE "community_video_creator_grants"
  ADD CONSTRAINT "community_video_creator_grants_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_video_creator_grants"
  ADD CONSTRAINT "community_video_creator_grants_granted_by_admin_id_fkey"
  FOREIGN KEY ("granted_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "community_video_creator_grants"
  ADD CONSTRAINT "community_video_creator_grants_revoked_by_admin_id_fkey"
  FOREIGN KEY ("revoked_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
