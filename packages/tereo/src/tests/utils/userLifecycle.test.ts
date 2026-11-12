// @module-tag int
// @module-tag auth

import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { SYSTEM_USER, SYSTEM_USER_ID } from "../../definitions/index.js";
import { ensureTestOrganization } from "../support/principals.js";
import { getAccessTokenForUser } from "../support/auth/login.js";
import { createTestClient } from "../support/auth/clients.js";
import { describe, it, expect, beforeAll } from "vitest";
import { ConflictError } from "../../utils/errors.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  createUserInOrganizationTx,
  deactivateUser,
} from "../../utils/userLifecycle.js";
import {
  createAdminUser,
  createTestRole,
  createTestUser,
} from "../support/auth/users.js";

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, email: SYSTEM_USER.email };

class Rollback extends Error {}

beforeAll(async () => {
  await ensureDefaultOrganization();
});

describe("deactivateUser", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    testClient = await createTestClient();
  });

  it("deactivates as the system actor, audits it and revokes the user's sessions", async () => {
    const user = await createTestUser();
    await getAccessTokenForUser(user, testClient);
    const before = await prisma.refreshToken.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    expect(before.length).toBeGreaterThan(0);

    const updated = await deactivateUser(SYSTEM_ACTOR, user);

    expect(updated.isActive).toBe(false);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isActive
    ).toBe(false);
    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "User", entityId: user.id, action: "UPDATE" },
    });
    const deactivation = entries.filter(
      (e) => (e.changes as Record<string, unknown> | null)?.isActive
    );
    expect(deactivation).toHaveLength(1);
    expect(deactivation[0]).toMatchObject({
      userId: SYSTEM_USER_ID,
      writerUserId: SYSTEM_USER_ID,
      changes: { isActive: { old: true, new: false } },
    });
    const live = await prisma.refreshToken.count({
      where: { id: { in: before.map((rt) => rt.id) }, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it("refuses to deactivate the only administrator", async () => {
    const admin = await createAdminUser();

    // Other suites leave admins behind: set them aside in the deactivation's
    // own transaction, which always rolls back.
    const attempt = deactivateUser(SYSTEM_ACTOR, admin, {
      authorize: async (tx) => {
        await tx.userRole.updateMany({
          where: {
            organizationId: null,
            userId: { not: admin.id },
            role: {
              rolePermissions: {
                some: { permission: { name: "admin", retiredAt: null } },
              },
            },
          },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });
        await tx.group.updateMany({
          where: {
            organizationId: null,
            archivedAt: null,
            roles: {
              some: {
                role: {
                  rolePermissions: {
                    some: { permission: { name: "admin", retiredAt: null } },
                  },
                },
              },
            },
          },
          data: { archivedAt: new Date() },
        });
      },
      alsoInTx: async () => {
        throw new Rollback();
      },
    });

    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toBe(
      "This change would leave no active administrator; grant admin to another user first"
    );
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }))
        .isActive
    ).toBe(true);
  });
});

describe("createUserInOrganizationTx", () => {
  it("creates the member with the given roles and writes provisioning's audit entries", async () => {
    const organizationId = await ensureTestOrganization("users-lifecycle");
    const role = await createTestRole();
    const email = `created-${randomUUID()}@users.test.local`;

    const user = await prisma.$transaction((tx) =>
      createUserInOrganizationTx(
        tx,
        SYSTEM_ACTOR,
        { email, name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" },
        { organizationId, roleIds: [role.id] },
        { providerId: "test-provider" }
      )
    );

    expect(user).toMatchObject({
      email,
      name: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      passwordHash: null,
    });
    const member = await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId, userId: user.id },
    });
    expect(member.memberRole).toBe("member");
    const roles = await prisma.userRole.findMany({
      where: { organizationId, userId: user.id },
    });
    expect(roles.map((r) => r.roleId)).toEqual([role.id]);

    const audit = await prisma.auditLogEntry.findMany({
      where: { userId: SYSTEM_USER_ID, entityName: email },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => [a.action, a.entityType]).sort()).toEqual([
      ["CREATE", "OrganizationMember"],
      ["CREATE", "User"],
      ["UPDATE", "OrganizationMember"],
    ]);
    expect(audit.find((a) => a.entityType === "User")?.metadata).toEqual({
      email,
      name: "Ada Lovelace",
      userType: "human",
      providerId: "test-provider",
    });
  });
});
