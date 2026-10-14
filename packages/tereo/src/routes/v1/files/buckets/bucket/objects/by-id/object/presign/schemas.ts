import { z } from "zod";

export const presignBodySchema = z.object({
  operation: z.enum(["read", "write"]).default("read"),
  expiresInSeconds: z.coerce.number().int().min(1).default(3600),
});

export type PresignBody = z.infer<typeof presignBodySchema>;
