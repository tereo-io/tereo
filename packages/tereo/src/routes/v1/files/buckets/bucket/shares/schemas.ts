import { createCursorQuerySchema } from "../../../../../../utils/parseQueryString.js";
import { z } from "zod";

const commonShareFields = {
  password: z.string().min(1).max(128).optional(),
  expiresAt: z.coerce.date().optional(),
  maxDownloads: z.number().int().positive().max(1_000_000).optional(),
  urlFilename: z.string().min(1).max(255).optional(),
  note: z.string().max(500).optional(),
};

export const createObjectShareBodySchema = z.object({
  kind: z.literal("OBJECT"),
  objectId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  ...commonShareFields,
});

export const createArchiveShareBodySchema = z
  .object({
    kind: z.literal("ARCHIVE"),
    prefix: z.string().min(1).max(1024).optional(),
    keys: z.array(z.string().min(1).max(1024)).min(1).max(1000).optional(),
    format: z.enum(["zip", "tar"]).default("zip"),
    archiveFilename: z.string().min(1).max(255).optional(),
    ...commonShareFields,
  })
  .refine(
    (v) => (v.prefix !== undefined) !== (v.keys !== undefined),
    "Provide exactly one of `prefix` or `keys`"
  );

export const createShareBodySchema = z.discriminatedUnion("kind", [
  createObjectShareBodySchema,
  createArchiveShareBodySchema,
]);

export const listSharesQuerySchema = createCursorQuerySchema({
  filters: {
    kind: {
      operators: ["equals", "in"],
      schema: z.enum(["OBJECT", "ARCHIVE"]),
    },
    objectId: { operators: ["equals"], schema: z.string().uuid() },
    createdByUserId: { operators: ["equals"], schema: z.guid() },
    revokedAt: {
      operators: ["equals", "gt", "gte", "lt", "lte"],
      schema: z.coerce.date(),
    },
  },
  sortFields: {
    createdAt: "createdAt",
    expiresAt: "expiresAt",
    downloadCount: "downloadCount",
  },
  nullableSortFields: ["expiresAt"],
  defaultSort: "createdAt",
  defaultLimit: 50,
  maxLimit: 500,
});

export type CreateShareBody = z.infer<typeof createShareBodySchema>;
export type CreateObjectShareBody = z.infer<typeof createObjectShareBodySchema>;
export type CreateArchiveShareBody = z.infer<
  typeof createArchiveShareBodySchema
>;
export type ListSharesQuery = z.infer<typeof listSharesQuerySchema>;
