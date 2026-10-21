import type { Prisma } from "../../../../../../../prisma/generated/client/index.js";
import type { AuthContext } from "../../../../../../middleware/auth.js";
import { assertGlobalAdmin } from "../../../../../../utils/grants.js";
import { ConflictError } from "../../../../../../utils/errors.js";
import db from "../../../../../../utils/db/index.js";

/**
 * SSO-only on an inactive provider would leave the domain no way to sign in.
 * Holds the provider's row lock for the rest of `tx`, so a concurrent
 * deactivation waits and then sees this domain.
 */
export const assertProviderActive = async (
  providerId: string,
  tx: Prisma.TransactionClient
) => {
  const provider = await db.identityProviders.lockForUpdate(providerId, tx);
  if (!provider.isActive) {
    throw new ConflictError(
      "The provider is inactive; activate it before making a domain SSO-only",
      "provider_inactive"
    );
  }
};

/**
 * A password login at an SSO-only domain is force-linked to its provider and
 * the password dropped, so whoever runs the provider gets those accounts:
 * turning it on, or pointing it at another domain, hands them over, and
 * turning it off (or deleting the domain) reopens them to passwords. Neither
 * is bounded by any permission the caller holds, so only a global `admin`.
 */
export const changesSsoOnly = (
  row: { ssoOnly: boolean; domain: string },
  body: { ssoOnly?: boolean; domain?: string }
) => {
  const after = body.ssoOnly ?? row.ssoOnly;
  if (after !== row.ssoOnly) return true;
  return after && body.domain !== undefined && body.domain !== row.domain;
};

export const assertMayChangeSsoOnly = (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  tx: Prisma.TransactionClient
) =>
  assertGlobalAdmin(
    auth,
    "Only an administrator (global admin) can make a domain SSO-only, move an SSO-only domain or lift SSO-only",
    tx
  );
