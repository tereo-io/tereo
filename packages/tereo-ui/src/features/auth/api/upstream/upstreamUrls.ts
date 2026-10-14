import env from "@/lib/env";

/**
 * Where a browser goes to sign in through a provider. `params` are the login
 * page's authorize parameters, or `{ grant }` for a forced link.
 */
export const upstreamStartUrl = (
  slug: string,
  params: Record<string, string>
): string =>
  `${env.CORE_URL}/oauth/upstream/${encodeURIComponent(slug)}/start?${new URLSearchParams(params).toString()}`;
