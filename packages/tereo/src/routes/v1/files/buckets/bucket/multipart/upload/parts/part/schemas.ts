import { bucketNameSchema } from "../../../../../schemas.js";
import env from "../../../../../../../../../env.js";
import { z } from "zod";

export const partParamsSchema = z.object({
  name: bucketNameSchema.shape.name,
  uploadId: z.string().uuid(),
  partNumber: z.coerce
    .number()
    .int()
    .min(1)
    .max(env.FILE_SERVICE_MAX_MULTIPART_PARTS),
});
