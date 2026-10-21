import { notifyBucketAccessChanged } from "../../../../../../../websocket/emitters/index.js";
import { revokeCreatorSharesTx } from "../../../../../../../utils/shareRevocation.js";
import { revokePermissionQuerySchema, userIdParamSchema } from "./schemas.js";
import { setAccessLog } from "../../../../../../../middleware/accessLog.js";
import { validateUser } from "../../../../../../../middleware/auth.js";
import { revokeTx } from "../../../../../../../utils/bucketGrants.js";
import { NotFoundError } from "../../../../../../../utils/errors.js";
import db from "../../../../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  assertNotDeclaringServiceGrant,
  getManagedBucket,
} from "../../../../../../../utils/bucketAccess.js";
import {
  validateParams,
  validateQuery,
} from "../../../../../../../utils/validateReq.js";

/**
 * Revoke bucket access from a user
 * DELETE /buckets/:name/permissions/:userId[?revokeShares=true]
 */
export const revokePermission = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name, userId } = validateParams(userIdParamSchema, req);
  const { revokeShares } = validateQuery(revokePermissionQuerySchema, req);

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
    if (!(await revokeTx(tx, auth, bucket, permission))) {
      throw new NotFoundError("Permission not found");
    }
    // Shares outlive their creator's access unless asked otherwise.
    if (revokeShares) {
      await revokeCreatorSharesTx(
        tx,
        auth,
        { userId: permission.userId, bucketId: bucket.id },
        "permission_revoked"
      );
    }
  });
  notifyBucketAccessChanged([permission.userId], bucket.name);

  res.status(204).send();
};
