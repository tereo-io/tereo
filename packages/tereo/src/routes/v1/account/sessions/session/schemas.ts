import { z } from "zod";

export const RevokeSessionSchema = z.object({
  sessionId: z.guid(),
});
