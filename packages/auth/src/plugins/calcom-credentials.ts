import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

import { ErrorCode } from "@calcom/feature-auth/lib/ErrorCode";
import { verifyPassword } from "@calcom/feature-auth/lib/verifyPassword";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { isPasswordValid } from "@calcom/lib/auth/isPasswordValid";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import { isENVDev } from "@calcom/lib/env";
import logger from "@calcom/lib/logger";
import { hashEmail } from "@calcom/lib/server/PiiHasher";
import prisma from "@calcom/prisma";
import { IdentityProvider, UserPermissionRole } from "@calcom/prisma/enums";

const log = logger.getSubLogger({ prefix: ["auth:calcom-credentials"] });

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional(),
  backupCode: z.string().optional(),
});

/**
 * Custom better-auth plugin for Cal.diy's email+password sign-in flow.
 *
 * Preserves behavior from the legacy next-auth credentials provider
 * (packages/features/auth/lib/next-auth-options.ts `authorizeCredentials`):
 *   - reads the password hash from UserPassword (not from Account.password)
 *   - verifies with the existing bcrypt-based verifyPassword helper
 *   - applies per-email rate limiting via hashEmail()
 *   - enforces the "locked user" check
 *   - enforces 2FA + backup-code flow (decrypts User.twoFactorSecret / backupCodes
 *     with CALENDSO_ENCRYPTION_KEY)
 *   - computes INACTIVE_ADMIN role state when an admin doesn't meet minimum security
 *
 * Exposes `POST /api/auth/sign-in/credentials` as the endpoint.
 */
export const calcomCredentials = () => {
  return {
    id: "calcom-credentials",
    endpoints: {
      signInCredentials: createAuthEndpoint(
        "/sign-in/credentials",
        { method: "POST" },
        async (ctx) => {
          const parsed = credentialsSchema.safeParse(ctx.body);
          if (!parsed.success) {
            throw new APIError("BAD_REQUEST", { message: ErrorCode.IncorrectEmailPassword });
          }
          const credentials = parsed.data;

          const userRepo = new UserRepository(prisma);
          const user = await userRepo.findByEmailAndIncludeProfilesAndPassword({
            email: credentials.email,
          });
          if (!user) {
            throw new APIError("UNAUTHORIZED", { message: ErrorCode.IncorrectEmailPassword });
          }

          if (user.locked) {
            throw new APIError("UNAUTHORIZED", { message: ErrorCode.UserAccountLocked });
          }

          await checkRateLimitAndThrowError({ identifier: hashEmail(user.email) });

          if (!user.password?.hash) {
            throw new APIError("UNAUTHORIZED", { message: ErrorCode.IncorrectEmailPassword });
          }

          const isCorrectPassword = await verifyPassword(credentials.password, user.password.hash);
          if (!isCorrectPassword) {
            throw new APIError("UNAUTHORIZED", { message: ErrorCode.IncorrectEmailPassword });
          }

          if (user.twoFactorEnabled && credentials.backupCode) {
            if (!process.env.CALENDSO_ENCRYPTION_KEY) {
              log.error("Missing encryption key; cannot proceed with backup code login.");
              throw new APIError("INTERNAL_SERVER_ERROR", { message: ErrorCode.InternalServerError });
            }
            if (!user.backupCodes) {
              throw new APIError("UNAUTHORIZED", { message: ErrorCode.MissingBackupCodes });
            }

            const backupCodes = JSON.parse(
              symmetricDecrypt(user.backupCodes, process.env.CALENDSO_ENCRYPTION_KEY)
            );
            const index = backupCodes.indexOf(credentials.backupCode.replaceAll("-", ""));
            if (index === -1) {
              throw new APIError("UNAUTHORIZED", { message: ErrorCode.IncorrectBackupCode });
            }
            backupCodes[index] = null;
            await prisma.user.update({
              where: { id: user.id },
              data: {
                backupCodes: symmetricEncrypt(
                  JSON.stringify(backupCodes),
                  process.env.CALENDSO_ENCRYPTION_KEY
                ),
              },
            });
          } else if (user.twoFactorEnabled) {
            if (!credentials.totpCode) {
              throw new APIError("UNAUTHORIZED", { message: ErrorCode.SecondFactorRequired });
            }
            if (!user.twoFactorSecret) {
              log.error(`Two factor is enabled for user ${user.id} but they have no secret`);
              throw new APIError("INTERNAL_SERVER_ERROR", { message: ErrorCode.InternalServerError });
            }
            if (!process.env.CALENDSO_ENCRYPTION_KEY) {
              log.error("Missing encryption key; cannot proceed with two factor login.");
              throw new APIError("INTERNAL_SERVER_ERROR", { message: ErrorCode.InternalServerError });
            }
            const secret = symmetricDecrypt(user.twoFactorSecret, process.env.CALENDSO_ENCRYPTION_KEY);
            if (secret.length !== 32) {
              log.error(
                `Two factor secret decryption failed. Expected key with length 32 but got ${secret.length}`
              );
              throw new APIError("INTERNAL_SERVER_ERROR", { message: ErrorCode.InternalServerError });
            }
            const { totpAuthenticatorCheck } = await import("@calcom/lib/totp");
            const isValidToken = totpAuthenticatorCheck(credentials.totpCode, secret);
            if (!isValidToken) {
              throw new APIError("UNAUTHORIZED", { message: ErrorCode.IncorrectTwoFactorCode });
            }
          }

          const role = validateAdminRole(user, credentials.password);
          const inactiveAdminReason =
            role === "INACTIVE_ADMIN" ? computeInactiveAdminReason(user, credentials.password) : undefined;

          const session = await ctx.context.internalAdapter.createSession(String(user.id));
          // setSessionCookie only reads session.token and stringifies user into the
          // cookie cache. Missing fields (emailVerified/image/createdAt) get written
          // as undefined and hydrated on next customSession invocation.
          const userForCookie = {
            id: String(user.id),
            email: user.email,
            name: user.name ?? user.email,
          };
          await setSessionCookie(ctx, { session, user: userForCookie as never });

          return ctx.json({
            redirect: false,
            token: session.token,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              role,
              inactiveAdminReason,
            },
          });
        }
      ),
    },
  };
};

function validateAdminRole(
  user: { role: UserPermissionRole; identityProvider: IdentityProvider; twoFactorEnabled: boolean },
  password: string
): UserPermissionRole | "INACTIVE_ADMIN" {
  if (user.role !== UserPermissionRole.ADMIN) return user.role;
  if (user.identityProvider !== IdentityProvider.CAL) return user.role;
  if (process.env.NEXT_PUBLIC_IS_E2E) return user.role;
  if (isPasswordValid(password, false, true) && user.twoFactorEnabled) return user.role;
  if (isENVDev) return user.role;
  return "INACTIVE_ADMIN";
}

function computeInactiveAdminReason(
  user: { twoFactorEnabled: boolean },
  password: string
): "both" | "password" | "2fa" {
  const passwordValid = isPasswordValid(password, false, true);
  const has2FA = user.twoFactorEnabled;
  if (!passwordValid && !has2FA) return "both";
  if (!passwordValid) return "password";
  return "2fa";
}
