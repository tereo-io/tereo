export interface ListPrefixesOptions {
  prefix?: string;
  delimiter?: string;
  limit?: number;
  cursor?: string;
}

/**
 * A virtual-folder entry (common prefix) in a prefix listing. Returned with
 * `type: "prefix"` so callers can branch on the tagged union.
 */
export interface PrefixEntry {
  type: "prefix";
  prefix: string;
  objectCount: number;
  totalSizeBytes: string;
}

/**
 * A leaf-object entry in a prefix listing. Returned with `type: "object"` so
 * callers can branch on the tagged union.
 */
export interface PrefixObjectEntry {
  type: "object";
  /** Stable UUID — use this for id-addressed mutations. */
  id: string;
  key: string;
  contentType: string;
  sizeBytes: string;
  etag: string;
  tags: string[];
  updatedAt: string;
}

export type PrefixListEntry = PrefixEntry | PrefixObjectEntry;

/**
 * Unified prefix-listing envelope: `data` contains folder entries first
 * (type "prefix"), followed by leaf objects (type "object"). Cursor advances
 * through both sub-streams in a single pass.
 */
export interface ListPrefixesResponse {
  data: PrefixListEntry[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}
