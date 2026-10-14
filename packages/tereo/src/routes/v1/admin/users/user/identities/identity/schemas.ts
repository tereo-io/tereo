import { z } from "zod";

export const UserIdentityParamsSchema = z.object({
  id: z.guid(),
  identityId: z.guid(),
});
