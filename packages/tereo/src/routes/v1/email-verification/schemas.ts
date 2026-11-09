import { z } from "zod";

export const EmailVerificationTokenSchema = z.object({
  token: z.string().min(1).max(128),
});
