import { openRowSecret } from "../sealedSecrets.js";
import type { IdentityProvider } from "./types.js";
import { prisma } from "../db/prisma.js";

export const clientSecretName = (providerId: string): string =>
  `identity-provider:${providerId}`;

/** The provider's client secret in the clear, resealing the row if it was under an older KEK. */
export const openProviderSecret = async (
  provider: Pick<IdentityProvider, "id" | "clientSecret">
): Promise<string> => {
  const { value, resealed } = await openRowSecret(
    clientSecretName(provider.id),
    provider.clientSecret
  );
  if (resealed) {
    // Only over the value we opened: an admin may have replaced it meanwhile.
    await prisma.identityProvider.updateMany({
      where: { id: provider.id, clientSecret: provider.clientSecret },
      data: { clientSecret: resealed },
    });
  }
  return value;
};
