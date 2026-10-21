import { bucketNameSchema } from "../../../../../schemas.js";
import env from "../../../../../../../../../env.js";
import { z } from "zod";

export const partParamsSchema = z.object({
  name: bucketNameSchema.shape.name,
  uploadId: z.guid(),
  partNumber: z.coerce
    .number()
    .int()
    .min(1)
    .max(env.FILE_SERVICE_MAX_MULTIPART_PARTS),
});

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
