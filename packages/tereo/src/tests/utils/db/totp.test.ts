// @module-tag int
// @module-tag auth
import { createTestRole, createTestUser } from "../../support/auth/users.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import db from "../../../utils/db/index.js";
import {
  addTestOrgMember,
  createTestOrganization,
} from "../../support/auth/organizations.js";

const CLIENT_IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

const call = (method: string, path: string, token: string, body?: unknown) =>
  // Its own client address: the limiters run at production values.
  fetchJson(method, `${BASE_URL}${path}`, token, body, {
    "X-Forwarded-For": CLIENT_IP,
  });

const permissionId = async (name: string) =>
  (await prisma.permission.findUniqueOrThrow({ where: { name } })).id;

/** A custom role granting `permissions`. */
const roleWith = async (
  permissions: string[],
  options: { requires2fa?: boolean } = {}
) => {
  const role = await createTestRole();
  for (const name of permissions) {
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: await permissionId(name) },
    });
  }
  if (options.requires2fa) {
    await prisma.role.update({
      where: { id: role.id },
      data: { requires2fa: true },
    });
  }
  return role;
};

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

describe("db.totp", () => {
  describe("roles requiring 2FA", () => {
    const requiring = async () => roleWith([], { requires2fa: true });

    const required = async (userId: string) => ({
      needs: await db.totp.userNeedsTotp(userId),
      status: (await db.totp.getUserTotpStatus(userId)).totpRequired,
      roles: await db.totp.userRolesRequire2fa(userId),
    });
    const all = (value: boolean) => ({
      needs: value,
      status: value,
      roles: value,
    });

    it("count a global assignment", async () => {
      const user = await createTestUser();
      const role = await requiring();
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id },
      });
      expect(await required(user.id)).toEqual(all(true));

      const token = await getTestPrincipalToken({
        userId: user.id,
        permissions: [],
      });
      const me = await call("GET", "/v1/account/me", token);
      expect(me.body.totp.required).toBe(true);
    });

    it("ignore an expired assignment", async () => {
      const user = await createTestUser();
      const role = await requiring();
      await prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      expect(await required(user.id)).toEqual(all(false));
    });

    it("ignore a retired or inactive role", async () => {
      const user = await createTestUser();
      const retired = await requiring();
      const inactive = await requiring();
      await prisma.role.update({
        where: { id: retired.id },
        data: { retiredAt: new Date() },
      });
      await prisma.role.update({
        where: { id: inactive.id },
        data: { isActive: false },
      });
      await prisma.userRole.createMany({
        data: [
          { userId: user.id, roleId: retired.id },
          { userId: user.id, roleId: inactive.id },
        ],
      });
      expect(await required(user.id)).toEqual(all(false));
    });

    it("count an org-scoped assignment in an active organization the user belongs to", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);
      const role = await requiring();
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id, organizationId: org.id },
      });
      expect(await required(user.id)).toEqual(all(true));

      // Deactivated, the organization cannot be chosen at sign-in.
      await prisma.organization.update({
        where: { id: org.id },
        data: { isActive: false },
      });
      expect(await required(user.id)).toEqual(all(false));
    });

    it("ignore an org-scoped assignment without the membership", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      const role = await requiring();
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id, organizationId: org.id },
      });
      expect(await required(user.id)).toEqual(all(false));
    });
  });
});
