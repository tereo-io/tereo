import { z } from "zod";

export const UpdateRoleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_-]*$/,
      "Role name must start with a letter and contain only letters, numbers, underscores, and hyphens"
    )
    .optional(),
  displayName: z.string().min(1).max(255).optional(),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  requires2fa: z.boolean().optional(),
});

export const SetPermissionsSchema = z.object({
  permissionIds: z
    .array(z.guid())
    .max(500)
    .transform((ids) => [...new Set(ids)]),
});

export type UpdateRoleInput = z.infer<typeof UpdateRoleSchema>;
export type SetPermissionsInput = z.infer<typeof SetPermissionsSchema>;
