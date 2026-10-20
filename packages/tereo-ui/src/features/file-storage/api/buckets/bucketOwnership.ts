import type { Bucket } from "./types";

/**
 * Whether core accepts bucket-management calls (PUT `/buckets/:name`, CORS,
 * rate limit, grant/revoke) from this user: a `file-service.admin` holder on
 * any bucket, otherwise only its owner, and only while they hold an active
 * grant on it (which this can't see: core answers 403 without one). On a
 * declared bucket core still refuses a changed description and revoking the
 * declaring service's grant.
 */
export const canManageBucket = (
  bucket: Bucket | undefined,
  userId: string | undefined,
  isAdmin: boolean
): boolean => {
  if (!bucket) return false;
  if (isAdmin) return true;
  return bucket.ownerId === userId;
};

/** No one deletes a declared bucket: it exists while its service declares it. */
export const canDeleteBucket = (
  bucket: Bucket | undefined,
  userId: string | undefined,
  isAdmin: boolean
): boolean =>
  !!bucket && !bucket.serviceId && canManageBucket(bucket, userId, isAdmin);

/** The declaring service's own grant, which every changed declaration re-applies. */
export const isDeclaringServiceGrant = (
  bucket: Bucket | undefined,
  grantUserId: string
): boolean => !!bucket?.serviceId && bucket.ownerId === grantUserId;

/** A retired bucket rejects writes (`409 bucket_retired`). */
export const isBucketRetired = (bucket: Bucket | undefined): boolean =>
  !!bucket?.retiredAt;

/** A bucket a service declared by provisioning. */
export const isDeclaredBucket = (bucket: Bucket | undefined): boolean =>
  !!bucket?.serviceId;
