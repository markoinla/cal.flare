import type { User as PrismaUser } from "@calcom/prisma/client";
import type { MembershipRole } from "@calcom/prisma/enums";
import type { UserProfile } from "@calcom/types/UserProfile";

export interface SessionUser {
  id: PrismaUser["id"];
  uuid?: PrismaUser["uuid"];
  email: string;
  name?: string | null;
  image?: string | null;
  emailVerified?: PrismaUser["emailVerified"];
  email_verified?: boolean;
  completedOnboarding?: boolean;
  impersonatedBy?: {
    id: number;
    uuid: string;
    role: PrismaUser["role"];
  };
  belongsToActiveTeam?: boolean;
  org?: {
    id: number;
    name?: string;
    slug: string;
    logoUrl?: string | null;
    fullDomain: string;
    domainSuffix: string;
    role: MembershipRole;
  };
  username?: PrismaUser["username"];
  orgAwareUsername?: PrismaUser["username"];
  avatarUrl?: PrismaUser["avatarUrl"];
  role?: PrismaUser["role"] | "INACTIVE_ADMIN";
  /** Set when role is INACTIVE_ADMIN: why admin security requirements are not met */
  inactiveAdminReason?: "both" | "password" | "2fa";
  locale?: string | null;
  profile?: UserProfile;
  samlTenant?: string;
}

/**
 * Shape returned by `auth.api.getSession` and `authClient.useSession()`.
 * Kept structurally compatible with the pre-migration next-auth Session so existing
 * consumers compile without per-file edits.
 */
export interface Session {
  hasValidLicense: boolean;
  profileId?: number | null;
  upId: string;
  user: SessionUser & { uuid: PrismaUser["uuid"] };
  /** better-auth session metadata — not present on the legacy next-auth Session. */
  expires: string;
}
