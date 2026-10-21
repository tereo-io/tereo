import { notifyBucketAccessChanged } from "../../../../../../websocket/emitters/index.js";
import { broadcastBucketInvalidate } from "../../../../../../utils/cacheBroadcast.js";
import { assertOwnerTransferable } from "../../../../../../utils/bucketAccess.js";
import { setAccessLog } from "../../../../../../middleware/accessLog.js";
import { canActInOrganization } from "../../../../../../utils/users.js";
import { BadRequestError } from "../../../../../../utils/errors.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { grantTx } from "../../../../../../utils/bucketGrants.js";
import { transferOwnershipBodySchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import { serializeBucket } from "../controllers.js";
import { bucketNameSchema } from "../../schemas.js";
import { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  bucketEventScope,
  emitTx,
  logAuditTx,
} from "../../../../../../utils/outbox.js";

/**
 * Transfer a bucket's ownership (`file-service.admin` only)
 * PUT /buckets/:name/owner
 */
export const transferBucketOwnership = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const body = validateBody(transferOwnershipBodySchema, req);

  const bucket = await db.buckets.getByName(name);
  assertOwnerTransferable(bucket);

  const user = await db.users.getFromBody(body.userId);
  if (!user.isActive) {
    throw new BadRequestError(
      "user_inactive",
      `User ${body.userId} is deactivated`
    );
  }
  if (
    bucket.organizationId &&
    !(await canActInOrganization(body.userId, bucket.organizationId))
  ) {
    throw new BadRequestError(
      "user_not_in_organization",
      `User ${body.userId} is not in the bucket's organization`
    );
  }

  setAccessLog(res, { bucketId: bucket.id, operation: "TRANSFER_OWNERSHIP" });

  const { updated, previousOwnerId, granted } = await db.$transaction(
    async (tx) => {
      const { bucket: next, previousOwnerId } = await db.buckets.setOwner(
        bucket.id,
        body.userId,
        tx
      );

      // The owner manages the bucket only while holding an active grant.
      const existing = await db.bucketPermissions.getByBucketAndUser(
        bucket.id,
        body.userId,
        tx
      );
      const granted =
        !existing || existing.revokedAt
          ? await grantTx(
              tx,
              auth,
              next,
              body.userId,
              { canRead: true, canWrite: true, canDelete: true },
              existing
            )
          : null;

      if (previousOwnerId !== next.ownerId) {
        await logAuditTx(tx, {
          auth,
          organizationId: next.organizationId ?? undefined,
          action: "UPDATE",
          entityType: "bucket",
          entityId: String(next.id),
          entityName: next.name,
          changes: { ownerId: { old: previousOwnerId, new: next.ownerId } },
          metadata: { bucketName: next.name },
        });

        await emitTx(tx, {
          eventType: "file-service.bucket.owner-changed",
          ...bucketEventScope(next),
          entityType: "bucket",
          entityId: String(next.id),
          data: {
            bucketName: next.name,
            ownerId: next.ownerId,
            previousOwnerId,
          },
        });
      }

      return { updated: next, previousOwnerId, granted };
    }
  );

  if (previousOwnerId !== updated.ownerId || granted) {
    notifyBucketAccessChanged([previousOwnerId, updated.ownerId], updated.name);
    await broadcastBucketInvalidate(updated.name);
  }

  res.json(serializeBucket(updated));
};
