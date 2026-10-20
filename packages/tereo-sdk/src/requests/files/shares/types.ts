import type { UserRef } from "../../refs.js";

export type ShareKind = "OBJECT" | "ARCHIVE";
export type ShareStatus =
  "active" | "revoked" | "creator_inactive" | "expired" | "exhausted";
export type ShareArchiveFormat = "zip" | "tar";

export interface ShareTargetObject {
  id: string;
  objectKey: string;
}

export interface ShareTargetArchive {
  id: string;
  prefix: string | null;
  format: ShareArchiveFormat;
  filename: string;
  objectCount: number;
  totalSizeBytes: string;
  expiresAt: string;
}

/**
 * The canonical Share DTO returned by every CRUD endpoint. `url` is the
 * public share link — what you hand to a recipient — and already includes
 * the cosmetic `urlFilename` suffix when set.
 */
export interface Share {
  id: string;
  /**
   * `null` on list and get unless the caller created the share or can write
   * its bucket; create and update always return it.
   */
  token: string | null;
  bucketId: number;
  kind: ShareKind;
  /** `null` whenever `token` is. */
  url: string | null;
  urlFilename: string | null;
  objectId: string | null;
  versionId: string | null;
  archiveRequestId: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  revokedAt: string | null;
  revokedByUserId: string | null;
  /** The user `revokedByUserId` names; `null` while the share is not revoked. */
  revokedByUser: UserRef | null;
  note: string | null;
  createdByUserId: string | null;
  /** The user `createdByUserId` names. */
  creator: UserRef;
  createdAt: string;
  updatedAt: string;
  status: ShareStatus;
  object: ShareTargetObject | null;
  archiveRequest: ShareTargetArchive | null;
}

interface CommonCreateShareFields {
  password?: string;
  expiresAt?: string | Date;
  maxDownloads?: number;
  urlFilename?: string;
  note?: string;
}

export interface CreateObjectShareInput extends CommonCreateShareFields {
  kind: "OBJECT";
  objectId: string;
  /** Optional version pin. When omitted, the share tracks the current version. */
  versionId?: string;
}

export interface CreateArchiveShareInput extends CommonCreateShareFields {
  kind: "ARCHIVE";
  prefix?: string;
  keys?: string[];
  format?: ShareArchiveFormat;
  archiveFilename?: string;
}

export type CreateShareInput = CreateObjectShareInput | CreateArchiveShareInput;

export interface UpdateShareInput {
  /** `null` clears the password, a string sets it, omission leaves it unchanged. */
  password?: string | null;
  expiresAt?: string | Date | null;
  maxDownloads?: number | null;
  urlFilename?: string | null;
  note?: string | null;
}

export interface ListSharesOptions {
  limit?: number;
  cursor?: string;
  sort?: "createdAt" | "expiresAt" | "downloadCount";
  sortDir?: "asc" | "desc";
  [key: `filter[${string}]`]: string | undefined;
}

export interface ListSharesResponse {
  data: Share[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}
