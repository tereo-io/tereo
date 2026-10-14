import { z } from "zod";

export const PermissionIdParamSchema = z.object({
  id: z.guid(),
});
