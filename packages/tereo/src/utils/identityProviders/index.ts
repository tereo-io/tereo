import type { IdentityProviderKind, ProviderAdapter } from "./types.js";
import { oidcAdapter } from "./oidc.js";
import env from "../../env.js";

const adapters: Record<IdentityProviderKind, ProviderAdapter> = {
  oidc: oidcAdapter,
};

export const adapterFor = (kind: IdentityProviderKind): ProviderAdapter =>
  adapters[kind];

/** Core's redirect URI at the provider; it must be registered there exactly. */
export const upstreamCallbackUrl = (slug: string): string =>
  `${env.PUBLIC_URL.replace(/\/+$/, "")}/oauth/upstream/${slug}/callback`;
