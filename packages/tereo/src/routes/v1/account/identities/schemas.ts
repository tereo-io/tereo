import { z } from "zod";

export const StartLinkSchema = z.object({
  provider: z.string().min(1).max(50),
});
