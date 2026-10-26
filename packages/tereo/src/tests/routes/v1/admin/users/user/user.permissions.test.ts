// @module-tag int
// @module-tag auth

import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { CORE_SERVICE_ID } from "../../../../../../definitions/index.js";
import { makeServiceOf } from "../../../../../support/testService.js";
import { browserLogin } from "../../../../../support/browserLogin.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../support/auth/constants.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../support/principals.js";
import {
  createAdminUser,
  createTestRole,
  createTestUser,
} from "../../../../../support/auth/users.js";
import {
  encryptTotpSecret,
  generateTotpSecret,
} from "../../../../../../utils/totp.js";

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const NEW_PASSWORD = "An0ther-Str0ng-Passw0rd!";

describe("PATCH /v1/admin/users/:id and POST /v1/admin/users/:id/totp/reset", () => {
  let adminToken: string;
  let writerToken: string;
  let adminRoleId: string;

  beforeAll(async () => {
    const testClient = await createTestClient();
    // A service's client: its tokens carry the user's full rights. A token
    // of any other client is capped by its core scopes, which never reach
    // the `admin` an admin's credential reset needs.
    await makeServiceOf(testClient.id);
    const admin = await createAdminUser();
    adminToken = await getAccessTokenForUser(admin, testClient);
    writerToken = await getTestPrincipalToken({ permissions: ["users.write"] });
    adminRoleId = (
      await prisma.role.findFirstOrThrow({
        where: { name: "admin", serviceId: CORE_SERVICE_ID },
      })
    ).id;
  });

  const patchUser = (token: string, id: string, body: object) =>
    fetch(`${BASE_URL}/v1/admin/users/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const resetTotp = (token: string, id: string) =>
    fetch(`${BASE_URL}/v1/admin/users/${id}/totp/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

  const enrolTotp = async (userId: string) => {
    await prisma.user.update({
      where: { id: userId },
      data: {
        totpSecret: encryptTotpSecret(generateTotpSecret()),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });
  };

  const grantAdmin = async (
    userId: string,
    options: { organizationId?: string; expiresAt?: Date } = {}
  ) => {
    await prisma.userRole.create({
      data: { userId, roleId: adminRoleId, ...options },
    });
  };

  const passwordHash = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;

  it("protects a target whose roles.write role is deactivated", async () => {
    // Suspended, not archived: an admin can reactivate it.
    const role = await createTestRole();
    const permission = await prisma.permission.findFirstOrThrow({
      where: { name: "roles.write", serviceId: CORE_SERVICE_ID },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    const target = await createTestUser();
    await prisma.userRole.create({
      data: { userId: target.id, roleId: role.id },
    });
    await prisma.role.update({
      where: { id: role.id },
      data: { isActive: false },
    });
    const before = await passwordHash(target.id);

    const reset = await patchUser(writerToken, target.id, {
      password: NEW_PASSWORD,
    });
    expect(reset.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await passwordHash(target.id)).toBe(before);
    const deactivate = await patchUser(writerToken, target.id, {
      isActive: false,
    });
    expect(deactivate.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  describe("a target holding admin", () => {
    let globalAdmin: TestUser;

    beforeAll(async () => {
      globalAdmin = await createTestUser();
      await grantAdmin(globalAdmin.id);
    });

    it.each([["globally", () => globalAdmin]])(
      "refuses a users.write caller a password reset of an admin %s",
      async (_scope, target) => {
        const before = await passwordHash(target().id);
        const response = await patchUser(writerToken, target().id, {
          password: NEW_PASSWORD,
        });
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(await passwordHash(target().id)).toBe(before);
      }
    );

    it.each([["globally", () => globalAdmin]])(
      "refuses a users.write caller an email change of an admin %s",
      async (_scope, target) => {
        const response = await patchUser(writerToken, target().id, {
          email: `taken-over-${target().id}@example.com`,
        });
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        const row = await prisma.user.findUniqueOrThrow({
          where: { id: target().id },
        });
        expect(row.email).toBe(target().email);
      }
    );

    it("lets a users.write caller resend an admin's current email", async () => {
      const response = await patchUser(writerToken, globalAdmin.id, {
        email: globalAdmin.email,
      });
      expect(response.status).toBe(HTTP_STATUS.OK);
    });

    it("lets an admin change another admin's email", async () => {
      const target = await createTestUser();
      await grantAdmin(target.id);
      const email = `moved-${target.id}@example.com`;
      const response = await patchUser(adminToken, target.id, { email });
      expect(response.status).toBe(HTTP_STATUS.OK);
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(row.email).toBe(email);
    });

    it("lets a users.write caller change an admin's name", async () => {
      const response = await patchUser(writerToken, globalAdmin.id, {
        name: "Renamed Admin",
      });
      expect(response.status).toBe(HTTP_STATUS.OK);
    });

    it("lets an admin reset another admin's password and two-factor", async () => {
      const target = await createTestUser();
      await grantAdmin(target.id);
      await enrolTotp(target.id);

      expect(
        (await patchUser(adminToken, target.id, { password: NEW_PASSWORD }))
          .status
      ).toBe(HTTP_STATUS.OK);
      expect((await resetTotp(adminToken, target.id)).status).toBe(
        HTTP_STATUS.OK
      );
    });

    describe("through a third-party client's core:admin token", () => {
      let delegatedToken: string;

      beforeAll(async () => {
        // A global admin signs in to a client that is neither core's UI nor
        // a service: its core:admin scope caps it at the domains' `.admin`.
        const thirdParty = await createTestClient({
          scopes: ["openid", "core:admin"],
        });
        const caller = await createTestUser();
        await grantAdmin(caller.id);
        const redirectUri = thirdParty.redirectUris[0];
        const { code, verifier } = await browserLogin({
          clientId: thirdParty.clientId,
          redirectUri,
          scope: "openid core:admin",
          email: caller.email,
          password: caller.plainPassword,
        });
        const res = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: thirdParty.clientId,
            code_verifier: verifier,
          }),
        });
        expect(res.status).toBe(HTTP_STATUS.OK);
        delegatedToken = ((await res.json()) as { access_token: string })
          .access_token;
      });

      it("refuses an admin's password, email or two-factor reset", async () => {
        const target = await createTestUser();
        await grantAdmin(target.id);
        await enrolTotp(target.id);
        const before = await passwordHash(target.id);

        const responses = [
          await patchUser(delegatedToken, target.id, {
            password: NEW_PASSWORD,
          }),
          await patchUser(delegatedToken, target.id, {
            email: `delegated-${target.id}@example.com`,
          }),
          await resetTotp(delegatedToken, target.id),
        ];
        for (const response of responses) {
          expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
          expect(((await response.json()) as { error: string }).error).toBe(
            "forbidden"
          );
        }

        const row = await prisma.user.findUniqueOrThrow({
          where: { id: target.id },
        });
        expect(row.passwordHash).toBe(before);
        expect(row.email).toBe(target.email);
        expect(row.totpEnabled).toBe(true);
      });

      it("still resets a user who holds no admin", async () => {
        const target = await createTestUser();
        const response = await patchUser(delegatedToken, target.id, {
          password: NEW_PASSWORD,
        });
        expect(response.status).toBe(HTTP_STATUS.OK);
      });
    });

    it("ignores an expired admin assignment", async () => {
      const target = await createTestUser();
      await grantAdmin(target.id, { expiresAt: new Date(Date.now() - 1000) });
      const response = await patchUser(writerToken, target.id, {
        password: NEW_PASSWORD,
      });
      expect(response.status).toBe(HTTP_STATUS.OK);
    });
  });

  describe("a target holding permissions the caller lacks", () => {
    const inviteIdentity = (token: string, id: string) =>
      fetch(`${BASE_URL}/v1/admin/users/${id}/identity-invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        // No such provider: a caller let past the guard gets 400.
        body: JSON.stringify({ providerId: crypto.randomUUID() }),
      });

    const targetHolding = async (permissions: string[]) => {
      const target = await createTestUser();
      await getTestPrincipalToken({ userId: target.id, permissions });
      return target;
    };

    it("refuses a users.write caller a password, two-factor or identity reset of a roles.write holder", async () => {
      const target = await targetHolding(["roles.write"]);
      await enrolTotp(target.id);
      const before = await passwordHash(target.id);

      for (const response of [
        await patchUser(writerToken, target.id, { password: NEW_PASSWORD }),
        await resetTotp(writerToken, target.id),
        await inviteIdentity(writerToken, target.id),
      ]) {
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(
          ((await response.json()) as { error_description: string })
            .error_description
        ).toContain("roles.write");
      }
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(row.passwordHash).toBe(before);
      expect(row.totpEnabled).toBe(true);
    });

    it("counts a permission held through a role in an organization", async () => {
      const target = await createTestUser();
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { name: "webhooks.write" },
      });
      const role = await prisma.role.create({
        data: {
          name: `org-webhooks-${crypto.randomUUID()}`,
          displayName: "Org webhooks writer",
          rolePermissions: { create: [{ permissionId: permission.id }] },
        },
      });
      await prisma.userRole.create({
        data: {
          userId: target.id,
          roleId: role.id,
          organizationId: await ensureTestOrganization(
            "credential-resets-org-role"
          ),
        },
      });
      const response = await patchUser(writerToken, target.id, {
        password: NEW_PASSWORD,
      });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("lets a users.write caller reset a users.read holder", async () => {
      const target = await targetHolding(["users.read"]);
      await enrolTotp(target.id);
      expect(
        (await patchUser(writerToken, target.id, { password: NEW_PASSWORD }))
          .status
      ).toBe(HTTP_STATUS.OK);
      expect((await resetTotp(writerToken, target.id)).status).toBe(
        HTTP_STATUS.OK
      );
      expect((await inviteIdentity(writerToken, target.id)).status).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
    });

    it("lets a users.write + roles.admin caller reset a roles.write holder", async () => {
      const caller = await getTestPrincipalToken({
        permissions: ["users.write", "roles.admin"],
      });
      const target = await targetHolding(["roles.write"]);
      await enrolTotp(target.id);
      expect(
        (await patchUser(caller, target.id, { password: NEW_PASSWORD })).status
      ).toBe(HTTP_STATUS.OK);
      expect((await resetTotp(caller, target.id)).status).toBe(HTTP_STATUS.OK);
      expect((await inviteIdentity(caller, target.id)).status).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
    });
  });

  describe("a target managing an organization", () => {
    const memberOf = async (memberRole: "owner" | "admin" | "member") => {
      const target = await createTestUser();
      await prisma.organizationMember.create({
        data: {
          organizationId: await ensureTestOrganization(
            "credential-resets-managed-org"
          ),
          userId: target.id,
          memberRole,
        },
      });
      return target;
    };

    it("refuses a users.write caller a reset or deactivation of an owner or admin who holds no permission", async () => {
      for (const memberRole of ["owner", "admin"] as const) {
        const target = await memberOf(memberRole);
        await enrolTotp(target.id);
        const before = await passwordHash(target.id);

        for (const response of [
          await patchUser(writerToken, target.id, { password: NEW_PASSWORD }),
          await patchUser(writerToken, target.id, {
            email: `moved-${crypto.randomUUID()}@example.com`,
          }),
          await resetTotp(writerToken, target.id),
          await patchUser(writerToken, target.id, { isActive: false }),
        ]) {
          expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
          expect(
            ((await response.json()) as { error_description: string })
              .error_description
          ).toContain("organizations.write");
        }
        const row = await prisma.user.findUniqueOrThrow({
          where: { id: target.id },
        });
        expect(row.passwordHash).toBe(before);
        expect(row.email).toBe(target.email);
        expect(row.totpEnabled).toBe(true);
        expect(row.isActive).toBe(true);
      }
    });

    it("lets a users.write caller reset a plain member", async () => {
      const target = await memberOf("member");
      expect(
        (await patchUser(writerToken, target.id, { password: NEW_PASSWORD }))
          .status
      ).toBe(HTTP_STATUS.OK);
    });

    it("lets a users.write + organizations.write caller reset an owner", async () => {
      const caller = await getTestPrincipalToken({
        permissions: ["users.write", "organizations.write"],
      });
      const target = await memberOf("owner");
      expect(
        (await patchUser(caller, target.id, { password: NEW_PASSWORD })).status
      ).toBe(HTTP_STATUS.OK);
    });
  });

  describe("PATCH /admin/users/:id reactivating", () => {
    const deactivated = async (permissions: string[]) => {
      const target = await createTestUser();
      if (permissions.length > 0) {
        await getTestPrincipalToken({ userId: target.id, permissions });
      }
      await prisma.user.update({
        where: { id: target.id },
        data: { isActive: false },
      });
      return target;
    };

    it("refuses a users.write caller reactivating a roles.write holder", async () => {
      const target = await deactivated(["roles.write"]);
      const response = await patchUser(writerToken, target.id, {
        isActive: true,
      });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(
        ((await response.json()) as { error_description: string })
          .error_description
      ).toContain("roles.write");
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: target.id } }))
          .isActive
      ).toBe(false);

      const byAdmin = await patchUser(adminToken, target.id, {
        isActive: true,
      });
      expect(byAdmin.status).toBe(HTTP_STATUS.OK);
    });

    it("lets a users.write caller reactivate a user holding nothing beyond it", async () => {
      const target = await deactivated(["users.read"]);
      expect(
        (await patchUser(writerToken, target.id, { isActive: true })).status
      ).toBe(HTTP_STATUS.OK);
    });
  });
});
