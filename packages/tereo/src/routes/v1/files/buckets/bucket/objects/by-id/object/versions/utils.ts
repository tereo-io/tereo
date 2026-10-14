import { isBucketReader } from "../../../../../../../../../utils/bucketAccess.js";
import { validateParams } from "../../../../../../../../../utils/validateReq.js";
import { BadRequestError } from "../../../../../../../../../utils/errors.js";
import { validateUser } from "../../../../../../../../../middleware/auth.js";
import { withUserRefs } from "../../../../../../../../../utils/users.js";
import db from "../../../../../../../../../utils/db/index.js";
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
  // Include soft-deleted objects — a versioned bucket's DELETE soft-deletes
  // the Object row + inserts a delete-marker; version history must remain
  // visible via the by-id route.
  const object = await db.objects.getByIdIncludingDeleted(bucket.id, params.id);
  return { bucket, object, params };
}

/**
 * Versions as the list and the detail return them. Who wrote each is named
 * only to readers of the bucket: writers' emails and names are not for the
 * public a public bucket is served to.
 */
export async function serializeVersions(
  req: Request,
  bucketName: string,
  versions: (ObjectVersion & { contentBlob: ContentBlob | null })[]
) {
  const named = (await isBucketReader(req, bucketName))
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
    createdBy: v.createdBy,
    createdByEmail: v.creator?.email ?? null,
    createdByName: v.creator?.name ?? null,
    creator: v.creator,
  }));
}
