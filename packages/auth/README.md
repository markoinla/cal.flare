# @calcom/auth

Cal.diy authentication powered by [better-auth](https://better-auth.com).

Replaces next-auth v4 across the monorepo. See `/home/marko/.claude/plans/kind-napping-kahan.md` for the migration plan.

## Structure

```
src/
  server.ts                 # betterAuth() instance + HTTP handler
  client.ts                 # createAuthClient() for React
  types.ts                  # Session / User type definitions
  plugins/
    calcom-credentials.ts   # Password verify via existing UserPassword + INACTIVE_ADMIN
    calcom-2fa.ts           # TOTP + backup codes (reads existing encrypted columns)
    calcom-session.ts       # customSession — injects org/profile/role/etc.
    calcom-oauth-scopes.ts  # Post-OAuth hooks for Google/Microsoft Calendar credentials
    jackson-saml.ts         # saml-jackson provider
  adapter/
    prisma-field-map.ts     # Maps better-auth field names to existing Cal columns
```

## Rollout

Gated behind `AUTH_PROVIDER=better-auth` env var. Default is `next-auth` until staging verification clears.
