import { z } from "zod";

export const SetGroupRolesSchema = z.object({
  roleIds: z.array(z.guid()).max(100),
});
