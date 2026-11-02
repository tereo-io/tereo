import { z } from "zod";

// Strict so that read-only fields in the GET response, such as `rateLimits`,
// are refused instead of silently dropped.
export const UpdateSettingsSchema = z
  .object({
    totpPolicy: z.enum(["disabled", "optional", "required"]).optional(),
    totpRecoveryCodeCount: z.number().int().min(5).max(20).optional(),
  })
  .strict();

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
