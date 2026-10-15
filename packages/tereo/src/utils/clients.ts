import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { emitTx, logAuditTx } from "./outbox.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";

interface ClientToDelete {
  id: string;
  clientId: string;
  name: string;
}

/**
 * Delete a login client: its tokens are revoked and its service-account
 * user, if any, is deactivated (history names that user, so it outlives
 * the client). Returns the revoked jtis; the caller disconnects their sockets
 * once the transaction commits.
 */
export const deleteLoginClientTx = async (
  tx: Prisma.TransactionClient,
  client: ClientToDelete,
  actor: { userId: string; email: string | null }
): Promise<string[]> => {
  const jtis = await db.accessTokens.revokeByClientId(client.id, tx);
  const serviceAccount = await db.users.getByOAuthClientId(client.id);
  if (serviceAccount) {
    await db.users.update(serviceAccount.id, { isActive: false }, tx);
  }
  await db.clients.deleteClient(client.id, tx);
  await logAuditTx(tx, {
    auth: actor,
    action: "DELETE",
    entityType: "OAuthClient",
    entityId: client.id,
    entityName: client.name,
    metadata: {
      clientId: client.clientId,
      revokedAccessTokens: jtis.length,
      serviceAccountUserId: serviceAccount?.id ?? null,
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.client.deleted",
    entityType: "OAuthClient",
    entityId: client.id,
    data: { id: client.id, clientId: client.clientId, name: client.name },
  });
  return jtis;
};
