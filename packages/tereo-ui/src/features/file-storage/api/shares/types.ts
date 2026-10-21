import type { UserRef } from "@/lib/refs";

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

export interface Share {
  id: string;
  /** Null on list and get unless the caller created the share or can write the bucket. */
  token: string | null;
  bucketId: number;
  kind: ShareKind;
  /** Null whenever `token` is. */
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
  revokedByUser: UserRef | null;
  note: string | null;
  createdByUserId: string | null;
  creator: UserRef | null;
  createdAt: string;
  updatedAt: string;
  status: ShareStatus;
  object: ShareTargetObject | null;
  archiveRequest: ShareTargetArchive | null;
}

/** Create and update responses always carry the token and URL. */
export type RevealedShare = Share & { token: string; url: string };

interface CommonCreateFields {
  password?: string;
  expiresAt?: string;
  maxDownloads?: number;
  urlFilename?: string;
  note?: string;
}

export type CreateObjectShareInput = CommonCreateFields & {
  kind: "OBJECT";
  objectId: string;
  /**
   * When set, the share is pinned to this immutable version. Subsequent
   * uploads to the object don't change what the share serves. Omit to
   * track the current version.
   */
  versionId?: string;
};

export type CreateArchiveShareInput = CommonCreateFields & {
  kind: "ARCHIVE";
  prefix?: string;
  keys?: string[];
  format?: ShareArchiveFormat;
  archiveFilename?: string;
};

export type CreateShareInput = CreateObjectShareInput | CreateArchiveShareInput;

export interface UpdateShareInput {
  password?: string | null;
  expiresAt?: string | null;
  maxDownloads?: number | null;
  urlFilename?: string | null;
  note?: string | null;
}

export interface ListSharesResponse {
  data: Share[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}
