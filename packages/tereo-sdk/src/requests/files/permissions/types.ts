import type { UserRef } from "../../refs.js";

/**
 * A bucket-level permission grant, as `GET /buckets/:name/permissions` lists
 * it and `POST /buckets/:name/permissions` returns it: the grantee and the
 * granter named.
 */
export interface BucketPermission {
  /** Internal numeric permission record id. */
  id: number;
  /** User id of the grantee. */
  userId: string;
  /** Email of the grantee. */
  userEmail: string | null;
  /** Display name of the grantee. */
  userName: string | null;
  /** The user `userId` names. */
  user: UserRef | null;
  /** Read permission flag. */
  canRead: boolean;
  /** Write (upload) permission flag. */
  canWrite: boolean;
  /** Delete permission flag. */
  canDelete: boolean;
  /** ISO timestamp when the permission was granted. */
  grantedAt: string;
  /** User id of the grantor. */
  grantedBy: string;
  /** Email of the grantor. */
  grantedByEmail: string | null;
  /** Display name of the grantor. */
  grantedByName: string | null;
  /** The user `grantedBy` names. */
  granter: UserRef | null;
}

export interface ListBucketPermissionsOptions {
  limit?: number;
  cursor?: string;
  sort?: "userId" | "grantedAt";
  sortDir?: "asc" | "desc";
}

export interface ListBucketPermissionsResponse {
  data: BucketPermission[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

export interface GrantBucketPermissionInput {
  /** User id to grant the permission to. */
  userId: string;
  canRead?: boolean;
  canWrite?: boolean;
  canDelete?: boolean;
}
