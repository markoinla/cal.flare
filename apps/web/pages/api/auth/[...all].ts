import type { NextApiRequest, NextApiResponse } from "next";
import NextAuth from "next-auth";
import { toNodeHandler } from "better-auth/node";

import { auth } from "@calcom/auth";
import { getOptions } from "@calcom/features/auth/lib/next-auth-options";
import { getTrackingFromCookies } from "@calcom/lib/tracking";

const USE_BETTER_AUTH = process.env.AUTH_PROVIDER === "better-auth";

// better-auth consumes the raw request stream; next-auth parses the body itself.
// With bodyParser off, next-auth still works because it reads the stream directly.
export const config = {
  api: { bodyParser: false },
};

const betterAuthHandler = toNodeHandler(auth.handler);

const nextAuthHandler = (req: NextApiRequest, res: NextApiResponse) =>
  NextAuth(
    req,
    res,
    getOptions({
      getDubId: () => req.cookies.dub_id || req.cookies.dclid,
      getTrackingData: () => getTrackingFromCookies(req.cookies, req.query),
    })
  );

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (USE_BETTER_AUTH) {
    return betterAuthHandler(req, res);
  }
  return nextAuthHandler(req, res);
}
