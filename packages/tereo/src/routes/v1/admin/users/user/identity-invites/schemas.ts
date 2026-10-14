import { z } from "zod";

export const CreateIdentityInviteSchema = z.object({
  providerId: z.guid(),
});
