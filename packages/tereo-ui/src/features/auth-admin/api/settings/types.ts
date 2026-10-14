export type TotpPolicy = "disabled" | "optional" | "required";

export interface SystemSettings {
  totpPolicy: TotpPolicy;
  totpRecoveryCodeCount: number;
}

export interface UpdateSettingsInput {
  totpPolicy?: TotpPolicy;
  totpRecoveryCodeCount?: number;
}
