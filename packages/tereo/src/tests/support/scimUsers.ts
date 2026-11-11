import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
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
  extra: { externalId?: string; deletedAt?: Date } = {}
) =>
  await prisma.scimUser.create({
    data: {
      connectionId,
      userId,
      userName,
      externalId: extra.externalId ?? null,
      idpActive: true,
      deletedAt: extra.deletedAt ?? null,
    },
  });

export { SYSTEM_USER_ID };
