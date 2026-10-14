import { z } from "zod";

export const IdentityParamsSchema = z.object({
  id: z.guid(),
});
