export interface IdentityProvider {
  id: string;
  slug: string;
  displayName: string;
  kind: "oidc";
  issuer: string;
  clientId: string;
  scopes: string[];
  /** Trust the provider's own sign-in as two-factor, skipping core's TOTP. */
  countsAsMfa: boolean;
  isActive: boolean;
  /** The redirect URI to register at the provider. */
  callbackUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIdentityProviderInput {
  slug: string;
  displayName: string;
  kind: "oidc";
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  countsAsMfa?: boolean;
}

/** Omit `clientSecret` to keep the stored one. */
export type UpdateIdentityProviderInput = Partial<
  Omit<CreateIdentityProviderInput, "kind">
>;

export interface ProviderDomain {
  id: string;
  domain: string;
  organization: { id: string; name: string };
  autoAccept: boolean;
  ssoOnly: boolean;
  roles: { id: string; name: string; displayName: string }[];
}

export interface ProviderDomainInput {
  domain: string;
  organizationId: string;
  autoAccept: boolean;
  ssoOnly: boolean;
  roleIds: string[];
}

export interface ConnectedIdentity {
  id: string;
  provider: { slug: string; displayName: string };
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface IdentityInvite {
  provider: { id: string; slug: string; displayName: string };
  expiresAt: string;
}

export interface UserIdentities {
  identities: ConnectedIdentity[];
  invites: IdentityInvite[];
}

export interface ScimToken {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ScimConnection {
  id: string;
  providerId: string;
  baseUrl: string;
  isActive: boolean;
  lastUsedAt: string | null;
  managedUserCount: number;
  tokens: ScimToken[];
}

/** `token` is returned once, when it is minted. */
export interface NewScimToken {
  id: string;
  token: string;
  createdAt: string;
}
