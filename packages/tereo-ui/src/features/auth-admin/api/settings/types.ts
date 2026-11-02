export type TotpPolicy = "disabled" | "optional" | "required";

export interface SystemSettings {
  totpPolicy: TotpPolicy;
  totpRecoveryCodeCount: number;
  /** The requests per second each tier of caller gets by default. */
  rateLimits: {
    perSecond: number;
    internalPerSecond: number;
    preAuthPerSecond: number;
    preAuthInternalPerSecond: number;
  };
}

export interface UpdateSettingsInput {
  totpPolicy?: TotpPolicy;
  totpRecoveryCodeCount?: number;
}
