import { z } from "zod";

export const MemberUserIdParamSchema = z.object({
  userId: z.guid(),
});
