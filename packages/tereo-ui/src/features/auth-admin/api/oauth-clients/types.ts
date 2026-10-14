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
  /** Read-only here: a service's audiences are approved under /admin/services. */
  audience: string[];
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
}

export interface UpdateClientInput {
  name?: string;
  clientType?: ClientType;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  grantTypes?: GrantType[];
  ownerId?: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  userType: UserType;
}
