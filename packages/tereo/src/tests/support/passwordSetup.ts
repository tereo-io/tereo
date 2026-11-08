import { issuePasswordLink } from "../../utils/userLinks.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";

export const createGuest = async (over: { expiresAt?: Date | null } = {}) => {
  const id = randomBytes(6).toString("hex");
  return prisma.user.create({
    data: {
      email: `guest-${id}@test.local`,
      name: `Guest ${id}`,
      userType: "guest",
      passwordHash: null,
      passwordChangeRequired: true,
      expiresAt:
        over.expiresAt === undefined
          ? new Date(Date.now() + 86_400_000)
          : over.expiresAt,
    },
  });
};

export const issue = async (
  userId: string,
  notify = false,
  purpose: "setup" | "reset" = "setup"
) => {
  const { url } = await prisma.$transaction((tx) =>
    issuePasswordLink(tx, {
      userId,
      purpose,
      createdBy: SYSTEM_USER_ID,
      notify,
    })
  );
  return new URL(url).hash.replace("#token=", "");
};
