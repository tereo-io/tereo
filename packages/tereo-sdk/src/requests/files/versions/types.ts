import { FileServiceObjectMetadata } from "../objects/types.js";
import type { UserRef } from "../../refs.js";

export interface ObjectVersion {
  versionId: string;
  contentBlobHash: string | null;
  etag: string | null;
  sizeBytes: string | null;
  contentType: string | null;
  metadata: FileServiceObjectMetadata | null;
  tags: string[];
  isCurrent: boolean;
  isDeleteMarker: boolean;
  restoredFromVersionId: string | null;
  createdAt: string;
  createdBy: string;
  /**
   * The writer, by email and name. All three are `null` for a caller served
   * only because the bucket is public, and when the user no longer resolves.
   */
  createdByEmail: string | null;
  createdByName: string | null;
  creator: UserRef | null;
}

export interface ListObjectVersionsOptions {
  limit?: number;
  cursor?: string;
}

export interface ListObjectVersionsResponse {
  data: ObjectVersion[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

export interface RestoreObjectVersionResponse {
  versionId: string;
  contentBlobHash: string | null;
  etag: string | null;
  sizeBytes: string | null;
  contentType: string | null;
  createdAt: string;
}
