import { z } from "zod";

export const shareIdParamSchema = z.object({
  name: z.string(),
  id: z.string().uuid(),
});

export const updateShareBodySchema = z
  .object({
    // `password: null` clears; `password: "x"` sets; omission keeps current.
    password: z.union([z.string().min(1).max(128), z.null()]).optional(),
    // `z.null()` first: `z.coerce.date()` would turn null into the epoch.
    expiresAt: z.union([z.null(), z.coerce.date()]).optional(),
    maxDownloads: z
      .union([z.number().int().positive().max(1_000_000), z.null()])
      .optional(),
    urlFilename: z.union([z.string().min(1).max(255), z.null()]).optional(),
    note: z.union([z.string().max(500), z.null()]).optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    "At least one field must be provided"
  );

export type ShareIdParams = z.infer<typeof shareIdParamSchema>;

export type UpdateShareBody = z.infer<typeof updateShareBodySchema>;
