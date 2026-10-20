import { notifyBucketAccessChanged } from "../../../../../../../websocket/emitters/index.js";
import { setAccessLog } from "../../../../../../../middleware/accessLog.js";
import { validateParams } from "../../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../../middleware/auth.js";
import { revokeTx } from "../../../../../../../utils/bucketGrants.js";
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
    if (!(await revokeTx(tx, auth, bucket, permission))) {
      throw new NotFoundError("Permission not found");
    }
  });
  notifyBucketAccessChanged([permission.userId], bucket.name);

  res.status(204).send();
};
