// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  CORE_SERVICE_ID,
  LOGIN_CLIENT,
} from "../../../../../../definitions/index.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  createAdminUser,
  createTestRole,
  getAccessTokenForUser,
} from "../../../../../support/auth.js";

let adminToken: string;
let regularToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  const regularUser = await createTestUser();
  // Through core's UI: a delegated token could not grant the test
  // service's permissions, which no core scope's ceiling covers.
  adminToken = await getAccessTokenForUser(
    adminUser,
    await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    }),
    "openid profile email"
  );
  regularToken = await getAccessTokenForUser(regularUser, testClient);
});

describe("PATCH /v1/admin/roles/:id", () => {
  it("refuses a roles.write caller without admin changing core's admin role's requires2fa", async () => {
    const adminRole = await prisma.role.findFirstOrThrow({
      where: { name: "admin", serviceId: CORE_SERVICE_ID },
    });
    const writer = await getTestPrincipalToken({
      permissions: ["roles.write"],
    });
    try {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${adminRole.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${writer}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requires2fa: !adminRole.requires2fa }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(
        (await prisma.role.findUniqueOrThrow({ where: { id: adminRole.id } }))
          .requires2fa
      ).toBe(adminRole.requires2fa);
    } finally {
      await prisma.role.update({
        where: { id: adminRole.id },
        data: { requires2fa: adminRole.requires2fa },
      });
    }
  });

  it("lets a caller holding everything a role grants change its requires2fa", async () => {
    const role = await createTestRole();
    const response = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requires2fa: true }),
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  describe("permission checks come before the archive state", () => {
    it("answers 403, not 409, to a roles.read caller on an archived role", async () => {
      const role = await createTestRole();
      await prisma.role.update({
        where: { id: role.id },
        data: { isActive: false, archivedAt: new Date() },
      });
      const readOnly = await getTestPrincipalToken({
        permissions: ["roles.read"],
      });

      const response = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${readOnly}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Nope" }),
      });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const asAdmin = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Nope" }),
      });
      expect(asAdmin.status).toBe(HTTP_STATUS.CONFLICT);
    });
  });
});

describe("DELETE /v1/admin/roles/:id", () => {
  it("should return 403 when deleting a system role", async () => {
    const systemRole = await createTestRole({ isSystem: true });

    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${systemRole.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(
      await prisma.role.findUnique({ where: { id: systemRole.id } })
    ).not.toBeNull();
  });
});

describe("POST /v1/admin/roles/:id/archive and /restore", () => {
  async function deactivateRole(roleId: string) {
    const response = await fetch(`${BASE_URL}/v1/admin/roles/${roleId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isActive: false }),
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
  }

  async function archiveRole(roleId: string, token = adminToken) {
    return fetch(`${BASE_URL}/v1/admin/roles/${roleId}/archive`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("should return 403 when archiving a system role", async () => {
    const systemRole = await createTestRole({ isSystem: true });

    const response = await archiveRole(systemRole.id);
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

    const row = await prisma.role.findUnique({
      where: { id: systemRole.id },
    });
    expect(row?.archivedAt).toBeNull();
  });

  it("should return 403 for archive without permission", async () => {
    const role = await createTestRole();
    await deactivateRole(role.id);

    const response = await archiveRole(role.id, regularToken);
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("should return 403 (not 409) for unauthorized callers on live and archived roles alike", async () => {
    const liveRole = await createTestRole();
    const archivedRole = await createTestRole();
    await deactivateRole(archivedRole.id);
    await archiveRole(archivedRole.id);

    // Same status for both ids — an unauthorized caller must not be able
    // to distinguish archived rows (409) from live ones (403).
    for (const id of [liveRole.id, archivedRole.id]) {
      const response = await fetch(`${BASE_URL}/v1/admin/roles/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${regularToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Should Not Apply" }),
      });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    }
  });
});
