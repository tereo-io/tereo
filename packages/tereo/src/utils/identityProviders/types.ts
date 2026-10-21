import type {
  IdentityProvider,
  IdentityProviderKind,
} from "../../../prisma/generated/client/index.js";

/** The row as stored: `clientSecret` still sealed. */
export type { IdentityProvider, IdentityProviderKind };

/** An admin's provider configuration before it is saved; the secret in the clear. */
export interface IdentityProviderInput {
  kind: "oidc";
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/** What the core request demands of the login, passed on to the provider. */
export interface UpstreamReauth {
  /** Sent as `prompt=login`. */
  promptLogin: boolean;
  /** Sent as `max_age`. */
  maxAge: number | null;
}

export interface UpstreamAuthStart extends UpstreamReauth {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Core's callback for this provider (`upstreamCallbackUrl`). */
  redirectUri: string;
}

/** What was stored at the start, checked against the callback. */
export interface UpstreamAuthCheck {
  nonce: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
}

export interface NormalizedIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Google's `hd`: the Workspace domain, absent for consumer accounts. */
  hostedDomain: string | null;
  /** When the user last authenticated at the provider (`auth_time`), if it said. */
  authTime: Date | null;
}

export interface ProviderAdapter {
  authorizationUrl(
    provider: IdentityProvider,
    session: UpstreamAuthStart
  ): Promise<URL>;
  /** Throws an UpstreamAuthError when the provider refused or the response fails a check. */
  complete(
    provider: IdentityProvider,
    callbackUrl: URL,
    session: UpstreamAuthCheck
  ): Promise<NormalizedIdentity>;
  /** Save-time check: reachable, and its metadata fits what core needs. Throws BadRequestError. */
  validateConfig(provider: IdentityProviderInput): Promise<void>;
}
