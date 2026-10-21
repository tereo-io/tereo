import { prisma, type Prisma } from "./prisma.js";

export type TotpPolicy = "disabled" | "optional" | "required";

export interface SystemSettings {
  totpPolicy: TotpPolicy;
  totpRecoveryCodeCount: number;
}

const DEFAULT_SETTINGS: SystemSettings = {
  totpPolicy: "optional",
  totpRecoveryCodeCount: 10,
};

export const get = async <T = string>(
  key: string,
  defaultValue?: T
): Promise<T | undefined> => {
  const setting = await prisma.systemSetting.findUnique({ where: { key } });
  if (!setting) return defaultValue;

  try {
    return JSON.parse(setting.value) as T;
  } catch {
    return setting.value as T;
  }
};

export const set = async (
  key: string,
  value: unknown,
  tx?: Prisma.TransactionClient
): Promise<void> => {
  const stringValue = typeof value === "string" ? value : JSON.stringify(value);

  await (tx ?? prisma).systemSetting.upsert({
    where: { key },
    update: { value: stringValue },
    create: { key, value: stringValue },
  });
};

export const getAll = async (
  tx?: Prisma.TransactionClient
): Promise<Record<string, unknown>> => {
  const settings = await (tx ?? prisma).systemSetting.findMany();

  const result: Record<string, unknown> = {};
  for (const setting of settings) {
    try {
      result[setting.key] = JSON.parse(setting.value);
    } catch {
      result[setting.key] = setting.value;
    }
  }

  return result;
};

export const remove = async (key: string): Promise<void> => {
  await prisma.systemSetting.delete({ where: { key } });
};

export const getTotpSettings = async (
  tx?: Prisma.TransactionClient
): Promise<SystemSettings> => {
  const allSettings = await getAll(tx);

  return {
    totpPolicy:
      (allSettings.totpPolicy as TotpPolicy) ?? DEFAULT_SETTINGS.totpPolicy,
    totpRecoveryCodeCount:
      (allSettings.totpRecoveryCodeCount as number) ??
      DEFAULT_SETTINGS.totpRecoveryCodeCount,
  };
};

export const updateTotpSettings = async (
  updates: Partial<SystemSettings>,
  tx?: Prisma.TransactionClient
): Promise<SystemSettings> => {
  if (updates.totpPolicy !== undefined) {
    await set("totpPolicy", updates.totpPolicy, tx);
  }
  if (updates.totpRecoveryCodeCount !== undefined) {
    await set("totpRecoveryCodeCount", updates.totpRecoveryCodeCount, tx);
  }
  return getTotpSettings(tx);
};

export const getTotpPolicy = async (): Promise<TotpPolicy> => {
  return (await get<TotpPolicy>("totpPolicy")) ?? DEFAULT_SETTINGS.totpPolicy;
};

/** Serializes changes to the 2FA settings for the rest of `tx`. */
export const lockTotpSettings = async (
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"core:settings:totp"}, 0))`;
};
