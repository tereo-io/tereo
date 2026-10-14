import { contentTypeSchema, metadataSchema } from "../../schemas.js";
import { z } from "zod";

export const byIdParamsSchema = z.object({
  name: z.string(),
  id: z.string().uuid("id must be a UUID"),
});

// PATCH body — every field is optional. `objectKey` supports renames; the
// metadata fields (`contentType`, `metadata`, `tags`) edit the current
// ObjectVersion by default. Setting `createNewVersion: true` on a
// versioning-enabled bucket makes the edit create a NEW ObjectVersion
// pointing at the same content blob, flipping the prior current to
// `isCurrent=false` — preserving the "every mutation creates a version"
// invariant for callers that treat metadata as part of the versioned content.
// Ignored on non-versioning buckets. Rename (`objectKey`) does not create a
// version either way — renames are a property of the identity row.
export const patchObjectBodySchema = z
  .object({
    objectKey: z
      .string()
      .min(1, "Object key is required")
      .max(1024, "Object key too long")
      .regex(
        /^[a-zA-Z0-9/_\-. ()[\]{}+=@#$!&',]+$/,
        "Object key contains invalid characters"
      )
      .refine((key) => !key.includes(".."), "Path traversal not allowed")
      .refine((key) => !key.startsWith("/"), "Object key cannot start with /")
      .refine((key) => !key.endsWith("/"), "Object key cannot end with /")
      .refine(
        (key) => !key.includes("//"),
        "Object key cannot contain consecutive slashes"
      )
      .optional(),
    contentType: contentTypeSchema.optional(),
    metadata: metadataSchema,
    tags: z.array(z.string().min(1).max(128)).max(50).optional(),
    // `deleteAfter` overrides the bucket lifecycle policy for this object.
    // Null clears the override; an ISO string sets it; omitted means "leave alone".
    // `z.null()` first: `z.coerce.date()` would turn null into the epoch.
    deleteAfter: z.union([z.null(), z.coerce.date()]).optional(),
    createNewVersion: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.objectKey !== undefined ||
      body.contentType !== undefined ||
      body.metadata !== undefined ||
      body.tags !== undefined ||
      body.deleteAfter !== undefined,
    "At least one editable field must be provided"
  );

export type ByIdParams = z.infer<typeof byIdParamsSchema>;
export type PatchObjectBody = z.infer<typeof patchObjectBodySchema>;
