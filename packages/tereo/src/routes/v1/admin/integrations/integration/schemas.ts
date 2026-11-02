import { z } from "zod";

export const IntegrationIdParamSchema = z.object({
  id: z.guid(),
});

export const UpdateIntegrationSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
    rateLimitPerSecond: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .nullable()
      .optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.isActive !== undefined ||
      b.rateLimitPerSecond !== undefined,
    {
      message: "Nothing to update",
    }
  );

export const SetIntegrationRolesSchema = z.object({
  roleIds: z.array(z.guid()).max(100),
});

export const SetIntegrationAudiencesSchema = z.object({
  slugs: z.array(z.string().min(1).max(64)).max(100),
});
