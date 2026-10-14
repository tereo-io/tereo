import { z } from "zod";

export const VerifySetupSchema = z.object({
  setupToken: z.string().min(1),
  totpCode: z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits"),
});

export const DisableTotpSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits"),
});

export const RegenerateRecoveryCodesSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits"),
});

export type VerifySetupInput = z.infer<typeof VerifySetupSchema>;
export type DisableTotpInput = z.infer<typeof DisableTotpSchema>;
export type RegenerateRecoveryCodesInput = z.infer<
  typeof RegenerateRecoveryCodesSchema
>;
