import { z } from "zod";

export const ScimTokenParamsSchema = z.object({
  id: z.guid(),
  tokenId: z.guid(),
});
