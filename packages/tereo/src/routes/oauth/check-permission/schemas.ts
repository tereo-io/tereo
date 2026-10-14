import { z } from "zod";

export const CheckPermissionSchema = z.object({
  user_id: z.guid(),
  permission: z.string().min(1).max(100),
  organization_id: z.guid().optional(),
});

export const CheckPermissionsSchema = z.object({
  user_id: z.guid(),
  permissions: z.array(z.string().min(1).max(100)).min(1).max(100),
  organization_id: z.guid().optional(),
});

export type CheckPermissionInput = z.infer<typeof CheckPermissionSchema>;
export type CheckPermissionsInput = z.infer<typeof CheckPermissionsSchema>;
