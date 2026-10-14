import { createHash } from "crypto";
import { z } from "zod";
import {
  encodeCursor,
  decodeCursor,
  buildCursorWhere,
  mergeCursorWhere,
  type CursorKeyResolver,
  type DecodedCursor,
} from "./parseQueryString.js";

export interface CursorSigner {
  decodeListCursor(
    raw: string,
    expected: { sort: string; sortDir: "asc" | "desc" }
  ): DecodedCursor;
  encodeListCursor(payload: {
    sort: string;
    sortDir: "asc" | "desc";
    sortValue: unknown;
    id: string | number;
  }): string;
  applyCursorToWhere(
    parsed: {
      cursor: string | null;
      sort: string;
      sortDir: "asc" | "desc";
      sortPrismaField: string;
      sortNullable?: boolean;
      tiebreaker: string;
      where?: Record<string, unknown>;
    },
    additionalWhere?: Record<string, unknown>
  ): Record<string, unknown> | undefined;
  buildCursorPageResponse<T extends Record<string, unknown>>(
    result: { data: T[]; hasMore: boolean },
    query: {
      sort: string;
      sortDir: "asc" | "desc";
      sortPrismaField: string;
      tiebreaker: string;
      limit: number;
    }
  ): {
    data: T[];
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
}

/**
 * Build a service-scoped cursor signer that reads HMAC keys from the service's
 * env via the `{prefix}_SIGNING_KEY_V{N}` + `{prefix}_ACTIVE_SIGNING_KEY_VERSION`
 * convention. Cursors embed the `kv` they were minted with, so rotating the
 * active version doesn't invalidate in-flight pagination — old cursors keep
 * validating against their original key version until they expire from client
 * state.
 *
 * `listScope` names the list being paged — the request path — when a cursor
 * is minted and when it is read back; a cursor is refused on any other list,
 * even one with the same sort.
 */
export const createCursorSigner = (config: {
  env: Record<string, unknown>;
  prefix: string;
  listScope?: () => string | undefined;
}): CursorSigner => {
  const { env, prefix } = config;

  const currentList = (): string | undefined => {
    const scope = config.listScope?.();
    return scope === undefined
      ? undefined
      : createHash("sha256").update(scope).digest("base64url").slice(0, 16);
  };

  const keyResolver: CursorKeyResolver = (keyVersion) => {
    const raw = env[`${prefix}_SIGNING_KEY_V${keyVersion}`];
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  };

  const getActiveKeyVersion = (): number => {
    const v = env[`${prefix}_ACTIVE_SIGNING_KEY_VERSION`];
    if (typeof v !== "number") {
      throw new Error(
        `${prefix}_ACTIVE_SIGNING_KEY_VERSION is not a number; check env schema`
      );
    }
    return v;
  };

  const getActiveSecret = (): string => {
    const version = getActiveKeyVersion();
    const secret = keyResolver(version);
    if (!secret) {
      throw new Error(
        `${prefix}_SIGNING_KEY_V${version} is not configured; cannot sign cursors`
      );
    }
    return secret;
  };

  const decodeListCursor = (
    raw: string,
    expected: { sort: string; sortDir: "asc" | "desc" }
  ): DecodedCursor =>
    decodeCursor(raw, { ...expected, list: currentList() }, keyResolver);

  const encodeListCursor = (payload: {
    sort: string;
    sortDir: "asc" | "desc";
    sortValue: unknown;
    id: string | number;
  }): string =>
    encodeCursor(
      { ...payload, keyVersion: getActiveKeyVersion(), list: currentList() },
      getActiveSecret()
    );

  const applyCursorToWhere = (
    parsed: {
      cursor: string | null;
      sort: string;
      sortDir: "asc" | "desc";
      sortPrismaField: string;
      sortNullable?: boolean;
      tiebreaker: string;
      where?: Record<string, unknown>;
    },
    additionalWhere?: Record<string, unknown>
  ): Record<string, unknown> | undefined => {
    const base = additionalWhere
      ? mergeCursorWhere(parsed.where, additionalWhere)
      : parsed.where;

    if (!parsed.cursor) return base;

    const decoded = decodeListCursor(parsed.cursor, {
      sort: parsed.sort,
      sortDir: parsed.sortDir,
    });
    const cursorWhere = buildCursorWhere(
      decoded,
      parsed.sortPrismaField,
      parsed.tiebreaker,
      parsed.sortNullable
    );
    return mergeCursorWhere(base, cursorWhere);
  };

  const buildCursorPageResponse = <T extends Record<string, unknown>>(
    result: { data: T[]; hasMore: boolean },
    query: {
      sort: string;
      sortDir: "asc" | "desc";
      sortPrismaField: string;
      tiebreaker: string;
      limit: number;
    }
  ): {
    data: T[];
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  } => {
    const lastRow = result.data[result.data.length - 1];
    const tiebreakerValue = lastRow
      ? (lastRow as Record<string, unknown>)[query.tiebreaker]
      : undefined;
    const nextCursor =
      result.hasMore &&
      lastRow &&
      (typeof tiebreakerValue === "string" ||
        typeof tiebreakerValue === "number")
        ? encodeListCursor({
            sort: query.sort,
            sortDir: query.sortDir,
            sortValue: (lastRow as Record<string, unknown>)[
              query.sortPrismaField
            ],
            id: tiebreakerValue,
          })
        : null;
    return {
      data: result.data,
      hasMore: result.hasMore,
      limit: query.limit,
      nextCursor,
    };
  };

  return {
    decodeListCursor,
    encodeListCursor,
    applyCursorToWhere,
    buildCursorPageResponse,
  };
};

type CursorSigningEnvFields<P extends string> = {
  [K in `${P}_ACTIVE_SIGNING_KEY_VERSION`]: z.ZodDefault<z.ZodNumber>;
};

/**
 * The env field naming the version that signs. The keys themselves,
 * `{prefix}_SIGNING_KEY_V{n}` for any n, can't be listed in a Zod object;
 * the env schema gathers them by name.
 */
export const cursorSigningEnvFields = <P extends string>(
  prefix: P
): CursorSigningEnvFields<P> =>
  ({
    [`${prefix}_ACTIVE_SIGNING_KEY_VERSION`]: z.coerce
      .number()
      .int()
      .positive()
      .default(1),
  }) as CursorSigningEnvFields<P>;

export type { DecodedCursor, CursorKeyResolver };
