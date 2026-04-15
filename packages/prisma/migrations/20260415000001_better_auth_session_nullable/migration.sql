-- Relax Session schema so better-auth can INSERT without providing legacy next-auth columns.
-- This is safe because the legacy next-auth configuration uses JWT strategy and never wrote to these columns.

ALTER TABLE "Session" ALTER COLUMN "sessionToken" DROP NOT NULL;
ALTER TABLE "Session" ALTER COLUMN "expires" DROP NOT NULL;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
