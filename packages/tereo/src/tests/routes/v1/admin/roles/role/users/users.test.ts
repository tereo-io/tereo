// @module-tag int
// @module-tag auth

import { LOGIN_CLIENT } from "../../../../../../../definitions/index.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestClient,
  createTestUser,
  createAdminUser,
  createTestRole,
  getAccessTokenForUser,
} from "../../../../../../support/auth.js";

interface RoleUsersResponse {
  roleId: string;
  users: Array<{ id: string; email: string; name?: string }>;
}

let testRole: Awaited<ReturnType<typeof createTestRole>>;
let adminToken: string;
let regularToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  const regularUser = await createTestUser();
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
  regularToken = await getAccessTokenForUser(regularUser, testClient);
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

  it("should reject request without admin token", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${testRole.id}/users`,
      {
        headers: { Authorization: `Bearer ${regularToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});
