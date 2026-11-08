// @module-tag int
// @module-tag auth
import { ensurePermission, TEST_SERVICE } from "../../support/testService.js";
import { createTestRole, createTestUser } from "../../support/auth/users.js";
import { ensureTestOrganization } from "../../support/principals.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { createTestGuest } from "../../support/auth/guests.js";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import db from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";

const APP_PERMISSION = `${TEST_SERVICE.namespace}.guest-floor.read`;

const newOrg = () => ensureTestOrganization(`guest-floor-${randomUUID()}`);

/** A role carrying `permissions`, written straight to the database. */
const roleWith = async (
  permissions: string[],
  options: { guestAssignable?: boolean; requires2fa?: boolean } = {}
) => {
  const role = await createTestRole();
  await prisma.role.update({
    where: { id: role.id },
    data: {
      guestAssignable: options.guestAssignable ?? true,
      requires2fa: options.requires2fa ?? false,
    },
  });
  for (const name of permissions) {
    const permission = await ensurePermission(name);
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
  }
  return role;
};

const appPermission = async () => {
  await ensurePermission(APP_PERMISSION);
  await prisma.permission.update({
    where: { name: APP_PERMISSION },
    data: { orgAssignable: true },
  });
  return APP_PERMISSION;
};

const setGuestAssignable = (roleId: string, guestAssignable: boolean) =>
  prisma.role.update({ where: { id: roleId }, data: { guestAssignable } });

const setPolicy = (value: string) =>
  prisma.systemSetting.upsert({
    where: { key: "totpPolicy" },
    update: { value },
    create: { key: "totpPolicy", value },
  });

afterEach(async () => {
  await setPolicy("optional");
});

describe("db.roles guest permission floor", () => {
  it("guest holds a guest-assignable role's permissions", async () => {
    const organizationId = await newOrg();
    const role = await roleWith([
      "file-service.objects.read",
      await appPermission(),
    ]);
    const { user } = await createTestGuest({
      organizationId,
      roleIds: [role.id],
    });

    expect(await db.roles.getUserPermissions(user.id, organizationId)).toEqual(
      [APP_PERMISSION, "file-service.objects.read"].sort()
    );
    expect(await db.roles.getUserPermissionsAnywhere(user.id)).toEqual(
      [APP_PERMISSION, "file-service.objects.read"].sort()
    );
  });

  it("core permissions outside the floor are dropped", async () => {
    const organizationId = await newOrg();
    // `users.read` is global-only; the others are org-assignable but not
    // guest permissions, so only the floor keeps them out.
    const role = await roleWith([
      "file-service.objects.read",
      "file-service.objects.delete",
      "webhooks.read",
      "users.read",
      await appPermission(),
    ]);
    const { user } = await createTestGuest({
      organizationId,
      roleIds: [role.id],
    });

    const expected = [APP_PERMISSION, "file-service.objects.read"].sort();
    expect(await db.roles.getUserPermissions(user.id, organizationId)).toEqual(
      expected
    );
    expect(await db.roles.getUserPermissionsAnywhere(user.id)).toEqual(
      expected
    );
  });

  it("unflagging a role makes it inert for guests", async () => {
    const organizationId = await newOrg();
    const role = await roleWith([
      "file-service.objects.read",
      "file-service.objects.write",
    ]);
    const { user } = await createTestGuest({
      organizationId,
      roleIds: [role.id],
    });

    const bucket = await prisma.bucket.create({
      data: {
        name: `guest-floor-${randomUUID()}`,
        createdBy: SYSTEM_USER_ID,
        ownerId: SYSTEM_USER_ID,
        organizationId,
      },
    });
    await prisma.bucketPermission.create({
      data: {
        bucketId: bucket.id,
        userId: user.id,
        canRead: true,
        canWrite: true,
        grantedBy: SYSTEM_USER_ID,
      },
    });
    const token = await getTestPrincipalToken({
      userId: user.id,
      organizationId,
      permissions: [],
    });
    const myPermissions = async () => {
      const res = await fetch(
        `${CORE_URL}/v1/files/buckets/${bucket.name}/my-permissions`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      return await res.json();
    };

    expect(await myPermissions()).toStrictEqual({
      canRead: true,
      canWrite: true,
      canDelete: false,
      canRevokeShares: false,
      coreManaged: false,
    });

    await setGuestAssignable(role.id, false);
    expect(await db.roles.getUserPermissions(user.id, organizationId)).toEqual(
      []
    );
    expect(await myPermissions()).toStrictEqual({
      canRead: false,
      canWrite: false,
      canDelete: false,
      canRevokeShares: false,
      coreManaged: false,
    });

    await setGuestAssignable(role.id, true);
    expect(await db.roles.getUserPermissions(user.id, organizationId)).toEqual([
      "file-service.objects.read",
      "file-service.objects.write",
    ]);
    expect(await myPermissions()).toStrictEqual({
      canRead: true,
      canWrite: true,
      canDelete: false,
      canRevokeShares: false,
      coreManaged: false,
    });
  });

  it("global assignments do not count for guests", async () => {
    const organizationId = await newOrg();
    const role = await roleWith([
      "file-service.objects.read",
      await appPermission(),
    ]);
    const { user } = await createTestGuest({ organizationId });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });

    expect(await db.roles.getUserPermissions(user.id, organizationId)).toEqual(
      []
    );
    expect(await db.roles.getUserPermissions(user.id)).toEqual([]);
    expect(await db.roles.getUserPermissionsAnywhere(user.id)).toEqual([]);
  });

  it("humans are unaffected", async () => {
    const organizationId = await newOrg();
    const user = await createTestUser();
    await prisma.organizationMember.create({
      data: { organizationId, userId: user.id },
    });
    const orgRole = await roleWith(
      ["file-service.objects.delete", "webhooks.read"],
      { guestAssignable: false }
    );
    const globalRole = await roleWith(["users.read"], {
      guestAssignable: false,
    });
    await prisma.userRole.createMany({
      data: [
        { userId: user.id, roleId: orgRole.id, organizationId },
        { userId: user.id, roleId: globalRole.id },
      ],
    });

    expect(await db.roles.getUserPermissions(user.id, organizationId)).toEqual([
      "file-service.objects.delete",
      "users.read",
      "webhooks.read",
    ]);
  });

  it("instance totpPolicy=required does not force a guest", async () => {
    const organizationId = await newOrg();
    const { user } = await createTestGuest({ organizationId });
    const human = await createTestUser();

    await setPolicy("required");
    expect(await db.totp.userNeedsTotp(user.id)).toBe(false);
    expect(await db.totp.userRequires2fa(user.id)).toBe(false);
    expect(await db.totp.userNeedsTotp(human.id)).toBe(true);

    const role = await roleWith([], { requires2fa: true });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, organizationId },
    });
    expect(await db.totp.userNeedsTotp(user.id)).toBe(true);

    await setPolicy("disabled");
    expect(await db.totp.userNeedsTotp(user.id)).toBe(false);
  });

  it("2FA counts only a guest's guest-assignable org roles", async () => {
    const organizationId = await newOrg();
    const { user } = await createTestGuest({ organizationId });
    const unflagged = await roleWith([], {
      guestAssignable: false,
      requires2fa: true,
    });
    const flaggedGlobal = await roleWith([], { requires2fa: true });
    await prisma.userRole.createMany({
      data: [
        { userId: user.id, roleId: unflagged.id, organizationId },
        { userId: user.id, roleId: flaggedGlobal.id },
      ],
    });

    expect(await db.totp.userRolesRequire2fa(user.id)).toBe(false);
    expect(await db.totp.userNeedsTotp(user.id)).toBe(false);
  });
});
