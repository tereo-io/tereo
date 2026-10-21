import { bucketNameSchema } from "../../../../../../schemas.js";
import { z } from "zod";

/** For routes that need both `:id` and `:versionId` (get/restore/delete). */
export const byIdVersionParamsSchema = z.object({
  name: bucketNameSchema.shape.name,
  id: z.guid("id must be a UUID"),
  versionId: z.guid(),
});

export type ByIdVersionParams = z.infer<typeof byIdVersionParamsSchema>;
