import { z } from "zod";

export const GrantParamsSchema = z.object({
  id: z.guid(),
  userId: z.guid(),
});
