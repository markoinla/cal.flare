import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { ENABLE_PROFILE_SWITCHER, IS_TEAM_BILLING_ENABLED, WEBAPP_URL } from "@calcom/lib/constants";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import prisma from "@calcom/prisma";
import { MembershipRole, type UserPermissionRole } from "@calcom/prisma/enums";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

import type { SessionUser } from "../types";

const log = logger.getSubLogger({ prefix: ["auth:calcom-session"] });

type BetterAuthUser = { id: number | string; email: string; name?: string | null };
type BetterAuthSession = { id: string; userId: number | string; expiresAt: Date };

type CalcomSessionShape = {
  user: SessionUser;
  session: BetterAuthSession;
  profileId: number | null;
  upId: string;
  hasValidLicense: boolean;
};

/**
 * customSession callback for better-auth.
 *
 * Returns the Cal.diy session shape (org/profile/role/upId/etc.) so the ~185
 * consumer call sites keep working. Unlike the legacy next-auth JWT (which
 * baked this state into the cookie at sign-in), better-auth recomputes on
 * every `auth.api.getSession` call. For hot paths, wrap the getServerSession
 * helper in an LRU cache keyed on the session cookie value.
 *
 * Invariant: this function always returns the same object shape so TypeScript
 * consumers don't see a discriminated union. Unauthenticated / fallback paths
 * return the shape with nulls, not a narrower object.
 */
export const buildCustomSession = async ({
  user,
  session,
}: {
  user: BetterAuthUser;
  session: BetterAuthSession;
}): Promise<CalcomSessionShape> => {
  const userId = typeof user.id === "string" ? Number(user.id) : user.id;
  if (!Number.isFinite(userId)) {
    log.warn("customSession invoked with non-numeric user.id", safeStringify({ id: user.id }));
    return fallbackSession({ user, session, userIdNumber: NaN });
  }

  const userRepo = new UserRepository(prisma);
  const userFromDb = await userRepo.findUnlockedUserForSession({ userId });
  if (!userFromDb) {
    log.debug("customSession: user locked or missing", safeStringify({ userId }));
    return fallbackSession({ user, session, userIdNumber: userId });
  }

  const allProfiles = await ProfileRepository.findAllProfilesForUserIncludingMovedUser(userFromDb);
  const selectedProfile = ENABLE_PROFILE_SWITCHER ? allProfiles[0] : allProfiles[0];
  const upId = selectedProfile?.upId ?? `usr-${userId}`;
  const profileId = selectedProfile?.id ?? null;

  const enrichedUser = await userRepo.enrichUserWithTheProfile({ user: userFromDb, upId });

  const profileOrg = enrichedUser.profile?.organization;
  let orgRole: MembershipRole | undefined;
  if (profileOrg) {
    const membership = await prisma.membership.findUnique({
      where: { userId_teamId: { teamId: profileOrg.id, userId } },
    });
    orgRole = membership?.role;
  }

  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { team: { select: { metadata: true } } },
  });
  const hasActiveTeams = checkIfUserBelongsToActiveTeam({ teams: memberships });
  const orgMetadata = teamMetadataSchema.parse(profileOrg?.metadata || {});

  return {
    user: {
      id: userId,
      uuid: userFromDb.uuid,
      email: userFromDb.email,
      name: userFromDb.name,
      emailVerified: userFromDb.emailVerified,
      completedOnboarding: userFromDb.completedOnboarding,
      belongsToActiveTeam: hasActiveTeams,
      username: userFromDb.username,
      orgAwareUsername: profileOrg ? enrichedUser.profile?.username ?? null : userFromDb.username,
      avatarUrl: userFromDb.avatarUrl,
      role: userFromDb.role as UserPermissionRole,
      locale: userFromDb.locale,
      profile: enrichedUser.profile ?? undefined,
      org:
        profileOrg && !profileOrg.isPlatform
          ? {
              id: profileOrg.id,
              name: profileOrg.name,
              slug: profileOrg.slug ?? "",
              logoUrl: profileOrg.logoUrl,
              fullDomain: WEBAPP_URL,
              domainSuffix: "",
              role: (orgRole ?? MembershipRole.MEMBER) as MembershipRole,
            }
          : undefined,
    },
    session,
    profileId,
    upId,
    hasValidLicense: false,
  };
};

function fallbackSession({
  user,
  session,
  userIdNumber,
}: {
  user: BetterAuthUser;
  session: BetterAuthSession;
  userIdNumber: number;
}): CalcomSessionShape {
  return {
    user: {
      id: userIdNumber,
      uuid: "",
      email: user.email,
      name: user.name ?? null,
      emailVerified: null,
      completedOnboarding: false,
      belongsToActiveTeam: false,
      username: null,
      orgAwareUsername: null,
      avatarUrl: null,
      role: undefined,
      locale: null,
      profile: undefined,
      org: undefined,
    },
    session,
    profileId: null,
    upId: `usr-${userIdNumber}`,
    hasValidLicense: false,
  };
}

function checkIfUserBelongsToActiveTeam(user: {
  teams?: { team: { metadata: unknown } }[];
}): boolean {
  if (!user.teams) return false;
  return user.teams.some((m) => {
    if (!IS_TEAM_BILLING_ENABLED) return true;
    const metadata = teamMetadataSchema.safeParse(m.team.metadata);
    return metadata.success && metadata.data?.subscriptionId;
  });
}
