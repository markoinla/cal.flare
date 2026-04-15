import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { customSession, magicLink } from "better-auth/plugins";

import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_OAUTH_SCOPES,
  MICROSOFT_CALENDAR_SCOPES,
  WEBAPP_URL,
} from "@calcom/lib/constants";
import { isENVDev } from "@calcom/lib/env";
import prisma from "@calcom/prisma";

import { buildCustomSession } from "./plugins/calcom-session";
import { calcomCredentials } from "./plugins/calcom-credentials";

const GOOGLE_API_CREDENTIALS = process.env.GOOGLE_API_CREDENTIALS || "{}";
const { client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET } =
  JSON.parse(GOOGLE_API_CREDENTIALS)?.web || {};
const GOOGLE_LOGIN_ENABLED = process.env.GOOGLE_LOGIN_ENABLED === "true";
const IS_GOOGLE_LOGIN_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_LOGIN_ENABLED);

const OUTLOOK_CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID;
const OUTLOOK_CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET;
const OUTLOOK_LOGIN_ENABLED = process.env.OUTLOOK_LOGIN_ENABLED === "true";
const IS_OUTLOOK_LOGIN_ENABLED = !!(OUTLOOK_CLIENT_ID && OUTLOOK_CLIENT_SECRET && OUTLOOK_LOGIN_ENABLED);

const BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
const BETTER_AUTH_URL =
  process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL ?? WEBAPP_URL;
const COOKIE_DOMAIN = process.env.NEXTAUTH_COOKIE_DOMAIN || undefined;

export const auth = betterAuth({
  appName: "Cal.diy",
  secret: BETTER_AUTH_SECRET,
  baseURL: BETTER_AUTH_URL,
  trustedOrigins: [BETTER_AUTH_URL, WEBAPP_URL].filter(Boolean) as string[],

  database: prismaAdapter(prisma, { provider: "postgresql" }),

  advanced: {
    database: {
      // Tells better-auth that User.id is a number (auto-increment). Coerces
      // session.userId / account.userId to numbers before INSERTs. Prisma still
      // fills in cuid defaults for Session.id / Account.id since those columns
      // have `@default(cuid())` at the schema layer.
      useNumberId: true,
    },
    crossSubDomainCookies: COOKIE_DOMAIN
      ? { enabled: true, domain: COOKIE_DOMAIN }
      : { enabled: false },
    defaultCookieAttributes: {
      httpOnly: true,
      secure: !isENVDev,
      sameSite: "lax",
    },
  },

  user: {
    modelName: "User",
    fields: {
      image: "avatarUrl",
      createdAt: "createdDate",
      emailVerified: "emailVerifiedBool",
    },
  },

  session: {
    modelName: "Session",
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },

  account: {
    modelName: "Account",
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "microsoft", "email"],
    },
  },

  verification: { modelName: "VerificationToken" },

  socialProviders: {
    ...(IS_GOOGLE_LOGIN_ENABLED && {
      google: {
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        scope: [...GOOGLE_OAUTH_SCOPES, ...GOOGLE_CALENDAR_SCOPES],
        accessType: "offline",
        prompt: "select_account consent",
      },
    }),
    ...(IS_OUTLOOK_LOGIN_ENABLED && {
      microsoft: {
        clientId: OUTLOOK_CLIENT_ID!,
        clientSecret: OUTLOOK_CLIENT_SECRET!,
        scope: ["openid", "profile", "email", ...MICROSOFT_CALENDAR_SCOPES],
        prompt: "consent",
      },
    }),
  },

  plugins: [
    calcomCredentials(),
    magicLink({
      expiresIn: 60 * 10,
      sendMagicLink: async ({ email, url, token }, _request) => {
        const { default: sendVerificationRequest } = await import(
          "@calcom/feature-auth/lib/sendVerificationRequest"
        );
        await sendVerificationRequest({
          identifier: email,
          url,
          token,
          expires: new Date(Date.now() + 60 * 10 * 1000),
          provider: { from: process.env.EMAIL_FROM ?? "noreply@cal.com", server: {} },
        } as Parameters<typeof sendVerificationRequest>[0]);
      },
    }),
    customSession(buildCustomSession),
  ],
});

export type Auth = typeof auth;
