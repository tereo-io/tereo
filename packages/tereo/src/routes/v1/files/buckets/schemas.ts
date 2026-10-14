import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { z } from "zod";

// Maximum storage quota: 1 Terabyte (prevents BigInt overflow)
const MAX_STORAGE_QUOTA = BigInt(1024 * 1024 * 1024 * 1024);

// Shared bucket name validation for params
export const bucketNameSchema = z.object({
  name: z
    .string()
    .min(3, "Bucket name must be at least 3 characters")
    .max(63, "Bucket name must be at most 63 characters")
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "Bucket name must be lowercase alphanumeric with hyphens"
    ),
});

export const createBucketSchema = z.object({
  name: z
    .string()
    .min(3, "Bucket name must be at least 3 characters")
    .max(63, "Bucket name must be at most 63 characters")
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "Bucket name must be lowercase alphanumeric with hyphens"
    ),
  description: z.string().max(500).optional(),
  policy: z.enum(["public", "private"]).default("private"),
  storageQuotaBytes: z
    .union([
      z.coerce
        .bigint()
        .positive()
        .max(MAX_STORAGE_QUOTA, "Storage quota exceeds maximum allowed (1 TB)"),
      z.null(),
    ])
    .optional(),
});

export const listBucketsQuerySchema = createCursorQuerySchema({
  filters: {
    name: {
      operators: ["contains", "equals"],
      schema: z.string().min(1),
    },
    description: {
      operators: ["contains", "equals"],
      schema: z.string().min(1),
    },
    policy: {
      operators: ["equals", "in"],
      schema: z.enum(["public", "private"]),
    },
    currentUsageBytes: {
      operators: ["gte", "lte", "gt", "lt"],
      schema: z.coerce.bigint(),
    },
  },
  sortFields: {
    name: "name",
    description: "description",
    policy: "policy",
    currentUsageBytes: "currentUsageBytes",
    createdAt: "createdAt",
  },
  nullableSortFields: ["description"],
  defaultSort: "createdAt",
  defaultLimit: 100,
  maxLimit: 1000,
});

export type BucketNameParams = z.infer<typeof bucketNameSchema>;
export type CreateBucketInput = z.infer<typeof createBucketSchema>;
export type ListBucketsQuery = z.infer<typeof listBucketsQuerySchema>;
