import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import prisma from "@calcom/prisma";
import { LRUCache } from "lru-cache";
import type { GetServerSidePropsContext, NextApiRequest } from "next";
import type { AuthOptions, Session } from "next-auth";
import { getToken } from "next-auth/jwt";

class LicenseKeySingleton {
  static async getInstance(..._args: unknown[]) { return new LicenseKeySingleton(); }
  async checkLicense() { return true; }
  async validateLicenseKey() { return true; }
}
class DeploymentRepository {
  constructor(_prisma?: unknown) {}
  async findFirst(..._args: unknown[]) { return null; }
}

const log = logger.getSubLogger({ prefix: ["getServerSession"] });

/**
 * Stores the session in memory using the stringified token as the key.
 */
const CACHE = new LRUCache<string, Session>({ max: 1000 });

const USE_BETTER_AUTH = process.env.AUTH_PROVIDER === "better-auth";

/**
 * Cal.diy's server-side session reader.
 *
 * Behavior switches on `AUTH_PROVIDER`:
 *   - default / "next-auth": original JWT-decode path (kept for rollback safety).
 *   - "better-auth": delegates to `@calcom/auth`'s `auth.api.getSession`.
 *
 * The customSession plugin (packages/auth/src/plugins/calcom-session.ts) returns
 * a shape structurally compatible with the legacy next-auth Session, so downstream
 * consumers keep working without per-call-site edits.
 */
export async function getServerSession(options: {
  req: NextApiRequest | GetServerSidePropsContext["req"];
  authOptions?: AuthOptions;
}) {
  if (USE_BETTER_AUTH) {
    return getBetterAuthSession(options.req);
  }
  return getNextAuthSession(options);
}

async function getBetterAuthSession(
  req: NextApiRequest | GetServerSidePropsContext["req"]
): Promise<Session | null> {
  const { auth } = await import("@calcom/auth");
  const headers = toFetchHeaders(req.headers);
  const session = await auth.api.getSession({ headers });
  if (!session || !session.user) return null;
  return session as unknown as Session;
}

function toFetchHeaders(headers: NextApiRequest["headers"]): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const v of value) h.append(key, v);
    } else {
      h.set(key, value);
    }
  }
  return h;
}

async function getNextAuthSession(options: {
  req: NextApiRequest | GetServerSidePropsContext["req"];
  authOptions?: AuthOptions;
}): Promise<Session | null> {
  const { req, authOptions: { secret } = {} } = options;

  const token = await getToken({ req, secret });
  log.debug("Getting server session", safeStringify({ token }));

  if (!token || !token.email || !token.sub) {
    log.debug("Couldn't get token");
    return null;
  }

  const cachedSession = CACHE.get(JSON.stringify(token));
  if (cachedSession) {
    log.debug("Returning cached session", safeStringify(cachedSession));
    return cachedSession;
  }

  const userId = token.sub ? Number(token.sub) : null;
  if (!userId || userId <= 0) {
    log.warn("Invalid or missing user ID in token", { sub: token.sub });
    return null;
  }

  const userFromDb = await prisma.user.findUnique({ where: { id: userId } });
  if (!userFromDb) {
    log.warn("No user found for valid token", { userId });
    return null;
  }

  const deploymentRepo = new DeploymentRepository(prisma);
  const licenseKeyService = await LicenseKeySingleton.getInstance(deploymentRepo);
  const hasValidLicense = await licenseKeyService.checkLicense();

  let upId = token.upId;
  if (!upId) upId = `usr-${userFromDb.id}`;

  if (!upId) {
    log.error("No upId found for session", { userId: userFromDb.id });
    return null;
  }

  const userRepository = new UserRepository(prisma);
  const user = await userRepository.enrichUserWithTheProfile({ user: userFromDb, upId });

  const session: Session = {
    hasValidLicense,
    expires: new Date(typeof token.exp === "number" ? token.exp * 1000 : Date.now()).toISOString(),
    user: {
      id: user.id,
      uuid: user.uuid,
      name: user.name,
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      email_verified: user.emailVerified !== null,
      completedOnboarding: user.completedOnboarding,
      role: user.role,
      image: getUserAvatarUrl({ avatarUrl: user.avatarUrl }),
      belongsToActiveTeam: token.belongsToActiveTeam,
      org: token.org,
      orgAwareUsername: token.orgAwareUsername,
      locale: user.locale ?? undefined,
      profile: user.profile,
    },
    profileId: token.profileId,
    upId,
  };

  if (token?.impersonatedBy?.id) {
    const impersonatedByUser = await prisma.user.findUnique({
      where: { id: token.impersonatedBy.id },
      select: { id: true, uuid: true, role: true },
    });
    if (impersonatedByUser) {
      session.user.impersonatedBy = {
        id: impersonatedByUser.id,
        uuid: impersonatedByUser.uuid,
        role: impersonatedByUser.role,
      };
    }
  }

  CACHE.set(JSON.stringify(token), session);
  log.debug("Returned session", safeStringify(session));
  return session;
}
