import type { Session } from "next-auth";
import type { GetSessionParams } from "@calcom/auth/client";
import { getSession as getSessionInner } from "@calcom/auth/client";

export async function getSession(options: GetSessionParams): Promise<Session | null> {
  const session = await getSessionInner(options);

  // that these are equal are ensured in `[...nextauth]`'s callback
  return session as Session | null;
}
