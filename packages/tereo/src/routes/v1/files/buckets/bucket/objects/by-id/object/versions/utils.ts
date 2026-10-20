import { isBucketReader } from "../../../../../../../../../utils/bucketAccess.js";
import { validateParams } from "../../../../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../../../../middleware/auth.js";
import { withUserRefs } from "../../../../../../../../../utils/users.js";
import db from "../../../../../../../../../utils/db/index.js";
import { seesBucketHistory } from "../../../utils.js";
import { Request } from "express";
import { z } from "zod";
import type {
  ContentBlob,
  ObjectVersion,
} from "../../../../../../../../../../prisma/generated/client/index.d.js";
import {
  getAccessibleBucket,
  getReadableBucket,
} from "../../../../../../../../../utils/bucketAccess.js";
import {
  BadRequestError,
  NotFoundError,
} from "../../../../../../../../../utils/errors.js";

/**
 * Resolve (bucket, object) for any by-id versions route. Enforces access,
 * then checks versioning-enabled, then looks up the object by UUID `id`
 * scoped to the bucket. `schema` lets callers pick the right params shape —
 * the list route has no `:versionId`, so validating with the full schema
 * would 400.
 *
 * For versioned buckets, the lookup tolerates `deletedAt IS NOT NULL` Objects
 * so that version history is still visible after a DELETE has inserted a
 * delete-marker (the Object row is soft-deleted in that flow).
 */
export async function resolveObjectById<T extends { name: string; id: string }>(
  req: Request,
  operation: "read" | "write" | "delete",
  schema: z.ZodType<T>
) {
  const params = validateParams(schema, req);

  // Access first: the versioning setting is not for callers who can't see
  // the bucket.
  const bucket =
    operation === "read"
      ? await getReadableBucket(req, params.name)
      : await getAccessibleBucket(validateUser(req), params.name, operation);
  if (!bucket.versioningEnabled) {
    throw new BadRequestError(
      "versioning_disabled",
      "Versioning is not enabled for this bucket"
    );
  }
  // A versioned bucket's DELETE soft-deletes the Object row and inserts a
  // delete marker; its history stays readable by id, to those who see the
  // bucket's history.
  const history =
    operation !== "read" || (await seesBucketHistory(req, bucket));
  const object = history
    ? await db.objects.getByIdIncludingDeleted(bucket.id, params.id)
    : await db.objects.getById(bucket.id, params.id);
  return { bucket, object, params, history };
}

/** A version, unless it is history the caller does not see. */
export async function getVisibleVersion(
  objectId: string,
  versionId: string,
  history: boolean
) {
  const version = await db.objectVersions.getByVersionId(objectId, versionId);
  if (!history && !version.isCurrent) {
    throw new NotFoundError("Version not found");
  }
  return version;
}

/**
 * Versions as the list and the detail return them. Who wrote each is named
 * only to readers of the bucket: writers' ids, emails and names are not for
 * the public a public bucket is served to.
 */
export async function serializeVersions(
  req: Request,
  bucketName: string,
  versions: (ObjectVersion & { contentBlob: ContentBlob | null })[]
) {
  const reader = await isBucketReader(req, bucketName);
  const named = reader
    ? await withUserRefs(versions, { creator: "createdBy" })
    : versions.map((v) => ({ ...v, creator: null }));
  return named.map((v) => ({
    versionId: v.id,
    contentBlobHash: v.contentBlobHash,
    etag: v.etag,
    sizeBytes: v.contentBlob?.sizeBytes.toString() ?? null,
    contentType: v.contentType,
    metadata: v.metadata,
    tags: v.tags,
    isCurrent: v.isCurrent,
    isDeleteMarker: v.isDeleteMarker,
    restoredFromVersionId: v.restoredFromVersionId,
    createdAt: v.createdAt,
    createdBy: reader ? v.createdBy : null,
    createdByEmail: v.creator?.email ?? null,
    createdByName: v.creator?.name ?? null,
    creator: v.creator,
  }));
}
