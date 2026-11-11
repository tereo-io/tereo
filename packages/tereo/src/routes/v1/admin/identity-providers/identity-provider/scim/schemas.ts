import { z } from "zod";

export const PutScimConnectionSchema = z.object({
  isActive: z.boolean(),
});

export type PutScimConnectionInput = z.infer<typeof PutScimConnectionSchema>;
