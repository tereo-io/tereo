import { z } from "zod";

/**
 * Body for `POST /buckets/:name/archives`.
 *
 * Exactly one of `prefix` or `keys` — multi-select and folder-based downloads
 * share this single endpoint. `prefix: ""` is intentionally rejected because
 * that would pull an entire bucket; if a caller really wants that, they should
 * pick a bounded prefix or use bucket-level export tooling.
 *
 * A prefix archive's entries always drop the prefix, so it extracts cleanly
 * next to the user's existing files.
 */
export const createArchiveBodySchema = z
  .object({
    prefix: z.string().min(1).max(1024).optional(),
    keys: z.array(z.string().min(1).max(1024)).min(1).max(1000).optional(),
    format: z.enum(["zip", "tar"]).default("zip"),
    expiresInSeconds: z.coerce.number().int().min(60).default(3600),
    filename: z.string().min(1).max(255).optional(),
  })
  .refine(
    (v) => (v.prefix !== undefined) !== (v.keys !== undefined),
    "Provide exactly one of `prefix` or `keys`"
  );

export type CreateArchiveBody = z.infer<typeof createArchiveBodySchema>;
