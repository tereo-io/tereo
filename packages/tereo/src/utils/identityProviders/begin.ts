import { generateRandomString, hashFlowToken } from "../crypto.js";
import { adapterFor, upstreamCallbackUrl } from "./index.js";
import type { IdentityProvider } from "./types.js";

export interface UpstreamRoundTrip {
  /** Where the browser goes to sign in at the provider. */
  providerUrl: URL;
  /** For the upstream cookie; the session row keeps only its hash. */
  state: string;
  stateHash: string;
  nonce: string;
  codeVerifier: string;
}

/** The secrets and provider URL for one round trip; throws UpstreamAuthError. */
export const beginUpstreamAuth = async (
  provider: IdentityProvider
): Promise<UpstreamRoundTrip> => {
  const state = generateRandomString(64);
  const nonce = generateRandomString(64);
  const codeVerifier = generateRandomString(64);
  const providerUrl = await adapterFor(provider.kind).authorizationUrl(
    provider,
    {
      state,
      nonce,
      codeVerifier,
      redirectUri: upstreamCallbackUrl(provider.slug),
    }
  );
  return {
    providerUrl,
    state,
    stateHash: hashFlowToken(state),
    nonce,
    codeVerifier,
  };
};
