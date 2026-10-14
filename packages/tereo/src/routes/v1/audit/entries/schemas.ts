import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { escapeLike } from "../../../../utils/db/like.js";
import { isIP } from "node:net";
import { z } from "zod";
import {
  pgDate,
  pgJson as json,
  pgText as text,
} from "../../../../utils/pgInput.js";

const entryFieldsSchema = z.object({
  source: text().min(1).max(100),
  // Any 8-4-4-4-12 id, as Postgres' uuid type takes it (see the webhooks'
  // schemas); a well-formed id that names nothing is a 400 unknown_*.
  organizationId: z.guid().nullish(),
  userId: z.guid(),
  userEmail: z.string().email().toLowerCase().nullish(),
  action: z.enum(["CREATE", "UPDATE", "DELETE", "MERGE", "ARCHIVE", "RESTORE"]),
  entityType: text().min(1).max(100),
  entityId: text().min(1).max(500),
  entityName: text().max(500).optional(),
  changes: json(
    z.record(
      z.string(),
      z.object({ old: z.unknown().optional(), new: z.unknown().optional() })
    )
  ).optional(),
  metadata: json(z.record(z.string(), z.unknown())).optional(),
  ipAddress: z
    .string()
    .max(45)
    .refine((val) => isIP(val) !== 0, { message: "Invalid IP address" })
    .nullish(),
  correlationId: text()
    .max(255)
    .optional()
    .transform((val) => (val === "" ? undefined : val)),
});

export const createEntrySchema = entryFieldsSchema.extend({
  idempotencyKey: text().min(1).max(255).optional(),
});

/** Batch entries do not support per-entry idempotency keys — reject unknown fields. */
const batchEntrySchema = entryFieldsSchema.strict();

export const createBatchSchema = z.object({
  entries: z.array(batchEntrySchema).min(1).max(1000),
  idempotencyKey: text().min(1).max(255).optional(),
});

export const entryFilters = {
  source: { operators: ["equals", "in"], schema: text() },
  organizationId: { operators: ["equals"], schema: z.string() },
  userId: { operators: ["equals"], schema: z.string().uuid() },
  writerUserId: { operators: ["equals"], schema: z.string().uuid() },
  // Written lower-cased, but rows from before that may not be, so the filter
  // ignores case rather than rewriting the partitioned table. Prisma's
  // case-insensitive equals is an ILIKE, hence the escaped value.
  userEmail: {
    operators: ["equals", "contains"],
    schema: text().transform((v) => v.toLowerCase()),
    toWhere: (clause) =>
      "equals" in clause
        ? {
            userEmail: {
              equals: escapeLike(String(clause.equals)),
              mode: "insensitive",
            },
          }
        : { userEmail: clause },
  },
  action: {
    operators: ["equals", "in"],
    schema: z.enum([
      "CREATE",
      "UPDATE",
      "DELETE",
      "MERGE",
      "ARCHIVE",
      "RESTORE",
      "LOGIN",
      "LOGOUT",
    ]),
  },
  entityType: { operators: ["equals", "in"], schema: text() },
  entityId: { operators: ["equals"], schema: text() },
  entityName: { operators: ["contains", "equals"], schema: text() },
  ipAddress: { operators: ["equals"], schema: text() },
  correlationId: { operators: ["equals"], schema: text() },
  createdAt: { operators: ["gte", "lte"], schema: pgDate() },
} satisfies NonNullable<
  Parameters<typeof createCursorQuerySchema>[0]["filters"]
>;

/** The window facets cover when the request names no start. */
export const FACETS_DEFAULT_DAYS = 90;

/** The list's date filters; the facets' other query parameters are ignored. */
export const facetsQuerySchema = z.object({
  "filter[createdAt_gte]": pgDate().optional(),
  "filter[createdAt_lte]": pgDate().optional(),
});

/** The longest `createdAt` range one `filter[q]` search may scan. */
export const SEARCH_MAX_DAYS = 31;

export const listQuerySchema = createCursorQuerySchema({
  filters: {
    ...entryFilters,
    q: { operators: ["equals"], schema: text().trim().min(1).max(200) },
  },
  sortFields: { createdAt: "createdAt" },
  defaultSort: "createdAt",
  defaultLimit: 50,
  maxLimit: 200,
});
