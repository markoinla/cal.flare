-- Additive migration for better-auth compatibility.
-- All columns are nullable / default-backfilled so this is safe to deploy ahead of the auth cutover.
-- Existing next-auth writes continue to work because no columns are dropped or renamed.

-- AlterTable: Account
ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "accessTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refreshTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: Session
-- better-auth writes its session identifier to Session.token; the existing
-- "sessionToken" column is unused (pre-migration config uses JWT strategy)
-- so we leave it in place rather than renaming.
ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "token" TEXT,
  ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "Session_token_key" ON "Session"("token");
CREATE INDEX IF NOT EXISTS "Session_token_idx" ON "Session"("token");

-- AlterTable: User
-- better-auth's core schema expects a Boolean emailVerified + updatedAt.
-- Cal's existing User.emailVerified is DateTime?; we leave it untouched and give
-- better-auth its own Boolean column to write to. The two are kept in sync by
-- the calcom-session plugin (reads DateTime, exposes Boolean on session.user).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "emailVerifiedBool" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill the Boolean from the existing DateTime column so historical users
-- (who have emailVerified set) are also marked verified on the better-auth side.
UPDATE "users" SET "emailVerifiedBool" = true WHERE "emailVerified" IS NOT NULL;
