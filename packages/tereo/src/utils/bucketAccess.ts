import { ForbiddenError, NotFoundError, ConflictError } from "./errors.js";
import { validateUser, type AuthContext } from "../middleware/auth.js";
import { hasPermission } from "./permissions.js";
import { lockRegistries } from "./registry.js";
import type { Prisma } from "./db/prisma.js";
import type { Request } from "express";
import db from "./db/index.js";

/**
 * A bucket its service no longer declares is read-only, for everyone:
 * nothing new is written into it. Reads, downloads, shares and deletes go on.
 */
export const assertBucketWritable = (bucket: {
  name: string;
  retiredAt: Date | null;
}) => {
  if (bucket.retiredAt) {
    throw new ConflictError(
      `Bucket "${bucket.name}" is retired: its service no longer declares it, so it is read-only`,
      "bucket_retired"
    );
  }
};

/**
 * Object access: `file-service.admin`, or the role permission plus an active
 * grant on the bucket (reads of a public bucket need neither). A missing
 * bucket is refused like an inaccessible one, so a caller without access
 * can't tell the two apart. A retired bucket refuses writes (409) only after
 * the permission check has passed.
 */
export const validateBucketAccess = async (
  auth: AuthContext,
  bucketName: string,
  operation: "read" | "write" | "delete"
) => {
  await validateBucketPermission(auth, bucketName, operation);
  if (operation === "write") {
    const bucket = await db.buckets.checkByName(bucketName);
    if (bucket) assertBucketWritable(bucket);
  }
};

/**
 * `validateBucketAccess` without the retired-bucket guard, for checks that
 * put nothing into the bucket (editing a share, aborting an upload).
 */
export const validateBucketPermission = async (
  auth: AuthContext,
  bucketName: string,
  operation: "read" | "write" | "delete"
) => {
  const hasAccess = await checkBucketAccess(auth, bucketName, operation);
  if (hasAccess) return;
  throw new ForbiddenError(`Insufficient permissions to ${operation} bucket`);
};

/**
 * Checks object access, then loads the bucket, so the 404 for a missing
 * bucket reaches only callers who could see it (admins); everyone else gets
 * the same 403 as for a bucket they can't access.
 */
export const getAccessibleBucket = async (
  auth: AuthContext,
  bucketName: string,
  operation: "read" | "write" | "delete"
) => {
  await validateBucketAccess(auth, bucketName, operation);
  return await db.buckets.getByName(bucketName);
};

/**
 * `getAccessibleBucket` without the public-bucket shortcut: managing shares
 * takes a grant (or `file-service.admin`) even where anyone may download.
 */
export const getGrantedBucket = async (
  auth: AuthContext,
  bucketName: string,
  operation: "read" | "write" | "delete"
) => {
  if (!(await checkBucketAccess(auth, bucketName, operation, false))) {
    throw new ForbiddenError(`Insufficient permissions to ${operation} bucket`);
  }
  return await db.buckets.getByName(bucketName);
};

/**
 * For the read routes admitted without a token: a public bucket is served to
 * anyone. Otherwise — private or missing alike — the caller needs a token
 * (401) and then read access (403).
 */
export const getReadableBucket = async (req: Request, bucketName: string) => {
  const bucket = await db.buckets.checkByName(bucketName);
  if (bucket?.policy === "public") return bucket;
  return await getAccessibleBucket(validateUser(req), bucketName, "read");
};

/**
 * Whether an authenticated caller could read the bucket — false for anyone
 * served only because it is public (anonymous, another organization).
 */
export const isBucketReader = async (req: Request, bucketName: string) =>
  !!req.auth && (await checkBucketAccess(req.auth, bucketName, "read"));

/** The part of a caller that bucket access depends on. */
export type BucketAccessor = Pick<
  AuthContext,
  "userId" | "permissions" | "organizationId"
>;

/** Whether `auth` could download from the bucket; false for a missing one. */
export const canReadBucket = (auth: BucketAccessor, bucketName: string) =>
  checkBucketAccess(auth, bucketName, "read");

/** Whether `auth` holds write access to the bucket; false for a missing one. */
export const canWriteBucket = (auth: BucketAccessor, bucketName: string) =>
  checkBucketAccess(auth, bucketName, "write");

const checkBucketAccess = async (
  auth: BucketAccessor,
  bucketName: string,
  operation: "read" | "write" | "delete",
  publicReads = true
): Promise<boolean> => {
  if (hasPermission(auth.permissions, "file-service.admin")) return true;

  const bucket = await db.buckets.checkByName(bucketName);
  if (!bucket) return false;

  // Organization isolation: deny access to buckets belonging to other orgs
  if (bucket.organizationId && auth.organizationId !== bucket.organizationId) {
    return false;
  }

  if (publicReads && bucket.policy === "public" && operation === "read") {
    return true;
  }
  if (!hasPermission(auth.permissions, `file-service.objects.${operation}`)) {
    return false;
  }

  const bucketPerm = await db.bucketPermissions.getByBucketAndUser(
    bucket.id,
    auth.userId
  );
  if (!bucketPerm || bucketPerm.revokedAt) return false;

  return operation === "read"
    ? bucketPerm.canRead
    : operation === "write"
      ? bucketPerm.canWrite
      : bucketPerm.canDelete;
};

/**
 * Require the caller to be the user who initiated a multipart upload (or an
 * admin). Called after the bucket access check on part upload,
 * complete, and abort so a second user with bucket write permission can't
 * hijack an in-flight upload belonging to someone else.
 */
export const validateMultipartOwnership = (
  auth: AuthContext,
  uploadCreatedBy: string
) => {
  if (uploadCreatedBy === auth.userId) return;
  if (hasPermission(auth.permissions, "file-service.admin")) return;
  throw new ForbiddenError(
    "Only the user who initiated this multipart upload can modify it"
  );
};

/**
 * A multipart upload is reached through its bucket's URL. Access is checked on
 * that bucket first, so a caller without it gets 403 whatever the upload id;
 * an upload that belongs to another bucket is then a 404.
 */
export const assertUploadInBucket = (
  upload: { bucketId: number },
  bucket: { id: number }
) => {
  if (upload.bucketId !== bucket.id) {
    throw new NotFoundError("Multipart upload not found in this bucket");
  }
};

/**
 * Settings, grants and deletion: a `file-service.admin` holder on any bucket,
 * or the bucket's owner while they hold an active grant on it — so an owner
 * whose grant was revoked can't grant it back. Reading the settings takes any
 * active grant. What a declaration owns is guarded separately
 * (`assertBucketDeletable`, `assertDeclaredFieldsUnchanged`).
 */
export const validateBucketManagement = async (
  auth: AuthContext,
  bucketName: string,
  operation: "read" | "write" | "delete"
) => {
  const hasAccess = await checkBucketManagement(auth, bucketName, operation);
  if (hasAccess) return;
  throw new ForbiddenError(`Insufficient permissions to ${operation} bucket`);
};

/** `validateBucketManagement`, then the bucket — see `getAccessibleBucket`. */
export const getManagedBucket = async (
  auth: AuthContext,
  bucketName: string,
  operation: "read" | "write" | "delete"
) => {
  await validateBucketManagement(auth, bucketName, operation);
  return await db.buckets.getByName(bucketName);
};

const checkBucketManagement = async (
  auth: AuthContext,
  bucketName: string,
  operation: "read" | "write" | "delete"
): Promise<boolean> => {
  if (!hasPermission(auth.permissions, `file-service.buckets.${operation}`)) {
    return false;
  }
  if (hasPermission(auth.permissions, "file-service.admin")) return true;

  const bucket = await db.buckets.checkByName(bucketName);
  if (!bucket) return false;

  if (bucket.organizationId && auth.organizationId !== bucket.organizationId) {
    return false;
  }

  const grant = await db.bucketPermissions.getByBucketAndUser(
    bucket.id,
    auth.userId
  );
  if (!grant || grant.revokedAt) return false;

  // Reading a bucket's settings follows the bucket list: any active grant.
  return operation === "read" || bucket.ownerId === auth.userId;
};

const declaredConflict = (bucketName: string, what: string) =>
  new ConflictError(
    `Bucket "${bucketName}" is declared by a service, which owns ${what}`,
    "bucket_declared"
  );

/**
 * A declared bucket exists for as long as its service declares it: it can be
 * deleted once retired, or once its service is deactivated. Checked under the
 * service's registry lock, so a declaration applied at the same moment can't
 * bring it back between the check and the delete. In the delete's transaction.
 */
export const assertBucketDeletable = async (
  bucket: { id: number; name: string; serviceId: string | null },
  tx: Prisma.TransactionClient
) => {
  if (!bucket.serviceId) return;
  await lockRegistries(tx, [bucket.serviceId]);
  const row = await tx.bucket.findUnique({
    where: { id: bucket.id },
    select: { retiredAt: true, service: { select: { isActive: true } } },
  });
  if (row && (row.retiredAt || row.service?.isActive === false)) return;
  throw declaredConflict(
    bucket.name,
    "its existence: it cannot be deleted while declared"
  );
};

/**
 * Refuses edits the next declaration would silently undo: the declaration
 * re-applies a bucket's description, and its service's grant on it.
 */
export const assertDeclaredFieldsUnchanged = (
  bucket: {
    name: string;
    serviceId: string | null;
    description: string | null;
  },
  change: { description?: string }
) => {
  if (!bucket.serviceId) return;
  if (
    change.description !== undefined &&
    change.description !== bucket.description
  ) {
    throw declaredConflict(bucket.name, "its description");
  }
};

export const assertNotDeclaringServiceGrant = (
  bucket: { name: string; serviceId: string | null; ownerId: string },
  grantUserId: string
) => {
  if (bucket.serviceId && grantUserId === bucket.ownerId) {
    throw declaredConflict(bucket.name, "its own grant on it");
  }
};

/** A declared bucket's owner is its service's account, set by the declaration. */
export const assertOwnerTransferable = (bucket: {
  name: string;
  serviceId: string | null;
}) => {
  if (bucket.serviceId) {
    throw declaredConflict(bucket.name, "its ownership");
  }
};
