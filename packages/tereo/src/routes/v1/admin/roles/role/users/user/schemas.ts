import { z } from "zod";

export const UserIdParamSchema = z.object({
  userId: z.guid(),
});

export const RemoveRoleUserQuerySchema = z.object({
  /** The organization of an org-scoped assignment; omitted for the global one. */
  organizationId: z.guid().optional(),
});
