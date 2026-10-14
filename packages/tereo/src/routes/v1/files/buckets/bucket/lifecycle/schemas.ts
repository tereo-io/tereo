import { z } from "zod";

export const lifecyclePolicyBodySchema = z.object({
  expireObjectsAfterDays: z.coerce
    .number()
    .int()
    .positive()
    .max(3650)
    .nullish(),
  expireVersionsAfterDays: z.coerce
    .number()
    .int()
    .positive()
    .max(3650)
    .nullish(),
  purgeSoftDeletedAfterDays: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(3650)
    .nullish(),
  enabled: z.boolean().optional(),
});

export type LifecyclePolicyBody = z.infer<typeof lifecyclePolicyBodySchema>;
