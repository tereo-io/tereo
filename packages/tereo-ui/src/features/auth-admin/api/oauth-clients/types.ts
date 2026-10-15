export type UserType = "human" | "service_account";
export type ClientType = "confidential" | "public";
/**
 * Grants an admin-made (login) client can have. `client_credentials` belongs
 * to service clients only, which are made and managed under /admin/services.
 */
export type GrantType = "authorization_code" | "refresh_token";

export interface OAuthClient {
  id: string;
  clientId: string;
  clientType: ClientType;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string[];
  /** A service's client also lists `client_credentials`. */
  grantTypes: (GrantType | "client_credentials")[];
  /** Service slugs this client's tokens may name; a service's own client is managed under /admin/services. */
  audience: string[];
  /** Whether users approve the app after signing in; core's own login client never asks. */
  consentRequired: boolean;
  ownerId: string;
  /**
   * Set for a service's client, which is managed under /admin/services: core
   * refuses to edit, delete or regenerate it here.
   */
  service: { id: string; slug: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  owner?: User;
  serviceAccountUser?: User;
}

export interface OAuthClientWithSecret extends OAuthClient {
  clientSecret?: string;
}

export interface CreateClientInput {
  name: string;
  clientType: ClientType;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  grantTypes: GrantType[];
  audience?: string[];
  consentRequired?: boolean;
}

export interface UpdateClientInput {
  name?: string;
  clientType?: ClientType;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  grantTypes?: GrantType[];
  audience?: string[];
  consentRequired?: boolean;
  ownerId?: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  userType: UserType;
}
