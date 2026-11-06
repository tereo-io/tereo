// @module-tag int
// @module-tag auth
import { GUEST_DEFAULT_ROLES_KEY } from "../../../../../../utils/guestRoles.js";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { BASE_URL } from "../../../../../support/auth/constants.js";
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import env from "../../../../../../env.js";
import {
  createTestPermission,
  createTestRole,
} from "../../../../../support/auth/users.js";

const URL = `${BASE_URL}/v1/admin/guests/options`;

let inviterToken: string;

beforeAll(async () => {
  inviterToken = await getTestPrincipalToken({
    permissions: ["users.guests.write"],
  });
});

afterEach(async () => {
  await prisma.systemSetting.deleteMany({
    where: { key: GUEST_DEFAULT_ROLES_KEY },
  });
});

/** A custom role with one permission, guest-assignable unless told not. */
const createRole = async ({
  guestAssignable = true,
  orgAssignable = true,
  isActive = true,
  archived = false,
} = {}) => {
  const permission = await createTestPermission();
  await prisma.permission.update({
    where: { id: permission.id },
    data: { orgAssignable },
  });
  const role = await createTestRole();
  return prisma.role.update({
    where: { id: role.id },
    data: {
      guestAssignable,
      isActive,
      archivedAt: archived ? new Date() : null,
      rolePermissions: { create: { permissionId: permission.id } },
    },
  });
};

const setDefaultRoles = (roleIds: string[]) =>
  prisma.systemSetting.upsert({
    where: { key: GUEST_DEFAULT_ROLES_KEY },
    update: { value: JSON.stringify(roleIds) },
    create: { key: GUEST_DEFAULT_ROLES_KEY, value: JSON.stringify(roleIds) },
  });

describe("GET /v1/admin/guests/options", () => {
  it("lists only the roles a guest may be given now, for a caller without roles.read", async () => {
    const assignable = await createRole();
    const unflagged = await createRole({ guestAssignable: false });
    const inactive = await createRole({ isActive: false });
    const archived = await createRole({ archived: true });
    const notOrgAssignable = await createRole({ orgAssignable: false });

    const res = await fetchJson("GET", URL, inviterToken);

    expect(res.status).toBe(200);
    const ids = res.body.roles.map((r: { id: string }) => r.id);
    expect(ids).toContain(assignable.id);
    for (const refused of [unflagged, inactive, archived, notOrgAssignable]) {
      expect(ids).not.toContain(refused.id);
    }
    expect(
      res.body.roles.find((r: { id: string }) => r.id === assignable.id)
    ).toEqual({
      id: assignable.id,
      name: assignable.name,
      displayName: assignable.displayName,
      description: assignable.description,
    });
    expect(res.body.maxTtlSeconds).toBe(env.GUEST_MAX_TTL_SECONDS);
  });

  it("returns the defaults that are still guest-assignable", async () => {
    const kept = await createRole();
    const dropped = await createRole({ guestAssignable: false });
    await setDefaultRoles([kept.id, dropped.id]);

    const res = await fetchJson("GET", URL, inviterToken);

    expect(res.status).toBe(200);
    expect(res.body.defaultRoleIds).toEqual([kept.id]);
  });

  it("refuses a caller with only users.guests.read", async () => {
    const token = await getTestPrincipalToken({
      permissions: ["users.guests.read"],
    });
    const res = await fetchJson("GET", URL, token);
    expect(res.status).toBe(403);
  });
});
