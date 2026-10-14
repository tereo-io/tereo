import { setAccessLog } from "../../../../../../../middleware/accessLog.js";
import { validateParams } from "../../../../../../../utils/validateReq.js";
import { emitTx, logAuditTx } from "../../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../../middleware/auth.js";
import { NotFoundError } from "../../../../../../../utils/errors.js";
import db from "../../../../../../../utils/db/index.js";
import { userIdParamSchema } from "./schemas.js";
import { Request, Response } from "express";
import {
  assertNotDeclaringServiceGrant,
  getManagedBucket,
} from "../../../../../../../utils/bucketAccess.js";

/**
 * Revoke bucket access from a user
 * DELETE /buckets/:name/permissions/:userId
 */
export const revokePermission = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name, userId } = validateParams(userIdParamSchema, req);

  const bucket = await getManagedBucket(auth, name, "delete");
  setAccessLog(res, { bucketId: bucket.id, operation: "REVOKE_PERMISSION" });

  const permission = await db.bucketPermissions.getByBucketAndUser(
    bucket.id,
    userId
  );
  if (!permission || permission.revokedAt) {
    throw new NotFoundError("Permission not found");
  }
  assertNotDeclaringServiceGrant(bucket, permission.userId);

  await db.$transaction(async (tx) => {
    if (!(await db.bucketPermissions.revoke(permission.id, auth.userId, tx))) {
      throw new NotFoundError("Permission not found");
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
      },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.permission.revoked",
        organizationId: bucket.organizationId,
        entityType: "bucketPermission",
        entityId: String(permission.id),
        data: {
          bucketName: bucket.name,
          userId: permission.userId,
          revokedBy: auth.userId,
        },
      });
    }
  });

  res.status(204).send();
};
