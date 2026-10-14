import { z } from "zod";

export const IdentityInviteParamsSchema = z.object({
  id: z.guid(),
  providerId: z.guid(),
});
