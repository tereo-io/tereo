import type { IdentityProvider, NormalizedIdentity } from "./types.js";
import { emailDomain } from "../email.js";

const GOOGLE_ISSUER = "https://accounts.google.com";
// Google is the authority for its own consumer domains, which carry no `hd`.
const GOOGLE_CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

const isGoogle = (provider: IdentityProvider): boolean =>
  provider.issuer?.replace(/\/+$/, "") === GOOGLE_ISSUER;

/**
 * Whether the provider vouches for `email` belonging to this person. Google
 * marks a consumer account's email verified even at a Workspace domain, so
 * there the `hd` claim must name the domain too.
 */
export const emailTrusted = (
  provider: IdentityProvider,
  identity: Pick<NormalizedIdentity, "emailVerified" | "hostedDomain">,
  email: string,
  match: "invite" | "domain"
): boolean => {
  if (!identity.emailVerified) return false;
  if (!isGoogle(provider)) return true;
  const domain = emailDomain(email);
  if (identity.hostedDomain?.toLowerCase() === domain) return true;
  return (
    match === "invite" &&
    identity.hostedDomain === null &&
    GOOGLE_CONSUMER_DOMAINS.has(domain)
  );
};
