import { z } from "zod";

export const UpdateSettingsSchema = z.object({
  totpPolicy: z.enum(["disabled", "optional", "required"]).optional(),
  totpRecoveryCodeCount: z.number().int().min(5).max(20).optional(),
});

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
