import { ListLimitSchema } from "../../schemas.js";
import { z } from "zod";

export const ListMembersQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: ListLimitSchema,
});

export const AddMembersSchema = z
  .object({
    userIds: z.array(z.guid()).min(1).max(500),
  })
  .strict();
