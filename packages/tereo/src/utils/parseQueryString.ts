import { createHmac, timingSafeEqual } from "crypto";
import { BadRequestError } from "./errors.js";
import { escapeLike } from "./db/like.js";
import { z } from "zod";

type Operator =
  | "equals"
  | "contains"
  | "in"
  | "gte"
  | "lte"
  | "gt"
  | "lt"
  | "startsWith"
  | "endsWith"
  | "has";

interface FilterConfig {
  /** Allowed operators for this field */
  operators: Operator[];
  /** Zod schema to validate the filter value */
  schema: z.ZodType;
  /** The Prisma field path (defaults to the filter key) */
  prismaField?: string;
  /**
   * Turns one parsed clause (`{ equals: v }`, `{ contains: v, mode }`, …) into
   * a `where` fragment, for filters that aren't a plain column: a relation
   * (`{ some: … }`) or a derived flag (`archived` → `archivedAt`). Fragments
   * are ANDed at the where root. Not applied to `_gte`/`_lte` range keys.
   */
  toWhere?: (clause: Record<string, unknown>) => Record<string, unknown>;
  /** The most values one `in` filter may list (default `MAX_IN_VALUES`). */
  maxInValues?: number;
  /** The longest one filter value may be (default `MAX_FILTER_VALUE_LENGTH`). */
  maxValueLength?: number;
}

export const MAX_FILTER_VALUE_LENGTH = 500;
export const MAX_IN_VALUES = 100;
// Repeated keys (`?filter[x]=a&filter[x]=b`) each become a clause.
export const MAX_CLAUSES_PER_FILTER = 20;

/**
 * Checked before a filter's own schema, so a filter on an unbounded column
 * (`z.string()`) cannot take a value of any size.
 */
const checkValueLength = (
  value: unknown,
  filterConfig: FilterConfig,
  filterKey: string,
  key: string,
  ctx: z.RefinementCtx
): boolean => {
  const max = filterConfig.maxValueLength ?? MAX_FILTER_VALUE_LENGTH;
  if (typeof value !== "string" || value.length <= max) return true;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [key],
    message: `Values for "${filterKey}" may be at most ${max} characters`,
  });
  return false;
};

const CASE_INSENSITIVE_OPS = new Set(["contains", "startsWith", "endsWith"]);

/**
 * Merge every clause collected for one field into the top-level `where`.
 * Clauses whose keys don't clash fold into one per-field filter, so
 * `_lte` + `_gte` (in any order, suffix or `_op` form) yield one
 * `{ gte, lte }`. Clashing clauses (two `equals`, two `gte`, a
 * case-insensitive one beside another) go to a top-level
 * `where.AND` array instead — Prisma rejects `AND` inside a per-field filter.
 */
const mergeClausesIntoWhere = (
  where: Record<string, unknown>,
  prismaField: string,
  clauses: Record<string, unknown>[]
): void => {
  const merged: Record<string, unknown> = {};
  const clashing: Record<string, unknown>[] = [];
  for (const clause of clauses) {
    // `mode` applies to every operator in a filter, so a case-insensitive
    // clause never shares one with another operator.
    const clashes =
      Object.keys(merged).length > 0 &&
      ("mode" in clause ||
        "mode" in merged ||
        Object.keys(clause).some((op) => op in merged));
    if (clashes) clashing.push(clause);
    else Object.assign(merged, clause);
  }
  if (Object.keys(merged).length > 0) where[prismaField] = merged;
  if (clashing.length === 0) return;
  if (!Array.isArray(where.AND)) where.AND = [];
  const andArr = where.AND as Record<string, unknown>[];
  for (const clause of clashing) {
    andArr.push({ [prismaField]: clause });
  }
};

/**
 * Query values arrive as strings: "true"/"false" become booleans only when the
 * schema refuses the string, so a text filter can still match those words.
 */
const parseFilterValue = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  if (result.success || (value !== "true" && value !== "false")) return result;
  const coerced = schema.safeParse(value === "true");
  return coerced.success ? coerced : result;
};

/**
 * Build one or more Prisma filter clauses for a single field.
 *
 * Supports compound filters via repeated query keys (Express 5 simple parser
 * collapses `?filter[X]=A&filter[X]=B` into `{ "filter[X]": ["A","B"] }`).
 * Values and operators are paired by index; a scalar operator broadcasts to
 * all values; mismatched lengths are a validation error. Single-clause cases
 * are merged with the field's other clauses by `mergeClausesIntoWhere`.
 */
const buildFilterClauses = (
  filterKey: string,
  rawValue: unknown,
  rawOperator: unknown,
  filterConfig: FilterConfig,
  key: string,
  operatorKey: string,
  ctx: z.RefinementCtx
): Record<string, unknown>[] => {
  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  if (values.length > MAX_CLAUSES_PER_FILTER) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `At most ${MAX_CLAUSES_PER_FILTER} values for "${filterKey}"`,
    });
    return [];
  }

  let operators: string[];
  if (Array.isArray(rawOperator)) {
    operators = rawOperator.map((o) => String(o));
  } else {
    const single =
      typeof rawOperator === "string" && rawOperator.length > 0
        ? rawOperator
        : "equals";
    operators = new Array(values.length).fill(single);
  }

  if (operators.length !== values.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [operatorKey],
      message: `Operator count (${operators.length}) does not match value count (${values.length}) for filter "${filterKey}"`,
    });
    return [];
  }

  const clauses: Record<string, unknown>[] = [];

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const operator = operators[i];

    if (!filterConfig.operators.includes(operator as Operator)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [operatorKey],
        message: `Operator "${operator}" not allowed for "${filterKey}"`,
      });
      return [];
    }

    if (operator === "in") {
      const inValues =
        typeof value === "string" ? value.split(",").map((v) => v.trim()) : [];
      const maxInValues = filterConfig.maxInValues ?? MAX_IN_VALUES;
      if (inValues.length > maxInValues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `At most ${maxInValues} values for "${filterKey}"`,
        });
        return [];
      }

      const validated: unknown[] = [];
      let inHadError = false;
      for (const v of inValues) {
        if (!checkValueLength(v, filterConfig, filterKey, key, ctx)) {
          inHadError = true;
          continue;
        }
        const result = filterConfig.schema.safeParse(v);
        if (!result.success) {
          result.error.issues.forEach((issue) =>
            ctx.addIssue({ ...issue, path: [key] })
          );
          inHadError = true;
        } else {
          validated.push(result.data);
        }
      }
      if (inHadError) return [];
      if (validated.length > 0) clauses.push({ in: validated });
      continue;
    }

    if (!checkValueLength(value, filterConfig, filterKey, key, ctx)) return [];
    const result = parseFilterValue(filterConfig.schema, value);
    if (!result.success) {
      result.error.issues.forEach((issue) =>
        ctx.addIssue({ ...issue, path: [key] })
      );
      return [];
    }

    if (CASE_INSENSITIVE_OPS.has(operator)) {
      // Prisma hands these to LIKE as they are, so `_` and `%` would match
      // any character or run.
      const pattern =
        typeof result.data === "string" ? escapeLike(result.data) : result.data;
      clauses.push({ [operator]: pattern, mode: "insensitive" });
    } else {
      clauses.push({ [operator]: result.data });
    }
  }

  return clauses;
};

// 2 added `l`, the list the cursor was minted for. A version-1 cursor, which
// a client could replay on another list with the same sort, is refused.
const CURSOR_VERSION = 2;

export interface DecodedCursor {
  v: number;
  // The list the cursor belongs to (a hash of the request path), so it cannot
  // page through another list that sorts the same way. Absent when the cursor
  // was minted outside a request.
  l?: string;
  // Signing key version used to produce the HMAC. Embedded so cursors minted
  // under an older key stay verifiable after a key rotation — callers pass a
  // resolver to `decodeCursor` that maps version → secret.
  kv: number;
  s: string;
  d: "asc" | "desc";
  k: unknown;
  id: string | number;
}

export type CursorKeyResolver = (keyVersion: number) => string | null;

const signCursor = (payload: string, secret: string): string =>
  createHmac("sha256", secret)
    .update(payload)
    .digest()
    .subarray(0, 16)
    .toString("base64url");

const verifyCursor = (
  payload: string,
  tag: string,
  secret: string
): boolean => {
  try {
    const expected = Buffer.from(signCursor(payload, secret), "base64url");
    const got = Buffer.from(tag, "base64url");
    if (expected.length !== got.length) return false;
    return timingSafeEqual(expected, got);
  } catch {
    return false;
  }
};

export const encodeCursor = (
  payload: {
    sort: string;
    sortDir: "asc" | "desc";
    sortValue: unknown;
    id: string | number;
    keyVersion: number;
    list?: string;
  },
  hmacSecret: string
): string => {
  const body: DecodedCursor = {
    v: CURSOR_VERSION,
    ...(payload.list !== undefined && { l: payload.list }),
    kv: payload.keyVersion,
    s: payload.sort,
    d: payload.sortDir,
    k:
      payload.sortValue instanceof Date
        ? payload.sortValue.toISOString()
        : payload.sortValue,
    id: payload.id,
  };
  const b64 = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${b64}.${signCursor(b64, hmacSecret)}`;
};

export const decodeCursor = (
  raw: string,
  expected: { sort: string; sortDir: "asc" | "desc"; list?: string },
  keyResolver: CursorKeyResolver
): DecodedCursor => {
  const parts = raw.split(".");
  if (parts.length !== 2) {
    throw new BadRequestError("invalid_cursor", "Cursor is malformed");
  }
  const [b64, tag] = parts;
  // Parse the payload first so we can look up the signing key by its embedded
  // version, THEN verify. The payload isn't trusted until verifyCursor passes,
  // so we only read the `kv` field (an integer) and reject anything else.
  let decoded: DecodedCursor;
  try {
    decoded = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestError("invalid_cursor", "Cursor payload invalid");
  }
  if (typeof decoded?.kv !== "number" || !Number.isInteger(decoded.kv)) {
    throw new BadRequestError("invalid_cursor", "Cursor missing key version");
  }
  const secret = keyResolver(decoded.kv);
  if (!secret) {
    throw new BadRequestError(
      "invalid_cursor",
      "Cursor signing key version is not configured"
    );
  }
  if (!verifyCursor(b64, tag, secret)) {
    throw new BadRequestError("invalid_cursor", "Cursor signature invalid");
  }
  if (decoded.v !== CURSOR_VERSION) {
    throw new BadRequestError("invalid_cursor", "Cursor version unsupported");
  }
  if (decoded.l !== expected.list) {
    throw new BadRequestError(
      "invalid_cursor",
      "Cursor belongs to another list"
    );
  }
  if (decoded.s !== expected.sort || decoded.d !== expected.sortDir) {
    throw new BadRequestError(
      "invalid_cursor",
      "Cursor does not match requested sort"
    );
  }
  return decoded;
};

interface CursorQuerySchemaConfig {
  filters?: Record<string, FilterConfig>;
  sortFields: Record<string, string>;
  defaultSort: string;
  defaultDir?: "asc" | "desc";
  defaultLimit?: number;
  maxLimit?: number;
  tiebreaker?: string;
  /** Keys of `sortFields` whose column can be NULL. */
  nullableSortFields?: string[];
}

export interface ParsedCursorQuery {
  limit: number;
  sort: string;
  sortDir: "asc" | "desc";
  sortPrismaField: string;
  sortNullable: boolean;
  tiebreaker: string;
  cursor: string | null;
  orderBy: Array<Record<string, "asc" | "desc">>;
  where?: Record<string, unknown>;
}

/**
 * Build a Prisma `where` clause that advances past the given decoded cursor,
 * using keyset (tuple) comparison on (sortField, tiebreaker).
 */
export const buildCursorWhere = (
  decoded: DecodedCursor,
  sortPrismaField: string,
  tiebreaker: string,
  nullable = false
): Record<string, unknown> => {
  const op = decoded.d === "asc" ? "gt" : "lt";
  // When sorting by the tiebreaker itself, the field is unique — no second
  // disambiguation clause is needed (and emitting one would produce a
  // duplicate-key object literal that silently drops the equality clause).
  if (sortPrismaField === tiebreaker) {
    return { [sortPrismaField]: { [op]: decoded.k } };
  }
  // The tiebreaker is always ordered asc (see `createCursorQuerySchema`), so
  // forward-paging past the cursor row means `tiebreaker > decoded.id` even
  // when the primary sort is desc. Reusing `op` here would advance the
  // tiebreaker in the wrong direction on ties, returning already-seen rows.
  const afterTie = { [tiebreaker]: { gt: decoded.id } };
  // Postgres puts NULLs last ascending and first descending, and no
  // comparison matches them, so they need their own clauses.
  if (decoded.k === null) {
    return {
      OR: [
        { [sortPrismaField]: null, ...afterTie },
        ...(decoded.d === "desc" ? [{ [sortPrismaField]: { not: null } }] : []),
      ],
    };
  }
  return {
    OR: [
      { [sortPrismaField]: { [op]: decoded.k } },
      { [sortPrismaField]: decoded.k, ...afterTie },
      ...(nullable && decoded.d === "asc" ? [{ [sortPrismaField]: null }] : []),
    ],
  };
};

const parseFilters = (
  rest: Record<string, unknown>,
  filters: Record<string, FilterConfig>,
  ctx: z.RefinementCtx
): Record<string, unknown> => {
  const where: Record<string, unknown> = {};
  const filterRegex = /^filter\[(.+?)\]$/;
  // Clauses per Prisma field, merged once every key is read so the result
  // doesn't depend on the order of the query string.
  const fieldClauses = new Map<string, Record<string, unknown>[]>();
  // Own properties only: `filter[constructor]` must not find Object's.
  const filterFor = (name: string): FilterConfig | undefined =>
    Object.hasOwn(filters, name) ? filters[name] : undefined;
  const addClauses = (field: string, clauses: Record<string, unknown>[]) => {
    fieldClauses.set(field, [...(fieldClauses.get(field) ?? []), ...clauses]);
  };

  for (const [key, rawValue] of Object.entries(rest)) {
    const match = key.match(filterRegex);
    if (!match || rawValue === undefined || rawValue === "") continue;

    const filterKey = match[1];
    if (filterKey.endsWith("_op")) continue;

    const rangeMatch = filterKey.match(/^(.+?)_(gte|lte|gt|lt)$/);
    if (rangeMatch) {
      const [, fieldName, operator] = rangeMatch;
      const filterConfig = filterFor(fieldName);

      if (!filterConfig) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Filter field "${fieldName}" is not allowed`,
        });
        continue;
      }

      if (!filterConfig.operators.includes(operator as Operator)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Operator "${operator}" not allowed for "${fieldName}"`,
        });
        continue;
      }

      if (!checkValueLength(rawValue, filterConfig, fieldName, key, ctx)) {
        continue;
      }
      const valueResult = filterConfig.schema.safeParse(rawValue);
      if (!valueResult.success) {
        valueResult.error.issues.forEach((issue) => {
          ctx.addIssue({ ...issue, path: [key] });
        });
        continue;
      }

      addClauses(filterConfig.prismaField || fieldName, [
        { [operator]: valueResult.data },
      ]);
      continue;
    }

    const filterConfig = filterFor(filterKey);
    if (!filterConfig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Filter field "${filterKey}" is not allowed`,
      });
      continue;
    }

    const operatorKey = `filter[${filterKey}_op]`;
    const clauses = buildFilterClauses(
      filterKey,
      rawValue,
      rest[operatorKey],
      filterConfig,
      key,
      operatorKey,
      ctx
    );
    if (clauses.length === 0) continue;

    if (filterConfig.toWhere) {
      if (!Array.isArray(where.AND)) where.AND = [];
      for (const clause of clauses) {
        (where.AND as Record<string, unknown>[]).push(
          filterConfig.toWhere(clause)
        );
      }
      continue;
    }

    addClauses(filterConfig.prismaField || filterKey, clauses);
  }

  for (const [field, clauses] of fieldClauses) {
    mergeClausesIntoWhere(where, field, clauses);
  }
  return where;
};

/**
 * Creates a Zod schema for cursor-paginated list endpoints.
 *
 * The parsed output exposes `cursor` as the raw opaque string — HMAC decode
 * happens in the controller (which owns the signing key) via `decodeCursor()`.
 * Use `buildCursorWhere()` + `encodeCursor()` alongside this schema.
 */
export const createCursorQuerySchema = (config: CursorQuerySchemaConfig) => {
  const {
    filters = {},
    sortFields,
    defaultSort,
    defaultDir = "desc",
    defaultLimit = 50,
    maxLimit = 200,
    tiebreaker = "id",
    nullableSortFields = [],
  } = config;

  const sortFieldKeys = Object.keys(sortFields);
  if (sortFieldKeys.length === 0) {
    throw new Error("createCursorQuerySchema requires at least one sortField");
  }
  if (!sortFields[defaultSort]) {
    throw new Error(`defaultSort "${defaultSort}" is not in sortFields`);
  }

  return z
    .object({
      limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
      cursor: z.string().optional(),
      sort: z.enum(sortFieldKeys as [string, ...string[]]).default(defaultSort),
      sortDir: z.enum(["asc", "desc"]).default(defaultDir),
    })
    .passthrough()
    .transform((data, ctx): ParsedCursorQuery => {
      const { limit, cursor, sort, sortDir, ...rest } = data;
      const sortPrismaField = sortFields[sort];

      const where =
        Object.keys(filters).length > 0 ? parseFilters(rest, filters, ctx) : {};

      const orderBy: Array<Record<string, "asc" | "desc">> = [
        { [sortPrismaField]: sortDir as "asc" | "desc" },
      ];
      if (sortPrismaField !== tiebreaker) {
        orderBy.push({ [tiebreaker]: "asc" });
      }

      return {
        limit,
        sort,
        sortDir,
        sortPrismaField,
        sortNullable: nullableSortFields.includes(sort),
        tiebreaker,
        cursor: cursor ?? null,
        orderBy,
        where: Object.keys(where).length > 0 ? where : undefined,
      };
    });
};

/**
 * Merges a filter `where` with a keyset `cursorWhere` into a single Prisma
 * where clause (using AND if both are present).
 */
export const mergeCursorWhere = (
  where: Record<string, unknown> | undefined,
  cursorWhere: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (!where && !cursorWhere) return undefined;
  if (!where) return cursorWhere;
  if (!cursorWhere) return where;
  return { AND: [where, cursorWhere] };
};
