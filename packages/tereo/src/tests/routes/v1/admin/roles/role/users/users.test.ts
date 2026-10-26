// @module-tag int
// @module-tag auth

import { getAccessTokenForUser } from "../../../../../../support/auth/login.js";
import { LOGIN_CLIENT } from "../../../../../../../definitions/index.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../../support/auth/constants.js";
import {
  createAdminUser,
  createTestRole,
} from "../../../../../../support/auth/users.js";

interface RoleUsersResponse {
  roleId: string;
  users: Array<{ id: string; email: string; name?: string }>;
}

let testRole: Awaited<ReturnType<typeof createTestRole>>;
let adminToken: string;

beforeAll(async () => {
  const adminUser = await createAdminUser();
  testRole = await createTestRole();
  // Through core's UI: a delegated token could not grant the test
  // service's permissions, which no core scope's ceiling covers.
  adminToken = await getAccessTokenForUser(
    adminUser,
    await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    }),
    "openid profile email"
  );
});

describe("GET /v1/admin/roles/:id/users", () => {
  it("should return 200 with users list for valid role", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${testRole.id}/users`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    const data = (await response.json()) as RoleUsersResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.roleId).toBe(testRole.id);
    expect(data.users).toBeDefined();
    expect(Array.isArray(data.users)).toBe(true);
  });

  it("should return 404 for non-existent role", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${NON_EXISTENT_UUID}/users`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});
