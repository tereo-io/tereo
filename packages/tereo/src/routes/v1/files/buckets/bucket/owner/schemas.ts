import { z } from "zod";

export const transferOwnershipBodySchema = z.object({
  userId: z.guid(),
});

export type TransferOwnershipBody = z.infer<typeof transferOwnershipBodySchema>;
