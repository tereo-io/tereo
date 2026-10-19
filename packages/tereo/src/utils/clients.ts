import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { emitTx, logAuditTx } from "./outbox.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";
import env from "../env.js";

interface ClientToDelete {
  id: string;
  clientId: string;
  name: string;
}

/**
 * A service-account user is deactivated, not deleted: history names it.
 * Returns the revoked jtis; the caller disconnects their sockets once the
 * transaction commits.
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

/** `retired` with `hashes` added, once each. */
export const withRetired = (
  retired: string[],
  ...hashes: (string | null)[]
): string[] => [
  ...new Set([...retired, ...hashes.filter((h): h is string => !!h)]),
];

/**
 * A client's secret columns once `newHash` replaces its current secret. The
 * old secret keeps working for `SERVICE_SECRET_OVERLAP_HOURS`, if there was
 * one; whatever stops working is retired.
 */
export const rotatedSecretFields = (
  client: {
    clientSecret: string | null;
    previousSecretHash: string | null;
    retiredSecretHashes: string[];
  },
  newHash: string,
  now: Date
) => {
  const overlapMs = env.SERVICE_SECRET_OVERLAP_HOURS * 60 * 60 * 1000;
  const oldHash = client.clientSecret;
  const previousSecretExpiresAt =
    overlapMs > 0 && oldHash ? new Date(now.getTime() + overlapMs) : null;
  return {
    clientSecret: newHash,
    previousSecretHash: previousSecretExpiresAt ? oldHash : null,
    previousSecretExpiresAt,
    retiredSecretHashes: withRetired(
      client.retiredSecretHashes,
      client.previousSecretHash,
      previousSecretExpiresAt ? null : oldHash
    ),
  };
};

/** End a client's secret overlap now, retiring its previous secret. */
export const revokePreviousSecretTx = async (
  tx: Prisma.TransactionClient,
  clientRowId: string
) => {
  await tx.$executeRaw`
    UPDATE "auth"."oauth_clients"
    SET "retired_secret_hashes" = CASE
          WHEN "previous_secret_hash" IS NULL
            OR "previous_secret_hash" = ANY ("retired_secret_hashes")
          THEN "retired_secret_hashes"
          ELSE array_append("retired_secret_hashes", "previous_secret_hash")
        END,
        "previous_secret_hash" = NULL,
        "previous_secret_expires_at" = NULL,
        "updated_at" = now()
    WHERE "id" = ${clientRowId}::uuid`;
};
