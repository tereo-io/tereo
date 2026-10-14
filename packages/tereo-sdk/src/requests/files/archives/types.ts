export type ArchiveFormat = "zip" | "tar";

/**
 * Inputs for `POST /buckets/:name/archives`. Exactly one of `prefix` or
 * `keys` must be set — the server enforces this and returns a 400 otherwise.
 */
export interface CreateArchiveInput {
  prefix?: string;
  keys?: string[];
  format?: ArchiveFormat;
  expiresInSeconds?: number;
  filename?: string;
}

export interface CreateArchiveResponse {
  id: string;
  url: string;
  expiresAt: string;
  objectCount: number;
  /** Total plaintext bytes across all included objects. String-encoded because
   * this can exceed JS's safe integer range. */
  totalSizeBytes: string;
  format: ArchiveFormat;
  filename: string;
}
