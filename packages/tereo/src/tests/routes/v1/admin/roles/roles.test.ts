// @module-tag int
// @module-tag auth

import { LOGIN_CLIENT } from "../../../../../definitions/index.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  createAdminUser,
  createTestRole,
  getAccessTokenForUser,
  generateUniqueId,
} from "../../../../support/auth.js";

interface RoleResponse {
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  isSystem?: boolean;
  [key: string]: unknown;
}

interface RolesListResponse {
  data?: RoleResponse[];
  roles?: RoleResponse[];
  [key: string]: unknown;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
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

describe("GET /v1/admin/roles", () => {
  it("should list roles with admin token", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const data = (await response.json()) as RolesListResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    // Response uses "data" key for the array
    expect(Array.isArray(data.data || data.roles)).toBe(true);
  });

  it("filters by isActive", async () => {
    const inactive = await createTestRole();
    await prisma.role.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });

    const list = async (name: string, isActive: string) => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles?filter[isActive]=${isActive}` +
          `&filter[name]=${name}&filter[name_op]=equals`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
      const data = (await response.json()) as RolesListResponse;
      return (data.data ?? []).map((r) => r.id);
    };

    expect(await list(testRole.name, "true")).toEqual([testRole.id]);
    expect(await list(testRole.name, "false")).toEqual([]);
    expect(await list(inactive.name, "false")).toEqual([inactive.id]);
    expect(await list(inactive.name, "true")).toEqual([]);
  });
});

describe("POST /v1/admin/roles", () => {
  it("should create a new role", async () => {
    const uniqueId = generateUniqueId();
    const newRoleData = {
      name: `new-role-${uniqueId}`,
      displayName: `New Role ${uniqueId}`,
      description: "A newly created test role",
    };

    const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(newRoleData),
    });

    const data = (await response.json()) as RoleResponse;

    expect(response.status).toBe(HTTP_STATUS.CREATED);
    expect(data.name).toBe(newRoleData.name);
    expect(data.displayName).toBe(newRoleData.displayName);
  });

  it("should reject duplicate role name", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: testRole.name,
        displayName: "Duplicate Role",
      }),
    });

    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    expect(((await response.json()) as ErrorResponse).error).toBe("name_taken");
  });
});
