// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { assertAdminRemains } from "../../../../../../utils/adminGuard.js";
import type { AuthContext } from "../../../../../../middleware/auth.js";
import { managedWith, tag } from "../../../../../support/scimUsers.js";
import { unlinkScimUser } from "../../../../../../utils/scim/users.js";
import { toScimError } from "../../../../../../utils/scim/errors.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CORE_SERVICE_ID,
  SYSTEM_USER_ID,
} from "../../../../../../definitions/index.js";
import {
  createScimGroup,
  patchScimGroup,
  replaceScimGroup,
} from "../../../../../../utils/scim/groups.js";
import {
  createScimConnection,
  setGroupsTarget,
} from "../../../../../support/scim.js";

// Only the sole-administrator tests change the guard, for one call; every
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

// Other suites leave administrators behind. The removal's guard call sets
// them aside in its own transaction, which the refusal rolls back, so no
// other session sees it. The group under test keeps its role.
const asSoleAdminGroupOnce = (groupId: string) =>
  vi.mocked(assertAdminRemains).mockImplementationOnce((async (removal, tx) => {
    await tx.userRole.updateMany({
      where: { organizationId: null, role: grantsAdmin },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await tx.group.updateMany({
      where: {
        id: { not: groupId },
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

/** A global group holding core's `admin` whose only member is the connection's user. */
const adminGroup = async () => {
  const c = await createScimConnection();
  await setGroupsTarget(c.connectionId, { kind: "global" });
  const ctx = {
    connection: await prisma.scimConnection.findUniqueOrThrow({
      where: { id: c.connectionId },
    }),
    provider: await prisma.identityProvider.findUniqueOrThrow({
      where: { id: c.providerId },
    }),
    tokenId: "test",
  };
  const user = await managedWith(c);
  const view = await createScimGroup(ctx, {
    displayName: `Admins ${tag()}`,
    externalId: null,
    members: [user.id],
  });
  const adminRole = await prisma.role.findFirstOrThrow({
    where: { name: "admin", serviceId: CORE_SERVICE_ID },
  });
  await prisma.groupRole.create({
    data: { groupId: view.group.id, roleId: adminRole.id, addedBy: user.id },
  });
  return { ctx, user, groupId: view.group.id };
};

const expectLastAdminRefusal = (err: unknown) =>
  expect(toScimError(err)).toMatchObject({
    status: 409,
    body: {
      detail:
        "This change would leave no active administrator; grant admin to another user first",
    },
  });

const stillMember = async (groupId: string, userId: string) =>
  expect(await prisma.groupMember.count({ where: { groupId, userId } })).toBe(
    1
  );

// The server cannot see a transaction the test holds, so these requests are
// made in-process, where the refusal's transaction can set the other
// administrators aside and roll them back with it.
describe("SCIM group removal of the only administrator", () => {
  beforeAll(async () => {
    await ensureDefaultOrganization();
  });

  it("PATCH remove is refused with a SCIM 409 and changes nothing", async () => {
    const { ctx, user, groupId } = await adminGroup();
    asSoleAdminGroupOnce(groupId);
    const err = await patchScimGroup(ctx, groupId, [
      { kind: "removeMembers", values: [user.id] },
      { kind: "displayName", value: "Renamed" },
    ]).catch((e: unknown) => e);

    expectLastAdminRefusal(err);
    await stillMember(groupId, user.id);
    expect(
      (await prisma.group.findUniqueOrThrow({ where: { id: groupId } })).name
    ).not.toBe("Renamed");
  });

  it("PUT with an empty member list is refused the same way", async () => {
    const { ctx, user, groupId } = await adminGroup();
    asSoleAdminGroupOnce(groupId);
    const err = await replaceScimGroup(ctx, groupId, {
      displayName: "Admins",
      externalId: null,
      members: [],
    }).catch((e: unknown) => e);

    expectLastAdminRefusal(err);
    await stillMember(groupId, user.id);
  });

  it("an admin unlink of the only administrator is refused and changes nothing", async () => {
    const { user, groupId } = await adminGroup();
    asSoleAdminGroupOnce(groupId);
    const err = await unlinkScimUser(
      { userId: SYSTEM_USER_ID, email: null } as unknown as AuthContext,
      user.id
    ).catch((e: unknown) => e);

    expectLastAdminRefusal(err);
    await stillMember(groupId, user.id);
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(link.unlinkedAt).toBeNull();
  });
});
