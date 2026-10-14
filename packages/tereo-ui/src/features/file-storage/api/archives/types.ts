export type ArchiveFormat = "zip" | "tar";

export type CreateArchiveInput = (
  { prefix: string; keys?: never } | { keys: string[]; prefix?: never }
) & {
  format?: ArchiveFormat;
  expiresInSeconds?: number;
  filename?: string;
};

export interface CreateArchiveResponse {
  id: string;
  url: string;
  expiresAt: string;
  objectCount: number;
  /** totalSizeBytes is returned as a string to preserve precision for values
   * beyond 2^53. Consumers that need numbers should parse carefully. */
  totalSizeBytes: string;
  format: ArchiveFormat;
  filename: string;
}
