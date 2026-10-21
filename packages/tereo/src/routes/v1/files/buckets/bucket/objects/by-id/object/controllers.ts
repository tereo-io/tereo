import { broadcastObjectInvalidate } from "../../../../../../../../utils/cacheBroadcast.js";
import { enqueueOrphanBlobCleanupSafe } from "../../../../../../../../jobs/index.js";
import { setAccessLog } from "../../../../../../../../middleware/accessLog.js";
import { assertObjectKeyNotReserved, serializeObject } from "../../utils.js";
import { logAuditTx, emitTx } from "../../../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../../../middleware/auth.js";
import { byIdParamsSchema, patchObjectBodySchema } from "./schemas.js";
import db from "../../../../../../../../utils/db/index.js";
import { emitVersionCreatedTx } from "../../events.js";
import { Request, Response } from "express";
import {
  getAccessibleBucket,
  getReadableBucket,
  validateBucketPermission,
} from "../../../../../../../../utils/bucketAccess.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../../../utils/validateReq.js";
import {
  BadRequestError,
  NotFoundError,
} from "../../../../../../../../utils/errors.js";

/**
 * GET /buckets/:name/objects/by-id/:id
 * Returns the object's metadata — same shape as the upload/list responses.
 */
export const getObjectById = async (req: Request, res: Response) => {
  const params = validateParams(byIdParamsSchema, req);

  const bucket = await getReadableBucket(req, params.name);

  const object = await db.objects.getById(bucket.id, params.id);

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: "GET_OBJECT_METADATA",
  });

  res.json(serializeObject(object));
};

/**
 * DELETE /buckets/:name/objects/by-id/:id
 * Soft-deletes the object. In versioned buckets, inserts a delete-marker
 * as the new current version. Returns 204.
 */
export const deleteObjectById = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(byIdParamsSchema, req);

  const bucket = await getAccessibleBucket(auth, params.name, "delete");

  const deleted = await db.$transaction(async (tx) => {
    const result = await db.objects.removeObjectById(
      bucket.id,
      params.id,
      auth.userId,
      tx
    );

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "DELETE",
      entityType: "object",
      entityId: String(result.id),
      entityName: result.objectKey,
      metadata: {
        bucketName: bucket.name,
        objectKey: result.objectKey,
        objectId: params.id,
        versionedTombstone: result.versioningEnabled,
      },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.object.deleted",
        organizationId: bucket.organizationId,
        entityType: "object",
        entityId: String(result.id),
        data: {
          bucketName: bucket.name,
          objectKey: result.objectKey,
          objectId: params.id,
          versionedTombstone: result.versioningEnabled,
        },
      });
    }

    return result;
  });

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: deleted.id,
    operation: "DELETE_OBJECT",
  });

  for (const hash of deleted.releasedBlobHashes) {
    enqueueOrphanBlobCleanupSafe(hash);
  }

  await broadcastObjectInvalidate(bucket.name, deleted.objectKey);

  res.status(204).send();
};

/**
 * PATCH /buckets/:name/objects/by-id/:id
 * Rename (change `objectKey`) and/or update metadata / tags / contentType of
 * the current version in place. Because identity is stable, URLs and IDs held
 * by callers stay valid after a rename.
 */
export const patchObject = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(byIdParamsSchema, req);
  const body = validateBody(patchObjectBodySchema, req);
  // Access first, so a caller without it learns nothing about the key.
  const bucket = await getAccessibleBucket(auth, params.name, "write");
  // A set `deleteAfter` has the lifecycle sweep delete the object later, so it
  // takes delete access; clearing it needs only write.
  if (body.deleteAfter) {
    await validateBucketPermission(auth, params.name, "delete");
  }
  if (body.objectKey !== undefined) {
    assertObjectKeyNotReserved(body.objectKey);
  }

  const metadataChanged =
    body.contentType !== undefined ||
    body.metadata !== undefined ||
    body.tags !== undefined;
  const { object, renamed, previousKey } = await db.$transaction(async (tx) => {
    // The current version is read under the object's lock, so an upload
    // committed since the request arrived can't leave this edit on a version
    // that is no longer current (or, unversioned, no longer exists).
    const locked = await db.objects.checkByIdForUpdate(
      bucket.id,
      params.id,
      tx
    );
    if (!locked) throw new NotFoundError("Object not found");
    const previousKey = locked.objectKey;
    const current = metadataChanged
      ? await db.objectVersions.getCurrent(locked.id, tx)
      : null;
    if (metadataChanged && !current) {
      throw new BadRequestError(
        "no_current_version",
        "Object has no current version to patch"
      );
    }

    let renamedRes: { previousKey: string; newKey: string } | null = null;
    if (body.objectKey !== undefined && body.objectKey !== previousKey) {
      const r = await db.objects.renameObject(
        bucket.id,
        params.id,
        body.objectKey,
        auth.userId,
        tx
      );
      renamedRes = { previousKey: r.previousKey, newKey: r.newKey };
    }

    if (body.deleteAfter !== undefined) {
      await db.objects.updateDeleteAfter(params.id, body.deleteAfter, tx);
    }

    // `createNewVersion` only has an effect on versioning-enabled buckets
    // (read under the bucket's lock); elsewhere the edit is made in place, so
    // callers can pass it unconditionally.
    let branchVersion = false;
    if (current) {
      if (body.createNewVersion === true) {
        branchVersion = await db.objects.branchCurrentVersion(
          bucket.id,
          params.id,
          {
            contentType: body.contentType,
            metadata: body.metadata as never,
            tags: body.tags,
            createdBy: auth.userId,
          },
          tx
        );
      }
      if (!branchVersion) {
        await db.objectVersions.updateCurrentMetadata(
          current.id,
          {
            contentType: body.contentType,
            metadata: body.metadata as never,
            tags: body.tags,
          },
          tx
        );
      }
    }

    const refreshed = await db.objects.getById(bucket.id, params.id, tx);

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "UPDATE",
      entityType: "object",
      entityId: String(refreshed.id),
      entityName: refreshed.objectKey,
      metadata: {
        bucketName: bucket.name,
        objectId: params.id,
        renamed: renamedRes,
        branchedVersion: branchVersion,
        changedFields: Object.keys(body).filter(
          (k) => k !== "createNewVersion"
        ),
      },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.object.updated",
        organizationId: bucket.organizationId,
        entityType: "object",
        entityId: String(refreshed.id),
        data: {
          bucketName: bucket.name,
          objectKey: refreshed.objectKey,
          objectId: params.id,
          renamed: renamedRes,
          branchedVersion: branchVersion,
        },
      });
    }

    if (branchVersion) {
      await emitVersionCreatedTx(tx, bucket, refreshed, "metadata");
    }

    return { object: refreshed, renamed: renamedRes, previousKey };
  });

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: "UPDATE_OBJECT",
  });

  // Invalidate both the old and new keys (if renamed) so cached metadata on
  // either addressing path is dropped.
  await broadcastObjectInvalidate(bucket.name, previousKey);
  if (renamed) await broadcastObjectInvalidate(bucket.name, renamed.newKey);

  res.json(serializeObject(object));
};
