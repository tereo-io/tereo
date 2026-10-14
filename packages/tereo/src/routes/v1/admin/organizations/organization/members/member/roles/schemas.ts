import { z } from "zod";

export const SetMemberRolesSchema = z.object({
  roleIds: z.array(z.guid()).max(100),
});

export type SetMemberRolesInput = z.infer<typeof SetMemberRolesSchema>;
