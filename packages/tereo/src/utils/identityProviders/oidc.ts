import { onIdentityProviderInvalidate } from "../cacheBroadcast.js";
import { assertExternalTargetSafe } from "../ssrfGuard.js";
import { openProviderSecret } from "./clientSecret.js";
import { UpstreamAuthError } from "./errors.js";
import { BadRequestError } from "../errors.js";
import { emailSchema } from "../email.js";
import { guardedFetch } from "./fetch.js";
import * as client from "openid-client";
import env from "../../env.js";
import type {
  IdentityProvider,
  IdentityProviderInput,
  NormalizedIdentity,
  ProviderAdapter,
  UpstreamAuthCheck,
  UpstreamAuthStart,
} from "./types.js";

const HTTP_REQUEST_FORBIDDEN = "OAUTH_HTTP_REQUEST_FORBIDDEN";
const ISSUER_MISMATCH = "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED";

interface Discovered {
  issuer: string;
  clientId: string;
  sealedSecret: string;
  config: client.Configuration;
}

const discovered = new Map<string, Discovered>();

onIdentityProviderInvalidate((id) => {
  discovered.delete(id);
});

/**
 * client_secret_basic escaping only what a URL component must. The library's
 * own also escapes "-", "." and "_" (RFC 6749 2.3.1), which Google does not
 * decode, so every Google client ID ("123-abc.apps.googleusercontent.com")
 * becomes an unknown client. A server that decodes reads both forms alike.
 */
const clientSecretBasic =
  (clientSecret: string): client.ClientAuth =>
  (_as, metadata, _body, headers) => {
    const encode = (value: string) =>
      encodeURIComponent(value).replace(/%20/g, "+");
    const credentials = `${encode(metadata.client_id)}:${encode(clientSecret)}`;
    headers.set(
      "authorization",
      `Basic ${Buffer.from(credentials).toString("base64")}`
    );
  };

const discover = (
  issuer: string,
  clientId: string,
  clientSecret: string
): Promise<client.Configuration> =>
  client.discovery(
    new URL(issuer),
    clientId,
    undefined,
    clientSecretBasic(clientSecret),
    {
      [client.customFetch]: guardedFetch,
      execute: [
        // Without it openid-client never checks the id_token's signature
        // against the provider's JWKS (fetched through guardedFetch too).
        client.enableNonRepudiationChecks,
        ...(env.OIDC_ALLOW_PRIVATE_ISSUERS &&
        new URL(issuer).protocol === "http:"
          ? [client.allowInsecureRequests]
          : []),
      ],
    }
  );

const configFor = async (
  provider: IdentityProvider
): Promise<client.Configuration> => {
  const cached = discovered.get(provider.id);
  // Also keyed on the row's values, so this process never uses settings an
  // edit replaced, even before the invalidation arrives.
  if (
    cached &&
    cached.issuer === provider.issuer &&
    cached.clientId === provider.clientId &&
    cached.sealedSecret === provider.clientSecret
  ) {
    return cached.config;
  }
  if (!provider.issuer) {
    throw new Error(`Identity provider ${provider.id} has no issuer`);
  }
  const secret = await openProviderSecret(provider);
  const config = await discover(provider.issuer, provider.clientId, secret);
  discovered.set(provider.id, {
    issuer: provider.issuer,
    clientId: provider.clientId,
    sealedSecret: provider.clientSecret,
    config,
  });
  return config;
};

const configOrFail = async (
  provider: IdentityProvider
): Promise<client.Configuration> => {
  try {
    return await configFor(provider);
  } catch (err) {
    throw new UpstreamAuthError(
      "upstream_failed",
      `Could not reach identity provider ${provider.slug}`,
      { cause: err }
    );
  }
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const toIdentity = (claims: client.IDToken): NormalizedIdentity => {
  // A claim that isn't one well-formed address ("a@evil.com, b@corp.com")
  // counts as none: it would be matched by its last domain, provisioned as
  // the account's email and later expand into several mail recipients.
  const email = emailSchema.safeParse(text(claims.email));
  return {
    subject: claims.sub,
    email: email.success ? email.data : null,
    emailVerified: claims.email_verified === true,
    name: text(claims.name),
    firstName: text(claims.given_name),
    lastName: text(claims.family_name),
    hostedDomain: text(claims.hd),
  };
};

const authorizationUrl = async (
  provider: IdentityProvider,
  session: UpstreamAuthStart
): Promise<URL> => {
  const config = await configOrFail(provider);
  return client.buildAuthorizationUrl(config, {
    response_type: "code",
    redirect_uri: session.redirectUri,
    scope: provider.scopes.join(" "),
    state: session.state,
    nonce: session.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(
      session.codeVerifier
    ),
    code_challenge_method: "S256",
  });
};

const complete = async (
  provider: IdentityProvider,
  callbackUrl: URL,
  session: UpstreamAuthCheck
): Promise<NormalizedIdentity> => {
  const config = await configOrFail(provider);
  // The token request's redirect_uri is taken from this URL; behind a proxy
  // the URL core reconstructs may differ from the one the provider has.
  const current = new URL(session.redirectUri);
  current.search = callbackUrl.search;
  let claims: client.IDToken | undefined;
  try {
    // Also checks the callback's RFC 9207 `iss` against the issuer when sent.
    const tokens = await client.authorizationCodeGrant(config, current, {
      expectedState: session.state,
      expectedNonce: session.nonce,
      pkceCodeVerifier: session.codeVerifier,
      idTokenExpected: true,
    });
    claims = tokens.claims();
  } catch (err) {
    if (
      err instanceof client.AuthorizationResponseError &&
      err.error === "access_denied"
    ) {
      throw new UpstreamAuthError(
        "upstream_cancelled",
        "Sign-in was cancelled at the identity provider",
        { cause: err }
      );
    }
    // The provider's own error code says why (invalid_client, invalid_grant,
    // redirect_uri_mismatch); the library's message alone does not.
    const detail =
      err instanceof client.ResponseBodyError
        ? ` (${err.error}${err.error_description ? `: ${err.error_description}` : ""})`
        : "";
    throw new UpstreamAuthError(
      "upstream_failed",
      `Sign-in through ${provider.slug} failed: ${err instanceof Error ? err.message : String(err)}${detail}`,
      { cause: err }
    );
  }
  if (!claims) {
    throw new UpstreamAuthError(
      "upstream_failed",
      `Identity provider ${provider.slug} returned no id_token`
    );
  }
  return toIdentity(claims);
};

const invalidConfig = (message: string) =>
  new BadRequestError("invalid_provider_config", message);

const validateConfig = async (input: IdentityProviderInput): Promise<void> => {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(input.issuer);
  } catch {
    throw invalidConfig("issuer is not a URL");
  }
  if (!input.scopes.includes("openid")) {
    throw invalidConfig("scopes must include openid");
  }
  // Ahead of discovery, so a private issuer is refused as such and not for
  // its scheme.
  if (!env.OIDC_ALLOW_PRIVATE_ISSUERS) {
    try {
      await (await assertExternalTargetSafe(issuerUrl.href)).close();
    } catch (err) {
      throw new BadRequestError(
        "provider_unreachable",
        `The issuer cannot be reached: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  let config: client.Configuration;
  try {
    config = await discover(input.issuer, input.clientId, input.clientSecret);
  } catch (err) {
    const code = err instanceof client.ClientError ? err.code : undefined;
    if (code === ISSUER_MISMATCH) {
      throw invalidConfig(
        "the discovery document names a different issuer than the one configured"
      );
    }
    if (code === HTTP_REQUEST_FORBIDDEN) {
      throw invalidConfig("issuer must use https");
    }
    throw new BadRequestError(
      "provider_unreachable",
      `Could not fetch the issuer's discovery document: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const metadata = config.serverMetadata();
  if (metadata.issuer !== input.issuer) {
    throw invalidConfig(
      `the discovery document names issuer ${metadata.issuer}; configure exactly that`
    );
  }
  if (!metadata.jwks_uri) {
    throw invalidConfig("the discovery document has no jwks_uri");
  }
  if (!metadata.response_types_supported?.includes("code")) {
    throw invalidConfig("the provider does not support response_type=code");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw invalidConfig("the provider does not support PKCE with S256");
  }
};

export const oidcAdapter: ProviderAdapter = {
  authorizationUrl,
  complete,
  validateConfig,
};
