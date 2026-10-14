import { z } from "zod";

export const entryParamsSchema = z.object({
  id: z.guid(),
});
