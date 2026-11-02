import { z } from "zod";

export const ServiceIdParamSchema = z.object({
  id: z.guid(),
});

export const UpdateServiceSchema = z
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

export const AccessDecisionSchema = z.object({
  ids: z.array(z.guid()).min(1).max(100),
});
