import { z } from "zod";

export const TotpVerifySchema = z.object({
  session_token: z.string().min(1).max(128),
  totp_code: z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits"),
});

export const TotpRecoverySchema = z.object({
  session_token: z.string().min(1).max(128),
  recovery_code: z
    .string()
    .min(1)
    .max(64)
    .transform((val) => val.replace(/-/g, "").toUpperCase()),
});

export const TotpSetupInitiateSchema = z.object({
  setup_grant: z.string().min(1).max(128),
});

export const TotpSetupVerifySchema = z.object({
  setup_token: z.string().min(1).max(128),
  totp_code: z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits"),
});

export type TotpVerifyInput = z.infer<typeof TotpVerifySchema>;
export type TotpRecoveryInput = z.infer<typeof TotpRecoverySchema>;
export type TotpSetupInitiateInput = z.infer<typeof TotpSetupInitiateSchema>;
export type TotpSetupVerifyInput = z.infer<typeof TotpSetupVerifySchema>;
