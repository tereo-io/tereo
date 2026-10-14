import type { IdentityProvider } from "./types.js";
import { upstreamCallbackUrl } from "./index.js";

/** The admin API's provider: never the client secret. */
export const formatProvider = (provider: IdentityProvider) => ({
  id: provider.id,
  slug: provider.slug,
  displayName: provider.displayName,
  kind: provider.kind,
  issuer: provider.issuer,
  clientId: provider.clientId,
  scopes: provider.scopes,
  countsAsMfa: provider.countsAsMfa,
  isActive: provider.isActive,
  callbackUrl: upstreamCallbackUrl(provider.slug),
  createdAt: provider.createdAt,
  updatedAt: provider.updatedAt,
});

interface DomainRow {
  id: string;
  domain: string;
  autoAccept: boolean;
  ssoOnly: boolean;
  organization: { id: string; name: string };
  roles: { role: { id: string; name: string; displayName: string } }[];
}

export const formatDomain = (domain: DomainRow) => ({
  id: domain.id,
  domain: domain.domain,
  organization: {
    id: domain.organization.id,
    name: domain.organization.name,
  },
  autoAccept: domain.autoAccept,
  ssoOnly: domain.ssoOnly,
  roles: domain.roles.map(({ role }) => ({
    id: role.id,
    name: role.name,
    displayName: role.displayName,
  })),
});
