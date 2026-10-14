import { bucketNameSchema } from "../../../schemas.js";
import env from "../../../../../../../env.js";
import { z } from "zod";

export const uploadIdParamsSchema = z.object({
  name: bucketNameSchema.shape.name,
  uploadId: z.string().uuid(),
});

const MAX_PARTS = env.FILE_SERVICE_MAX_MULTIPART_PARTS;

export const completeBodySchema = z.object({
  parts: z
    .array(
      z.object({
        // Bound by the same env var that gates part-upload (see
        // `parts/schemas.ts`); duplicate part numbers are rejected at the
        // array level below.
        partNumber: z.number().int().min(1).max(MAX_PARTS),
        // S3 part etag is md5(plaintext) — 32 hex chars. Tighten the format so
        // garbage etags fail at validation rather than as a "part_etag_mismatch"
        // farther in.
        etag: z
          .string()
          .regex(/^[0-9a-f]{32}$/, "etag must be a 32-character hex string"),
      })
    )
    .min(1)
    .max(MAX_PARTS)
    .superRefine((parts, ctx) => {
      const seen = new Set<number>();
      for (const p of parts) {
        if (seen.has(p.partNumber)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["parts"],
            message: `Duplicate partNumber ${p.partNumber}`,
          });
          return;
        }
        seen.add(p.partNumber);
      }
    }),
});

export type CompleteBody = z.infer<typeof completeBodySchema>;
