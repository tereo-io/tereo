import { z } from "zod";

export const UpdateOrganizationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Slug must start with a letter or number and contain only lowercase letters, numbers, and hyphens"
    )
    .optional(),
  isActive: z.boolean().optional(),
});

export type UpdateOrganizationInput = z.infer<typeof UpdateOrganizationSchema>;
