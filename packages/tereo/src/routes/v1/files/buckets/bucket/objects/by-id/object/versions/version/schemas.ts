import { z } from "zod";

/** For routes that need both `:id` and `:versionId` (get/restore/delete). */
export const byIdVersionParamsSchema = z.object({
  name: z.string(),
  id: z.string().uuid("id must be a UUID"),
  versionId: z.string().uuid(),
});

export type ByIdVersionParams = z.infer<typeof byIdVersionParamsSchema>;
