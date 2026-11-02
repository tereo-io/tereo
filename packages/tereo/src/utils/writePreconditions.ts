import { PreconditionFailedError } from "./errors.js";

export interface EtagPreconditions {
  /** Strong tags only (or `*`): a weak tag never satisfies `If-Match`. */
  ifMatch: string[] | null;
  /** Opaque tags, `W/` dropped: `If-None-Match` compares weakly. */
  ifNoneMatch?: string[] | null;
  ifNoneMatchWildcard: boolean;
}

/**
 * Throws `PreconditionFailedError` when a write's `If-Match` /
 * `If-None-Match` aren't met by the object it would overwrite. `currentEtag`
 * is the current version's, `null` when the object has none.
 */
export const assertWritePreconditions = (
  p: EtagPreconditions | undefined,
  existing: boolean,
  currentEtag: string | null
): void => {
  if (p?.ifNoneMatchWildcard && existing) {
    throw new PreconditionFailedError(
      "Object already exists (If-None-Match: *)"
    );
  }
  const ifMatch = p?.ifMatch;
  const ifNoneMatch = p?.ifNoneMatch;
  if (
    ifMatch &&
    (!currentEtag || !(ifMatch.includes("*") || ifMatch.includes(currentEtag)))
  ) {
    throw new PreconditionFailedError("ETag mismatch (If-Match)");
  }
  if (currentEtag && ifNoneMatch?.includes(currentEtag)) {
    throw new PreconditionFailedError("ETag matches (If-None-Match)");
  }
};
