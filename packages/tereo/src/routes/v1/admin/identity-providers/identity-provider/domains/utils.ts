import type { Prisma } from "../../../../../../../prisma/generated/client/index.js";
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
