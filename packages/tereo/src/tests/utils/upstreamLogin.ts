import type { FakeClaims, FakeOidcProvider } from "./fakeOidcProvider.js";
import { absorbCookies, cookieHeader, newPkce } from "./browserLogin.js";
import type { CookieJar } from "./browserLogin.js";
import { CORE_URL } from "./coreUrl.js";
import { expect } from "vitest";

export const UPSTREAM_COOKIE = "tereo_upstream_auth";

export interface UpstreamLoginOptions {
  provider: FakeOidcProvider;
  slug: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  /** Bound to the fake's next `/authorize`; omit when a tamper answers it. */
  claims?: Partial<FakeClaims> & { sub: string };
  acrValues?: string;
  jar?: CookieJar;
  /** Sent as X-Forwarded-For, for a test that needs its own limiter key. */
  ip?: string;
}

const headersFor = (jar: CookieJar, ip?: string): Record<string, string> => ({
  Cookie: cookieHeader(jar),
  ...(ip ? { "X-Forwarded-For": ip } : {}),
});

/**
 * `/oauth/authorize`, then `/oauth/upstream/:slug/start`, then the fake's
 * `/authorize`. Returns the core callback URL the provider sent the browser
 * to, without following it.
 */
export const upstreamToCallback = async ({
  provider,
  slug,
  clientId,
  redirectUri,
  scope,
  claims,
  acrValues,
  jar = new Map(),
  ip,
}: UpstreamLoginOptions) => {
  const pkce = newPkce();
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: pkce.state,
    scope,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    ...(acrValues && { acr_values: acrValues }),
  };
  const query = new URLSearchParams(params);

  const authorize = await fetch(`${CORE_URL}/oauth/authorize?${query}`, {
    redirect: "manual",
    headers: headersFor(jar, ip),
  });
  absorbCookies(jar, authorize);
  expect(authorize.status).toBe(302);

  const start = await fetch(
    `${CORE_URL}/oauth/upstream/${slug}/start?${query}`,
    { redirect: "manual", headers: headersFor(jar, ip) }
  );
  absorbCookies(jar, start);
  expect(start.status).toBe(302);
  const providerUrl = new URL(start.headers.get("location") ?? "");
  expect(providerUrl.origin).toBe(provider.issuer);

  if (claims) provider.nextIdentity(claims);
  const atProvider = await fetch(providerUrl, { redirect: "manual" });
  expect(atProvider.status).toBe(302);
  const callbackUrl = new URL(atProvider.headers.get("location") ?? "");

  return { jar, params, verifier: pkce.verifier, callbackUrl };
};

/** Follows the provider's redirect back to core with the jar's cookies. */
export const upstreamCallback = async (
  callbackUrl: URL,
  jar: CookieJar,
  ip?: string
) => {
  const callback = await fetch(callbackUrl, {
    redirect: "manual",
    headers: headersFor(jar, ip),
  });
  absorbCookies(jar, callback);
  return callback;
};

/** The whole provider sign-in, up to and including core's callback. */
export const upstreamLogin = async (options: UpstreamLoginOptions) => {
  const flow = await upstreamToCallback(options);
  const callback = await upstreamCallback(
    flow.callbackUrl,
    flow.jar,
    options.ip
  );
  const location = new URL(callback.headers.get("location") ?? "", CORE_URL);
  return { ...flow, callback, location };
};
