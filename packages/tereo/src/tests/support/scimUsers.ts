import type { sessionLifecycleHelpers } from "./auth/sessionLifecycle.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { createTestUser } from "./auth/users.js";
import { randomBytes } from "node:crypto";

export const tag = () => randomBytes(5).toString("hex");

export const makeUser = async (
  email: string,
  opts: {
    userType?: "human" | "guest" | "service_account";
    isActive?: boolean;
  } = {}
) => {
  const userType = opts.userType ?? "human";
  return await prisma.user.create({
    data: {
      email,
      name: "Test Person",
      userType,
      isActive: opts.isActive ?? true,
      ...(userType === "guest" && {
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    },
  });
};

export const manage = async (
  connectionId: string,
  userId: string,
  userName: string,
  extra: { externalId?: string; deletedAt?: Date; unlinkedAt?: Date } = {}
) =>
  await prisma.scimUser.create({
    data: {
      connectionId,
      userId,
      userName,
      userNameKey: userName.toLowerCase(),
      externalId: extra.externalId ?? null,
      idpActive: true,
      deletedAt: extra.deletedAt ?? null,
      unlinkedAt: extra.unlinkedAt ?? null,
    },
  });

/** A managed user's state as the invariant reads it. */
export const activeState = async (userId: string) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { scimLink: true },
  });
  return {
    isActive: user.isActive,
    idpActive: user.scimLink?.idpActive,
    adminHold: user.scimLink?.adminHold,
  };
};

/**
 * A user managed by the connection whose `is_active` follows the link's
 * `idpActive` and `adminHold` (default true and false).
 */
export const managedWith = async (
  c: { connectionId: string; domain: string },
  link: { idpActive?: boolean; adminHold?: boolean; deletedAt?: Date } = {}
) => {
  const idpActive = link.idpActive ?? true;
  const adminHold = link.adminHold ?? false;
  const user = await makeUser(`m-${tag()}@${c.domain}`, {
    isActive: idpActive && !adminHold,
  });
  const row = await manage(c.connectionId, user.id, user.email, {
    deletedAt: link.deletedAt,
  });
  await prisma.scimUser.update({
    where: { id: row.id },
    data: { idpActive, adminHold },
  });
  return user;
};

/** A managed user who signed in with a password, and their tokens. */
export const signedInManagedUser = async (
  c: { connectionId: string; domain: string; organizationId: string },
  login: ReturnType<typeof sessionLifecycleHelpers>["login"]
) => {
  const user = await createTestUser({ email: `m-${tag()}@${c.domain}` });
  await prisma.organizationMember.create({
    data: { organizationId: c.organizationId, userId: user.id },
  });
  await manage(c.connectionId, user.id, user.email);
  const { tokens } = await login({
    id: user.id,
    email: user.email,
    password: user.plainPassword,
    orgId: c.organizationId,
  });
  return { user, tokens };
};

export { SYSTEM_USER_ID };
