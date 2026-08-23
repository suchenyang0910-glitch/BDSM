DO $$
BEGIN
  ALTER TYPE "BannerTargetType" ADD VALUE IF NOT EXISTS 'membership';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
