import type { Readable } from "stream";

/**
 * Where a backend keeps one blob or multipart part. Issued by the backend,
 * stored in `fs_path`, and passed back untouched: only the backend reads it.
 */
export type BlobLocation = string;

/** Where a listing of one shard stopped, to resume after. */
export interface BlobListCursor {
  /** The two hash characters after the shard's. */
  sub?: string;
  /** The blob to resume after; absent, the sub starts from its first. */
  afterFile?: string;
}

export interface BlobListing {
  hash: string;
  location: BlobLocation;
  /** Resumes the listing after this blob. */
  cursor: BlobListCursor;
}

/**
 * The stored bytes of content blobs and staged multipart parts. It holds
 * ciphertext only: encryption and hashing are `utils/storage.ts`'s.
 */
export interface BlobStore {
  ensureReady(): Promise<void>;

  /** The location a blob with this hash is placed at. */
  locationFor(hash: string): BlobLocation;
  /**
   * Move a scratch file to `location`, replacing what is there. The location
   * never holds a partial blob.
   */
  place(scratchPath: string, location: BlobLocation): Promise<void>;
  /** The blob's bytes, or bytes `start`..`end` inclusive. */
  openRead(
    location: BlobLocation,
    range?: { start: number; end: number }
  ): Readable;
  /** The first `bytes` of the blob, fewer when it is shorter. */
  readHead(location: BlobLocation, bytes: number): Promise<Buffer>;
  exists(location: BlobLocation): Promise<boolean>;
  /** Resolves false when the blob was already gone. */
  delete(location: BlobLocation): Promise<boolean>;

  /** The shards (first two hash characters) that hold blobs, sorted. */
  listShards(): Promise<string[]>;
  /** A shard's blobs in a stable order, resuming after `cursor`. */
  listBlobs(shard: string, cursor?: BlobListCursor): AsyncIterable<BlobListing>;

  /**
   * Store one write of a part. Every write gets its own location, so retries
   * of a part number never share a file; a failed write leaves nothing.
   */
  writePart(
    uploadId: string,
    partNumber: number,
    source: Readable
  ): Promise<BlobLocation>;
  openPart(location: BlobLocation): Readable;
  /** Missing is fine. */
  deletePart(location: BlobLocation): Promise<void>;
  /** Drop what holds an upload's parts, if no part is left in it. */
  releaseUploadIfEmpty(uploadId: string): Promise<void>;
  /** Remove an upload's parts. */
  removeUpload(uploadId: string): Promise<void>;

  /** Whether a read failed because the blob or part is not there. */
  isMissing(err: unknown): boolean;
}
