const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "nonce",
  "max_age",
  "acr_values",
  "prompt",
] as const;

/**
 * The authorize request's parameters from a page core redirected to. Core
 * writes absent ones as "", which must not be sent back: `max_age=""` would
 * be read as 0 and `prompt=""` is invalid.
 */
export const pickOAuthParams = (
  searchParams: URLSearchParams
): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const key of AUTHORIZE_PARAMS) {
    const value = searchParams.get(key);
    if (value) params[key] = value;
  }
  return params;
};

/**
 * The URL that restarts the authorize request a login-flow page belongs to,
 * for the client that began it (which still holds its PKCE verifier and
 * state); null when the page was not given one. A silent request restarts as
 * an interactive one: the user is here to sign in.
 */
export const authorizeRestartUrl = (
  coreUrl: string,
  searchParams: URLSearchParams
): string | null => {
  const params = pickOAuthParams(searchParams);
  if (
    !params.client_id ||
    !params.redirect_uri ||
    !params.state ||
    !params.code_challenge
  ) {
    return null;
  }
  if (params.prompt === "none") delete params.prompt;
  const query = new URLSearchParams({ ...params, response_type: "code" });
  return `${coreUrl}/oauth/authorize?${query.toString()}`;
};

/** A login-flow page's own session, with the authorize request it carries. */
export const flowSearch = (
  sessionToken: string,
  searchParams: URLSearchParams
): string =>
  new URLSearchParams({
    session: sessionToken,
    ...pickOAuthParams(searchParams),
  }).toString();
