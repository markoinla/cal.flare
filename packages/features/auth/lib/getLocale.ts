import { parse } from "accept-language-parser";
import { lookup } from "bcp-47-match";
import type { GetTokenParams } from "next-auth/jwt";

import { i18n } from "@calcom/i18n/next-i18next.config";

type ReadonlyHeaders = Awaited<ReturnType<typeof import("next/headers").headers>>;
type ReadonlyRequestCookies = Awaited<ReturnType<typeof import("next/headers").cookies>>;

const USE_BETTER_AUTH = process.env.AUTH_PROVIDER === "better-auth";

/**
 * Returns the preferred locale for the request.
 *
 * Under `AUTH_PROVIDER=next-auth`, reads the JWT to pick up `locale` stored
 * on the token. Under `AUTH_PROVIDER=better-auth`, `next-auth/jwt` is
 * dynamically skipped entirely — that import's CJS-only `_interopRequireDefault`
 * shim breaks vinext's ESM SSR pipeline, which is the whole reason the
 * migration exists. On the better-auth path we fall back to the
 * `accept-language` header; callers that need the authenticated user's
 * configured locale should call `getServerSession` instead.
 */
export const getLocale = async (
  req:
    | GetTokenParams["req"]
    | {
        cookies: ReadonlyRequestCookies;
        headers: ReadonlyHeaders;
      }
): Promise<string> => {
  if (!USE_BETTER_AUTH) {
    const { getToken } = await import("next-auth/jwt");
    const token = await getToken({ req: req as GetTokenParams["req"] });
    const tokenLocale = token?.["locale"];
    if (tokenLocale) return tokenLocale;
  }

  const acceptLanguage =
    req.headers instanceof Headers ? req.headers.get("accept-language") : req.headers["accept-language"];

  const languages = acceptLanguage ? parse(acceptLanguage) : [];

  const code: string = languages[0]?.code ?? "";
  const region: string = languages[0]?.region ?? "";

  // the code should consist of 2 or 3 lowercase letters
  // the regex underneath is more permissive
  const testedCode = /^[a-zA-Z]+$/.test(code) ? code : "en";

  // the code should consist of either 2 uppercase letters or 3 digits
  // the regex underneath is more permissive
  const testedRegion = /^[a-zA-Z0-9]+$/.test(region) ? region : "";

  const requestedLocale = `${testedCode}${testedRegion !== "" ? "-" : ""}${testedRegion}`;

  // use fallback to closest supported locale.
  // for instance, es-419 will be transformed to es
  return lookup(i18n.locales, requestedLocale) ?? requestedLocale;
};
