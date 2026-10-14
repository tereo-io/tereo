import { getManagedBucket } from "../../../../../../utils/bucketAccess.js";
import { setAccessLog } from "../../../../../../middleware/accessLog.js";
import { emitTx, logAuditTx } from "../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { NotFoundError } from "../../../../../../utils/errors.js";
import { lifecyclePolicyBodySchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import { bucketNameSchema } from "../../schemas.js";
import { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

export const getLifecyclePolicy = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const bucket = await getManagedBucket(auth, name, "read");

  const policy = await db.lifecyclePolicies.getByBucket(bucket.id);
  if (!policy)
    throw new NotFoundError("No lifecycle policy configured for this bucket");

  setAccessLog(res, { bucketId: bucket.id, operation: "GET_LIFECYCLE_POLICY" });
  res.json({
    expireObjectsAfterDays: policy.expireObjectsAfterDays,
    expireVersionsAfterDays: policy.expireVersionsAfterDays,
    purgeSoftDeletedAfterDays: policy.purgeSoftDeletedAfterDays,
    enabled: policy.enabled,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  });
};

export const upsertLifecyclePolicy = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const bucket = await getManagedBucket(auth, name, "write");

  const body = validateBody(lifecyclePolicyBodySchema, req);
  const policy = await db.$transaction(async (tx) => {
    const next = await db.lifecyclePolicies.upsert(
      {
        bucketId: bucket.id,
        expireObjectsAfterDays: body.expireObjectsAfterDays ?? null,
        expireVersionsAfterDays: body.expireVersionsAfterDays ?? null,
        purgeSoftDeletedAfterDays: body.purgeSoftDeletedAfterDays ?? null,
        enabled: body.enabled ?? true,
      },
      tx
    );

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "UPDATE",
      entityType: "lifecyclePolicy",
      entityId: String(bucket.id),
      entityName: bucket.name,
      metadata: {
        bucketName: bucket.name,
        expireObjectsAfterDays: next.expireObjectsAfterDays,
        expireVersionsAfterDays: next.expireVersionsAfterDays,
        purgeSoftDeletedAfterDays: next.purgeSoftDeletedAfterDays,
        enabled: next.enabled,
      },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.lifecycle.policy.updated",
        organizationId: bucket.organizationId,
        entityType: "bucket",
        entityId: String(bucket.id),
        data: {
          bucketId: bucket.id,
          bucketName: bucket.name,
          expireObjectsAfterDays: next.expireObjectsAfterDays,
          expireVersionsAfterDays: next.expireVersionsAfterDays,
          purgeSoftDeletedAfterDays: next.purgeSoftDeletedAfterDays,
          enabled: next.enabled,
        },
      });
    }

    return next;
  });

  setAccessLog(res, {
    bucketId: bucket.id,
    operation: "UPSERT_LIFECYCLE_POLICY",
  });

  res.status(200).json({
    expireObjectsAfterDays: policy.expireObjectsAfterDays,
    expireVersionsAfterDays: policy.expireVersionsAfterDays,
    purgeSoftDeletedAfterDays: policy.purgeSoftDeletedAfterDays,
    enabled: policy.enabled,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  });
};

export const deleteLifecyclePolicy = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const bucket = await getManagedBucket(auth, name, "delete");

  await db.$transaction(async (tx) => {
    const removed = await db.lifecyclePolicies.remove(bucket.id, tx);
    if (!removed) return;

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "DELETE",
      entityType: "lifecyclePolicy",
      entityId: String(bucket.id),
      entityName: bucket.name,
      metadata: { bucketName: bucket.name },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.lifecycle.policy.deleted",
        organizationId: bucket.organizationId,
        entityType: "bucket",
        entityId: String(bucket.id),
        data: { bucketId: bucket.id, bucketName: bucket.name },
      });
    }
  });

  setAccessLog(res, {
    bucketId: bucket.id,
    operation: "DELETE_LIFECYCLE_POLICY",
  });

  res.status(204).send();
};
