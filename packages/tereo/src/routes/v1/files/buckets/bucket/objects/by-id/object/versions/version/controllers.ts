import { broadcastObjectInvalidate } from "../../../../../../../../../../utils/cacheBroadcast.js";
import { enqueueOrphanBlobCleanupSafe } from "../../../../../../../../../../jobs/index.js";
import { setAccessLog } from "../../../../../../../../../../middleware/accessLog.js";
import { validateUser } from "../../../../../../../../../../middleware/auth.js";
import { NotFoundError } from "../../../../../../../../../../utils/errors.js";
import db from "../../../../../../../../../../utils/db/index.js";
import { byIdVersionParamsSchema } from "./schemas.js";
import env from "../../../../../../../../../../env.js";
import { Request, Response } from "express";
import {
  bucketEventScope,
  logAuditTx,
  emitTx,
} from "../../../../../../../../../../utils/outbox.js";
import {
  prepareDownload,
  queueObjectWriteFollowUps,
  sendBlobBody,
} from "../../../../utils.js";
import {
  getVisibleVersion,
  resolveObjectById,
  serializeVersions,
} from "../utils.js";

/**
 * Download the content bytes for a specific version by id. Unlike the
 * key-addressed `GET /objects/*objectKey?versionId=...`, this path survives
 * renames — a shared "download version X of this object" link stays valid
 * after the object is renamed because identity (id + versionId) is stable.
 *
 * GET /buckets/:name/objects/by-id/:id/versions/:versionId/download
 */
export const downloadObjectVersionById = async (
  req: Request,
  res: Response
) => {
  const { bucket, object, params, history } = await resolveObjectById(
    req,
    "read",
    byIdVersionParamsSchema
  );
  const version = await getVisibleVersion(object.id, params.versionId, history);
  if (!version.contentBlob || version.isDeleteMarker) {
    throw new NotFoundError(
      "Requested version has no retrievable content (delete marker)"
    );
  }
  const etag = version.etag ?? "";
  const handled = prepareDownload(req, res, {
    bucket,
    pinnedVersion: true,
    objectKey: object.objectKey,
    contentType: version.contentType,
    etag,
    lastModified: version.createdAt,
  });
  if (handled) return;

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: "DOWNLOAD_VERSION",
  });

  await sendBlobBody(req, res, version.contentBlob, {
    etag,
    lastModified: version.createdAt,
  });
};

export const getObjectVersionById = async (req: Request, res: Response) => {
  const { bucket, object, params, history } = await resolveObjectById(
    req,
    "read",
    byIdVersionParamsSchema
  );
  const version = await getVisibleVersion(object.id, params.versionId, history);

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: "GET_VERSION",
  });

  const [serialized] = await serializeVersions(req, bucket.name, [version]);
  res.json(serialized);
};

/**
 * Restore a prior (non-current) version as the current version. Creates a NEW
 * version row pointing at the same blob; the previous "current" version stays
 * in history. The new version holds its own ref on the blob. Restoring a
 * version of a deleted object undeletes it.
 */
export const restoreObjectVersionById = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { bucket, object, params } = await resolveObjectById(
    req,
    "write",
    byIdVersionParamsSchema
  );

  const { restored, source, releasedBlobHashes } = await db.$transaction(
    async (tx) => {
      const result = await db.objects.restoreObjectVersion(
        bucket.id,
        params.id,
        params.versionId,
        auth.userId,
        env.FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS,
        tx
      );

      await logAuditTx(tx, {
        auth,
        organizationId: bucket.organizationId ?? undefined,
        action: "CREATE",
        entityType: "objectVersion",
        entityId: result.restored.id,
        entityName: object.objectKey,
        metadata: {
          bucketName: bucket.name,
          objectKey: object.objectKey,
          objectId: params.id,
          restoredFromVersionId: result.source.id,
          undeleted: result.undeleted,
        },
      });

      await emitTx(tx, {
        eventType: "file-service.object.version.restored",
        ...bucketEventScope(bucket),
        entityType: "objectVersion",
        entityId: result.restored.id,
        data: {
          bucketName: bucket.name,
          objectKey: object.objectKey,
          objectId: params.id,
          restoredFromVersionId: result.source.id,
          undeleted: result.undeleted,
        },
      });
      // A restore always replaces the current version, as an upload would;
      // a deleted object reappears.
      await emitTx(tx, {
        eventType: "file-service.object.updated",
        ...bucketEventScope(bucket),
        entityType: "object",
        entityId: params.id,
        data: {
          bucketName: bucket.name,
          objectKey: object.objectKey,
          objectId: params.id,
          contentType:
            result.restored.contentType ?? "application/octet-stream",
          sizeBytes: result.source.contentBlob?.sizeBytes.toString() ?? "0",
          etag: result.restored.etag ?? "",
          tags: result.restored.tags,
          via: "restore",
          restoredFromVersionId: result.source.id,
          undeleted: result.undeleted,
        },
      });

      return result;
    }
  );

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: "RESTORE_VERSION",
  });

  // The restore dropped the replaced content's thumbnails (a delete had
  // already dropped a deleted object's); the restored content gets new ones.
  queueObjectWriteFollowUps(
    bucket,
    object.id,
    restored.contentType ?? "",
    releasedBlobHashes
  );

  await broadcastObjectInvalidate(bucket.name, object.objectKey);

  res.status(201).json({
    versionId: restored.id,
    contentBlobHash: restored.contentBlobHash,
    etag: restored.etag,
    sizeBytes: source.contentBlob?.sizeBytes.toString() ?? null,
    contentType: restored.contentType,
    createdAt: restored.createdAt,
  });
};

/**
 * Soft-delete a non-current version. Drops the version's blob ref; cleanup is
 * picked up by the orphan-blob worker.
 */
export const deleteObjectVersionById = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { bucket, object, params } = await resolveObjectById(
    req,
    "delete",
    byIdVersionParamsSchema
  );

  const version = await db.$transaction(async (tx) => {
    const v = await db.objectVersions.softDeleteVersion(
      bucket.id,
      object.id,
      params.versionId,
      auth.userId,
      tx
    );

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "DELETE",
      entityType: "objectVersion",
      entityId: v.id,
      entityName: object.objectKey,
      metadata: {
        bucketName: bucket.name,
        objectKey: object.objectKey,
        objectId: params.id,
      },
    });

    await emitTx(tx, {
      eventType: "file-service.object.version.deleted",
      ...bucketEventScope(bucket),
      entityType: "objectVersion",
      entityId: v.id,
      data: {
        bucketName: bucket.name,
        objectKey: object.objectKey,
        objectId: params.id,
      },
    });

    return v;
  });

  if (version.contentBlobHash && !version.isDeleteMarker) {
    enqueueOrphanBlobCleanupSafe(version.contentBlobHash);
  }

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: "DELETE_VERSION",
  });

  await broadcastObjectInvalidate(bucket.name, object.objectKey);

  res.status(204).send();
};
