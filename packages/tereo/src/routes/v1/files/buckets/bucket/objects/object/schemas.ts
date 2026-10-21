import { bucketNameSchema } from "../../../schemas.js";
import { z } from "zod";

export const objectParamsSchema = z.object({
  name: bucketNameSchema.shape.name,
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
    .refine((key) => !key.includes("//"), {
      message: "Object key cannot contain consecutive slashes",
    }),
});

export const downloadQuerySchema = z.object({
  versionId: z.guid().optional(),
  thumbnail: z.enum(["thumb", "small", "medium"]).optional(),
});

export type ObjectParams = z.infer<typeof objectParamsSchema>;
export type DownloadQuery = z.infer<typeof downloadQuerySchema>;

// Node's parser has already refused a malformed Content-Length; absent, the
// body is chunked and its size is checked as it is read.
export const declaredLengthHeadersSchema = z.object({
  "content-length": z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().safe())
    .optional(),
});
