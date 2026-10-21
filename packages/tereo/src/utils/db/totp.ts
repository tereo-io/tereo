import { Prisma } from "../../../prisma/generated/client/index.js";
import { liveAssignmentsWhere } from "./roles.js";
import { getTotpPolicy } from "./settings.js";
import { hashFlowToken } from "../crypto.js";
import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";

export interface TotpStatus {
  totpEnabled: boolean;
  totpEnabledAt: Date | null;
  totpRequired: boolean;
  recoveryCodesRemaining: number;
}

export interface TotpVerificationData {
  id: string;
  userId: string;
  tokenHash: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string | null;
  maxAge: number | null;
  acrValues: string | null;
  prompt: string | null;
  firstFactor: string[];
  provider: string | null;
  pendingLinkId: string | null;
  expiresAt: Date;
}

export interface TotpSetupGrantData {
  id: string;
  tokenHash: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string | null;
  maxAge: number | null;
  acrValues: string | null;
  prompt: string | null;
  firstFactor: string[];
  expiresAt: Date;
}

export interface TotpSetupSessionData {
  id: string;
  userId: string;
  tokenHash: string;
  totpSecret: string;
  expiresAt: Date;
  clientId: string | null;
  redirectUri: string | null;
  state: string | null;
  scope: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  nonce: string | null;
  maxAge: number | null;
  acrValues: string | null;
  prompt: string | null;
}

/**
 * Whether a role the user holds requires 2FA. The assignments counted are the
 * ones that grant permissions (`liveAssignmentsWhere`), in the scope of every
 * active organization the user belongs to: 2FA is decided at sign-in, before
 * an organization is chosen, so it must hold for whichever one is chosen. The
 * same scope applies wherever the requirement is reported or enforced, so a
 * user cannot turn off what the next sign-in would demand.
 */
export const userRolesRequire2fa = async (userId: string): Promise<boolean> => {
  const required = await prisma.userRole.count({
    where: {
      AND: [
        liveAssignmentsWhere(userId, "memberships"),
        { role: { requires2fa: true } },
      ],
    },
  });
  return required > 0;
};

export const getUserTotpStatus = async (
  userId: string
): Promise<TotpStatus> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpEnabled: true, totpEnabledAt: true },
  });

  if (!user) throw new NotFoundError("User not found");

  const recoveryCodesRemaining = await prisma.recoveryCode.count({
    where: { userId, usedAt: null },
  });

  return {
    totpEnabled: user.totpEnabled,
    totpEnabledAt: user.totpEnabledAt,
    totpRequired: await userRequires2fa(userId),
    recoveryCodesRemaining,
  };
};

/**
 * Whether the user must use 2FA, enrolled or not: the policy is `required`,
 * or it is `optional` and a role they hold requires it.
 */
export const userRequires2fa = async (userId: string): Promise<boolean> => {
  const policy = await getTotpPolicy();
  if (policy === "disabled") return false;
  if (policy === "required") return true;
  return await userRolesRequire2fa(userId);
};

/** Whether a login by the user asks for a second factor. */
export const userNeedsTotp = async (userId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpEnabled: true },
  });
  if (!user) throw new NotFoundError("User not found");
  if (user.totpEnabled) return true;
  return await userRequires2fa(userId);
};

// A code from `step` may still be accepted: none from it or a later step was.
const unclaimedWindow = (step: number): Prisma.UserWhereInput => ({
  OR: [{ totpLastWindow: null }, { totpLastWindow: { lt: step } }],
});

/**
 * Enables TOTP with the secret whose code, from `step`, the user just entered.
 * False when TOTP is already on or that step was already used.
 */
export const enableTotp = async (
  userId: string,
  encryptedSecret: string,
  step: number,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const { count } = await (tx ?? prisma).user.updateMany({
    where: { id: userId, totpEnabled: false, ...unclaimedWindow(step) },
    data: {
      totpSecret: encryptedSecret,
      totpEnabled: true,
      totpEnabledAt: new Date(),
      totpLastWindow: step,
    },
  });
  return count === 1;
};

/**
 * Records `step` as the user's last accepted TOTP step. False when a code
 * from it or a later step was already accepted, so this one is a replay. The
 * update is conditional, so two concurrent submissions of one code race for
 * the row and only one wins.
 */
export const claimTotpWindow = async (
  userId: string,
  step: number,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const { count } = await (tx ?? prisma).user.updateMany({
    where: { id: userId, totpEnabled: true, ...unclaimedWindow(step) },
    data: { totpLastWindow: step },
  });
  return count === 1;
};

export const disableTotp = async (
  userId: string,
  tx?: Prisma.TransactionClient
) => {
  if (tx) {
    await tx.user.update({
      where: { id: userId },
      data: {
        totpSecret: null,
        totpEnabled: false,
        totpEnabledAt: null,
        totpLastWindow: null,
      },
    });
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.totpSetupSession.deleteMany({ where: { userId } });
    return;
  }
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        totpSecret: null,
        totpEnabled: false,
        totpEnabledAt: null,
        totpLastWindow: null,
      },
    }),
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.totpSetupSession.deleteMany({ where: { userId } }),
  ]);
};

export const getUserTotpSecret = async (
  userId: string
): Promise<string | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true },
  });

  return user?.totpSecret ?? null;
};

export const storeRecoveryCodes = async (
  userId: string,
  hashedCodes: string[],
  tx?: Prisma.TransactionClient
) => {
  if (tx) {
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({
      data: hashedCodes.map((codeHash) => ({ userId, codeHash })),
    });
    return;
  }
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({
      data: hashedCodes.map((codeHash) => ({ userId, codeHash })),
    }),
  ]);
};

export const getUnusedRecoveryCodes = async (
  userId: string
): Promise<{ id: string; codeHash: string }[]> => {
  return await prisma.recoveryCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true },
  });
};

/** Marks the code used; false when it already was. */
export const claimRecoveryCode = async (
  codeId: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const { count } = await (tx ?? prisma).recoveryCode.updateMany({
    where: { id: codeId, usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1;
};

export const createVerificationSession = async (
  {
    sessionToken,
    ...data
  }: {
    userId: string;
    sessionToken: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string | null;
    codeChallenge: string;
    codeChallengeMethod: string;
    nonce: string | null;
    maxAge?: number | null;
    acrValues?: string | null;
    prompt?: string | null;
    /** How the user got this far; `["pwd"]` when omitted. */
    firstFactor?: string[];
    provider?: string | null;
    /** A forced link that commits only once this step passes. */
    pendingLinkId?: string;
    expiresAt: Date;
  },
  tx?: Prisma.TransactionClient
): Promise<TotpVerificationData> => {
  return await (tx ?? prisma).totpVerification.create({
    data: { ...data, tokenHash: hashFlowToken(sessionToken) },
  });
};

export const getVerificationSession = async (
  sessionToken: string
): Promise<TotpVerificationData | null> => {
  return await prisma.totpVerification.findUnique({
    where: { tokenHash: hashFlowToken(sessionToken) },
  });
};

/** Deletes the session; false when another request already consumed it. */
export const consumeVerificationSession = async (
  id: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const { count } = await (tx ?? prisma).totpVerification.deleteMany({
    where: { id },
  });
  return count === 1;
};

export const deleteVerificationSession = async (id: string) => {
  await prisma.totpVerification.delete({ where: { id } });
};

export const cleanupExpiredVerificationSessions = async (): Promise<number> => {
  const result = await prisma.totpVerification.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
};

export const createSetupGrant = async (
  data: Omit<TotpSetupGrantData, "id" | "firstFactor"> & {
    firstFactor?: string[];
  },
  tx?: Prisma.TransactionClient
): Promise<TotpSetupGrantData> => {
  return await (tx ?? prisma).totpSetupGrant.create({ data });
};

export const getSetupGrant = async (
  tokenHash: string
): Promise<TotpSetupGrantData | null> => {
  return await prisma.totpSetupGrant.findUnique({ where: { tokenHash } });
};

// Returns false when another request already consumed the grant.
export const consumeSetupGrant = async (
  id: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const result = await (tx ?? prisma).totpSetupGrant.deleteMany({
    where: { id },
  });
  return result.count === 1;
};

export const cleanupExpiredSetupGrants = async (): Promise<number> => {
  const result = await prisma.totpSetupGrant.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
};

export const createSetupSession = async (
  {
    setupToken,
    ...data
  }: {
    userId: string;
    setupToken: string;
    totpSecret: string;
    expiresAt: Date;
    clientId?: string;
    redirectUri?: string;
    state?: string;
    scope?: string;
    codeChallenge?: string | null;
    codeChallengeMethod?: string | null;
    nonce?: string | null;
    maxAge?: number | null;
    acrValues?: string | null;
    prompt?: string | null;
  },
  tx?: Prisma.TransactionClient
): Promise<TotpSetupSessionData> => {
  const db = tx ?? prisma;
  await db.totpSetupSession.deleteMany({ where: { userId: data.userId } });
  return await db.totpSetupSession.create({
    data: { ...data, tokenHash: hashFlowToken(setupToken) },
  });
};

export const getSetupSession = async (
  setupToken: string
): Promise<TotpSetupSessionData | null> => {
  return await prisma.totpSetupSession.findUnique({
    where: { tokenHash: hashFlowToken(setupToken) },
  });
};

export const deleteSetupSession = async (
  id: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  await db.totpSetupSession.delete({ where: { id } });
};

export const cleanupExpiredSetupSessions = async (): Promise<number> => {
  const result = await prisma.totpSetupSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
};
