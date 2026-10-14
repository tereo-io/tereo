import { createCursorQuerySchema } from "../../../../../../utils/parseQueryString.js";
import { normalizeContentType } from "../../../../../../utils/contentType.js";
import { z } from "zod";

type MetadataValue = string | number | boolean | null | MetadataValue[];

// Maximum metadata size in bytes (100KB)
const MAX_METADATA_SIZE = 100 * 1024;

// Metadata value can be string, number, boolean, or null.
// Exported so the per-object schema module can re-use it without duplicating
// the recursive definition.
const metadataValueSchema: z.ZodType<
  string | number | boolean | null | MetadataValue[]
> = z.lazy(() =>
  z.union([
    z.string().max(10000, "Metadata string value too long"),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(metadataValueSchema).max(100, "Metadata array too large"),
  ])
);

export const metadataSchema = z
  .record(z.string().max(255, "Metadata key too long"), metadataValueSchema)
  .optional()
  .refine((d) => (d ? JSON.stringify(d).length <= MAX_METADATA_SIZE : true), {
    message: `Metadata exceeds maximum size of ${MAX_METADATA_SIZE} bytes`,
  })
  .refine((d) => (d ? Object.keys(d).length <= 100 : true), {
    message: "Metadata cannot have more than 100 keys",
  });

/** A content type as `normalizeContentType` stores it. */
export const contentTypeSchema = z
  .string()
  .min(1)
  .max(255)
  .transform((value, ctx) => {
    const normalized = normalizeContentType(value);
    if (!normalized) {
      ctx.addIssue({
        code: "custom",
        message:
          "Content type must be a single type/subtype, optionally with a charset",
      });
      return z.NEVER;
    }
    return normalized;
  });

export const listObjectsQuerySchema = createCursorQuerySchema({
  filters: {
    objectKey: {
      operators: ["contains", "startsWith", "equals"],
      schema: z.string(),
    },
    contentType: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
  },
  sortFields: {
    objectKey: "objectKey",
    createdAt: "createdAt",
    sizeBytes: "sizeBytes",
  },
  defaultSort: "createdAt",
  defaultLimit: 100,
  maxLimit: 1000,
});

// `deleted=true` lists a versioned bucket's deleted objects instead of its
// live ones. Strict: z.coerce.boolean() would read "false" as true.
export const listObjectsExtraQuerySchema = z.object({
  deleted: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
});

export const listPrefixesQuerySchema = z.object({
  prefix: z.string().max(1024).default(""),
  delimiter: z.string().min(1).max(4).default("/"),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional(),
});

export type ListObjectsQuery = z.infer<typeof listObjectsQuerySchema>;
export type ListPrefixesQuery = z.infer<typeof listPrefixesQuerySchema>;

/**
 * Body schema for `POST /buckets/:name/objects/bulk-delete`. Either a single
 * key prefix or a list of object UUIDs, but not both. Prefix must be non-empty
 * — an empty prefix would wipe the bucket, and the bucket-delete route is the
 * right tool for that.
 */
export const bulkDeleteBodySchema = z
  .object({
    prefix: z.string().min(1).max(1024).optional(),
    ids: z.array(z.string().uuid()).min(1).max(1000).optional(),
  })
  .refine(
    (v) => (v.prefix !== undefined) !== (v.ids !== undefined),
    "Provide exactly one of `prefix` or `ids`"
  );

export type BulkDeleteBody = z.infer<typeof bulkDeleteBodySchema>;
