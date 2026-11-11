import { createDiskBlobStore } from "./disk.js";
import type { BlobStore } from "./types.js";
import env from "../../env.js";

export type {
  BlobListCursor,
  BlobListing,
  BlobLocation,
  BlobStore,
} from "./types.js";

/** Where core keeps blob and multipart-part bytes. Disk is the only backend. */
export const blobStore: BlobStore = createDiskBlobStore(
  env.FILE_SERVICE_STORAGE_PATH
);

export const isBlobMissing = (err: unknown): boolean =>
  blobStore.isMissing(err);
