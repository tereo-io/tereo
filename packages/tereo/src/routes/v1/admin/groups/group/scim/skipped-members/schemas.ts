import { ListLimitSchema } from "../../../schemas.js";
import { z } from "zod";

export const ListSkippedMembersQuerySchema = z.object({
  cursor: z.guid().optional(),
  limit: ListLimitSchema,
});
