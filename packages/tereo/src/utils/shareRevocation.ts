import type { ShareKind } from "../../prisma/generated/client/index.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";
import {
  bucketEventScope,
  emitTx,
  logAuditTx,
  type AuditLogInput,
} from "./outbox.js";

type Tx = Prisma.TransactionClient;
type Actor = AuditLogInput["auth"];

export interface RevocableShare {
  id: string;
  kind: ShareKind;
  bucket: {
    name: string;
    organizationId: string | null;
    serviceId: string | null;
  };
}

/**
 * Revoke one share, audited and emitted. False when it was already revoked
 * (by a concurrent revoke), which records nothing.
 */
export const revokeShareTx = async (
  tx: Tx,
  auth: Actor,
  share: RevocableShare,
  reason?: string
): Promise<boolean> => {
  if (!(await db.shares.revoke(share.id, auth.userId, tx))) return false;

  const { bucket } = share;
  await logAuditTx(tx, {
    auth,
    organizationId: bucket.organizationId ?? undefined,
    action: "DELETE",
    entityType: "share",
    entityId: share.id,
    metadata: {
      bucketName: bucket.name,
      kind: share.kind,
      ...(reason ? { reason } : {}),
    },
  });

  await emitTx(tx, {
    eventType: "file-service.share.revoked",
    ...bucketEventScope(bucket),
    entityType: "share",
    entityId: share.id,
    data: { bucketName: bucket.name, kind: share.kind },
  });
  return true;
};

/**
 * Revoke the shares `userId` created that still serve, on one bucket or on
 * every bucket of an organization. Returns how many were revoked.
 */
export const revokeCreatorSharesTx = async (
  tx: Tx,
  auth: Actor,
  scope: { userId: string } & (
    { bucketId: number } | { organizationId: string }
  ),
  reason: string
): Promise<number> => {
  const shares = await db.shares.getActiveByCreator(scope, tx);
  let revoked = 0;
  for (const share of shares) {
    if (await revokeShareTx(tx, auth, share, reason)) revoked++;
  }
  return revoked;
};
