import { z } from "zod";

export const ServiceIdParamSchema = z.object({
  id: z.guid(),
});

export const UpdateServiceSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.isActive !== undefined, {
    message: "Nothing to update",
  });

export const AccessDecisionSchema = z.object({
  ids: z.array(z.guid()).min(1).max(100),
});
