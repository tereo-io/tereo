/**
 * OAuth2 token introspection response. Matches RFC 7662 — minimal shape returned
 * by `POST /oauth/introspect`. Every consumer of `requireAuth` middleware reads
 * `active` and the claim fields (`sub`, `user_id`, `permissions`, `org_id`, ...).
 */
export type IntrospectionResponse =
  InactiveIntrospectionResponse | ActiveIntrospectionResponse;

export interface InactiveIntrospectionResponse {
  active: false;
}

export interface ActiveIntrospectionResponse {
  active: true;
  iss: string;
  /** The token's own subject: the user's id, or a client_credentials token's `client_id`. */
  sub: string;
  /**
   * The user the token acts as: the user's id (equal to `sub`) for a user
   * token, the client's service-account user for a client_credentials token.
   */
  user_id: string;
  aud?: string | string[];
  exp: number;
  iat: number;
  jti: string;
  scope: string;
  client_id: string;
  /**
   * Session id — absent for client_credentials, and for a person's token
   * minted without a refresh token. `sub` tells the two kinds apart: a
   * client_credentials token's `sub` is its `client_id`.
   */
  sid?: string;
  permissions?: string[];
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  updated_at?: number;
  email?: string;
  email_verified?: boolean;
  org_id?: string;
  org_name?: string;
}

/** Response shape of `POST /oauth/token` (`grant_type=client_credentials`). */
export interface ServiceAccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}
