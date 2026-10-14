import { openProviderSecret } from "./identityProviders/clientSecret.js";
import { openConnectionSecrets } from "./notifications/connections.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";

/**
 * Opens every row-sealed secret (identity providers' client secrets,
 * notification connections' secrets), which reseals any still under the
 * previous or the dev KEK. Opening them on use alone would leave a provider or
 * connection nobody used during a KEK rotation under the old key, unreadable
 * once `CORE_KEK_PREVIOUS` is removed. Run on start, after `loadKeys()`; a row
 * that fails is logged and left for the next start.
 */
export async function resealRowSecrets(): Promise<{
  opened: number;
  failed: number;
}> {
  let opened = 0;
  let failed = 0;
  const attempt = async (what: object, open: () => Promise<unknown>) => {
    try {
      await open();
      opened++;
    } catch (err) {
      failed++;
      logger.error({ err, ...what }, "Failed to open a sealed row secret");
    }
  };

  for (const provider of await prisma.identityProvider.findMany({
    select: { id: true, clientSecret: true },
  })) {
    await attempt({ identityProviderId: provider.id }, () =>
      openProviderSecret(provider)
    );
  }
  for (const connection of await prisma.notificationConnection.findMany({
    where: { secrets: { not: null } },
  })) {
    await attempt({ notificationConnectionId: connection.id }, () =>
      openConnectionSecrets(connection)
    );
  }
  return { opened, failed };
}
