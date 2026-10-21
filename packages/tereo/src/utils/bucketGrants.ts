import type { BucketPermission } from "../../prisma/generated/client/index.js";
import type { Prisma } from "./db/prisma.js";
import { ConflictError } from "./errors.js";
import db from "./db/index.js";
import {
  bucketEventScope,
  emitTx,
  logAuditTx,
  type AuditLogInput,
} from "./outbox.js";

type Tx = Prisma.TransactionClient;
type Actor = AuditLogInput["auth"];
type GrantedBucket = {
  id: number;
  name: string;
  organizationId: string | null;
  serviceId: string | null;
};

export interface GrantFlags {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
}

/**
 * Give `userId` a grant on the bucket, reviving their revoked row if they
 * have one, audited and emitted. 409 when they already hold an active grant
 * (`existing` is what the caller read before the transaction).
 */
export const grantTx = async (
  tx: Tx,
  auth: Actor,
  bucket: GrantedBucket,
  userId: string,
  flags: GrantFlags,
  existing: BucketPermission | null
): Promise<BucketPermission> => {
  if (existing && !existing.revokedAt) {
    throw new ConflictError("Permission already exists for this user");
  }
  let p: BucketPermission | null;
  if (existing) {
    p = await db.bucketPermissions.unrevoke(
      existing.id,
      { ...flags, grantedBy: auth.userId },
      tx
    );
    if (!p) throw new ConflictError("Permission already exists for this user");
  } else {
    p = await db.bucketPermissions.create(
      { bucketId: bucket.id, userId, ...flags, grantedBy: auth.userId },
      tx
    );
  }

  await logAuditTx(tx, {
    auth,
    organizationId: bucket.organizationId ?? undefined,
    action: "CREATE",
    entityType: "bucketPermission",
    entityId: String(p.id),
    entityName: `${bucket.name}:${p.userId}`,
    metadata: {
      bucketName: bucket.name,
      targetUserId: p.userId,
      canRead: p.canRead,
      canWrite: p.canWrite,
      canDelete: p.canDelete,
    },
  });

  await emitTx(tx, {
    eventType: "file-service.permission.granted",
    ...bucketEventScope(bucket),
    entityType: "bucketPermission",
    entityId: String(p.id),
    data: {
      bucketName: bucket.name,
      userId: p.userId,
      canRead: p.canRead,
      canWrite: p.canWrite,
      canDelete: p.canDelete,
      grantedBy: p.grantedBy,
    },
  });

  return p;
};

/**
 * Revoke one grant, audited and emitted. False when it was already revoked
 * (by a concurrent revoke), which records nothing.
 */
export const revokeTx = async (
  tx: Tx,
  auth: Actor,
  bucket: GrantedBucket,
  permission: Pick<BucketPermission, "id" | "userId">,
  reason?: string
): Promise<boolean> => {
  if (!(await db.bucketPermissions.revoke(permission.id, auth.userId, tx))) {
    return false;
  }

  await logAuditTx(tx, {
    auth,
    organizationId: bucket.organizationId ?? undefined,
    action: "DELETE",
    entityType: "bucketPermission",
    entityId: String(permission.id),
    entityName: `${bucket.name}:${permission.userId}`,
    metadata: {
      bucketName: bucket.name,
      targetUserId: permission.userId,
      ...(reason ? { reason } : {}),
    },
  });

  await emitTx(tx, {
    eventType: "file-service.permission.revoked",
    ...bucketEventScope(bucket),
    entityType: "bucketPermission",
    entityId: String(permission.id),
    data: {
      bucketName: bucket.name,
      userId: permission.userId,
      revokedBy: auth.userId,
    },
  });
  return true;
};

/**
 * Revoke every active grant `userId` holds on the organization's buckets —
 * a grant there could only be used from a token for that organization.
 * Returns the names of the buckets whose grant was revoked.
 */
export const revokeOrganizationGrantsTx = async (
  tx: Tx,
  auth: Actor,
  organizationId: string,
  userId: string
): Promise<string[]> => {
  const grants = await db.bucketPermissions.getActiveInOrganization(
    organizationId,
    userId,
    tx
  );
  const revoked: string[] = [];
  for (const grant of grants) {
    if (
      await revokeTx(
        tx,
        auth,
        grant.bucket,
        grant,
        "organization_member_removed"
      )
    ) {
      revoked.push(grant.bucket.name);
    }
  }
  return revoked;
};
