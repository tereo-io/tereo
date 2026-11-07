import { hashPassword } from "../../../utils/crypto.js";
import { prisma } from "../../../utils/db/prisma.js";
import { generateUniqueId } from "./crypto.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A guest with a password and a `member` membership in the organization,
 * written straight to the database. `roleIds` are assigned in that
 * organization without the checks the admin API applies to guests.
 */
export async function createTestGuest(options: {
  organizationId: string;
  expiresAt?: Date;
  password?: string;
  roleIds?: string[];
}) {
  const uniqueId = generateUniqueId();
  const plainPassword = options.password ?? "TestPassword123!";
  const user = await prisma.user.create({
    data: {
      email: `test-guest-${uniqueId}@test.local`,
      name: `Test Guest ${uniqueId}`,
      passwordHash: await hashPassword(plainPassword),
      userType: "guest",
      expiresAt: options.expiresAt ?? new Date(Date.now() + DAY_MS),
    },
  });
  await prisma.organizationMember.create({
    data: {
      organizationId: options.organizationId,
      userId: user.id,
      memberRole: "member",
    },
  });
  if (options.roleIds?.length) {
    await prisma.userRole.createMany({
      data: options.roleIds.map((roleId) => ({
        userId: user.id,
        roleId,
        organizationId: options.organizationId,
      })),
    });
  }
  return { user, plainPassword };
}
