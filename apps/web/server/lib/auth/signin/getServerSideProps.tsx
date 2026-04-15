import type { GetServerSidePropsContext } from "next";
import { getProviders, getCsrfToken } from "@calcom/auth/client";

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const csrfToken = await getCsrfToken(context);
  const providers = await getProviders();
  return {
    props: {
      csrfToken,
      providers,
    },
  };
}
