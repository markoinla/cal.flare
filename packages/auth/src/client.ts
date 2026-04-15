import * as React from "react";
import { createAuthClient } from "better-auth/react";
import { customSessionClient } from "better-auth/client/plugins";

import type { Auth } from "./server";
import type { Session } from "./types";

const BASE_URL =
  process.env.NEXT_PUBLIC_WEBAPP_URL ??
  process.env.BETTER_AUTH_URL ??
  process.env.NEXTAUTH_URL ??
  (typeof window !== "undefined" ? window.location.origin : undefined);

export const authClient = createAuthClient({
  baseURL: BASE_URL,
  plugins: [customSessionClient<Auth>()],
});

/**
 * Flag available client-side. Controls whether helpers post to the better-auth
 * endpoint or delegate to next-auth. Keep this in sync with the server-side
 * `AUTH_PROVIDER` so both sides agree on which stack is live.
 */
export const CLIENT_USES_BETTER_AUTH =
  process.env.NEXT_PUBLIC_AUTH_PROVIDER === "better-auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SessionUpdate = (data?: any) => Promise<Session | null>;

/**
 * Discriminated union matching next-auth's `SessionContextValue` so TypeScript
 * narrows `session.data` to non-null when callers check `status === "authenticated"`.
 */
export type SessionContextValue =
  | { data: Session; status: "authenticated"; update: SessionUpdate }
  | { data: null; status: "unauthenticated"; update: SessionUpdate }
  | { data: Session | null; status: "loading"; update: SessionUpdate };

/**
 * next-auth-compatible `useSession()`. Returns `{ data, status, update }` so the
 * hundreds of consumer sites that read `session.status === "authenticated"`,
 * `session.data?.user.role`, etc. keep working across the auth backend swap.
 */
export function useSession(): SessionContextValue {
  const { data, isPending, refetch } = authClient.useSession();
  const update: SessionUpdate = async () => {
    await refetch?.();
    // Next-auth's update() mutates the cookie then returns the new session.
    // Better-auth has no equivalent write API on the client; callers that
    // depend on update() to mirror server-side state should rely on the
    // next refetch picking up the change.
    return (data ?? null) as Session | null;
  };
  if (isPending) {
    return { data: (data ?? null) as Session | null, status: "loading", update };
  }
  if (data) {
    return { data: data as unknown as Session, status: "authenticated", update };
  }
  return { data: null, status: "unauthenticated", update };
}

export async function getSession(): Promise<Session | null> {
  const { data } = await authClient.getSession();
  return (data ?? null) as Session | null;
}

type CredentialsInput = {
  email: string;
  password: string;
  totpCode?: string;
  backupCode?: string;
};

type LegacySignInResult = {
  ok: boolean;
  error?: string;
  status: number;
  url: string | null;
};

/**
 * Drop-in replacement for next-auth's `signIn("credentials", { ... })`. Uses
 * better-auth's `/api/auth/sign-in/credentials` when the flag is on, falls back
 * to next-auth's client otherwise.
 */
export async function signInCredentials(
  input: CredentialsInput,
  { callbackUrl }: { callbackUrl?: string } = {}
): Promise<LegacySignInResult> {
  if (!CLIENT_USES_BETTER_AUTH) {
    const { signIn: nextAuthSignIn } = await import("next-auth/react");
    const res = await nextAuthSignIn<"credentials">("credentials", {
      ...input,
      callbackUrl,
      redirect: false,
    });
    return {
      ok: Boolean(res?.ok),
      error: res?.error ?? undefined,
      status: res?.status ?? 500,
      url: res?.url ?? null,
    };
  }

  const response = await fetch(`${BASE_URL ?? ""}/api/auth/sign-in/credentials`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.ok) {
    return { ok: true, status: response.status, url: callbackUrl ?? null };
  }
  const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
  return {
    ok: false,
    status: response.status,
    url: null,
    error: body.message ?? body.code ?? "unknown-error",
  };
}

type SignInOptions = { callbackUrl?: string; redirect?: boolean } & Record<string, unknown>;
type SignOutOptions = { callbackUrl?: string; redirect?: boolean };

/**
 * next-auth-compatible `signIn(provider, options)` shim. Single-tenant rollout:
 * `credentials` uses our wrapper, social providers delegate to next-auth when
 * the flag is off. When flag is on, social providers use better-auth's
 * `signIn.social()`.
 */
export async function signIn(
  provider?: string,
  options: SignInOptions = {}
): Promise<LegacySignInResult | undefined> {
  if (!CLIENT_USES_BETTER_AUTH) {
    const { signIn: nextAuthSignIn } = await import("next-auth/react");
    const res = await nextAuthSignIn(provider, options as never);
    if (!res) return undefined;
    return {
      ok: Boolean(res.ok),
      error: res.error ?? undefined,
      status: res.status ?? 500,
      url: res.url ?? null,
    };
  }

  if (provider === "credentials") {
    return signInCredentials(options as unknown as CredentialsInput, {
      callbackUrl: options.callbackUrl,
    });
  }
  if (provider === "google" || provider === "azure-ad" || provider === "microsoft") {
    const mappedProvider = provider === "azure-ad" ? "microsoft" : provider;
    await authClient.signIn.social({
      provider: mappedProvider as "google" | "microsoft",
      callbackURL: options.callbackUrl,
    });
    return { ok: true, status: 200, url: options.callbackUrl ?? null };
  }
  if (provider === "email") {
    // Magic-link. Better-auth's plugin exposes `authClient.signIn.magicLink`.
    const magicLink = (authClient.signIn as unknown as { magicLink?: Function }).magicLink;
    if (magicLink) {
      await magicLink({ email: options.email, callbackURL: options.callbackUrl });
      return { ok: true, status: 200, url: options.callbackUrl ?? null };
    }
  }
  return { ok: false, status: 400, url: null, error: "unsupported-provider" };
}

/** next-auth-compatible `signOut({ callbackUrl, redirect })`. */
export async function signOut(options: SignOutOptions = {}): Promise<{ url: string }> {
  if (!CLIENT_USES_BETTER_AUTH) {
    const { signOut: nextAuthSignOut } = await import("next-auth/react");
    const res = await nextAuthSignOut(options as never);
    return { url: (res as { url?: string } | undefined)?.url ?? options.callbackUrl ?? "/" };
  }
  await authClient.signOut();
  const url = options.callbackUrl ?? "/";
  if (options.redirect !== false && typeof window !== "undefined") {
    window.location.href = url;
  }
  return { url };
}

/**
 * Shims for less-commonly-used next-auth exports. Single-tenant password-only
 * rollout doesn't exercise CSRF form-POST or a provider picker, so these are
 * safe no-ops.
 */
export function SessionProvider(props: {
  children: React.ReactNode;
  /** Accepts any session shape (next-auth or better-auth); the shim ignores it. */
  session?: unknown;
  // next-auth passes a refetchInterval etc.; ignore them.
  [key: string]: unknown;
}) {
  return React.createElement(React.Fragment, null, props.children);
}

export async function getCsrfToken(_context?: unknown): Promise<string> {
  return "";
}

export type ClientSafeProvider = {
  id: string;
  name: string;
  type: "credentials" | "email" | "oauth";
  signinUrl: string;
  callbackUrl: string;
};

export async function getProviders(): Promise<Record<string, ClientSafeProvider> | null> {
  return null;
}

export type GetSessionParams = { req?: unknown; ctx?: unknown };

export const signUp = authClient.signUp;
