// @module-tag int
// @module-tag auth
import { activeState, managedWith } from "../../../../../support/scimUsers.js";
import { assertAdminRemains } from "../../../../../../utils/adminGuard.js";
import { CORE_SERVICE_ID } from "../../../../../../definitions/index.js";
import { createScimConnection } from "../../../../../support/scim.js";
import { toScimError } from "../../../../../../utils/scim/errors.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, expect, it, vi } from "vitest";
import {
  deleteScimUser,
  patchScimUser,
} from "../../../../../../utils/scim/users.js";

// Only the sole-administrator test changes the guard, for one call; every
// other call is the real guard.
vi.mock("../../../../../../utils/adminGuard.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../../../utils/adminGuard.js")
    >();
  return {
    ...actual,
    assertAdminRemains: vi.fn(actual.assertAdminRemains),
  };
});

const grantsAdmin = {
  isActive: true,
  archivedAt: null,
  retiredAt: null,
  rolePermissions: {
    some: { permission: { name: "admin", retiredAt: null } },
  },
};

// Other suites leave admins behind. The deactivation's first guard call sets
// them aside in its own transaction, which the refusal rolls back, so no
// other session sees it.
const asSoleAdminOnce = (userId: string) =>
  vi.mocked(assertAdminRemains).mockImplementationOnce((async (removal, tx) => {
    await tx.userRole.updateMany({
      where: {
        organizationId: null,
        userId: { not: userId },
        role: grantsAdmin,
      },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await tx.group.updateMany({
      where: {
        organizationId: null,
        archivedAt: null,
        roles: { some: { role: grantsAdmin } },
      },
      data: { archivedAt: new Date() },
    });
    const { assertAdminRemains: real } = await vi.importActual<
      typeof import("../../../../../../utils/adminGuard.js")
    >("../../../../../../utils/adminGuard.js");
    await real(removal, tx);
  }) as typeof assertAdminRemains);

/** The connection's only managed user, holding core's `admin`, and its context. */
const soleAdmin = async () => {
  const c = await createScimConnection();
  const user = await managedWith(c);
  const adminRole = await prisma.role.findFirstOrThrow({
    where: { name: "admin", serviceId: CORE_SERVICE_ID },
  });
  await prisma.userRole.create({
    data: { userId: user.id, roleId: adminRole.id },
  });
  const ctx = {
    connection: await prisma.scimConnection.findUniqueOrThrow({
      where: { id: c.connectionId },
    }),
    provider: await prisma.identityProvider.findUniqueOrThrow({
      where: { id: c.providerId },
    }),
    tokenId: "test",
  };
  return { user, ctx };
};

const expectLastAdminRefusal = (err: unknown) =>
  expect(toScimError(err)).toMatchObject({
    status: 409,
    body: {
      detail:
        "This change would leave no active administrator; grant admin to another user first",
    },
  });

// The server cannot see a transaction the test holds, so these requests are
// made in-process, where the refusal's transaction can set the other
// administrators aside and roll them back with it.
describe("SCIM deactivation of the only administrator", () => {
  it("active:false is refused with 409, the user active and idpActive still true", async () => {
    const { user, ctx } = await soleAdmin();
    asSoleAdminOnce(user.id);
    const err = await patchScimUser(ctx, user.id, {
      active: false,
      firstName: "Changed",
    }).catch((e: unknown) => e);

    expectLastAdminRefusal(err);
    expect(await activeState(user.id)).toEqual({
      isActive: true,
      idpActive: true,
      adminHold: false,
    });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.firstName).toBeNull();
    expect(
      await prisma.auditLogEntry.count({
        where: { entityType: "User", entityId: user.id },
      })
    ).toBe(0);
  });

  it("DELETE is refused with 409 and sets nothing", async () => {
    const { user, ctx } = await soleAdmin();
    asSoleAdminOnce(user.id);
    const err = await deleteScimUser(ctx, user.id).catch((e: unknown) => e);

    expectLastAdminRefusal(err);
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(link).toMatchObject({ idpActive: true, deletedAt: null });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isActive
    ).toBe(true);
  });
});
