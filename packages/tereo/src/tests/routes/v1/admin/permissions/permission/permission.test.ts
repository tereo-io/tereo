// @module-tag int
// @module-tag auth

import { TEST_SERVICE } from "../../../../../support/testService.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestClient,
  createAdminUser,
  createTestPermission,
  getAccessTokenForUser,
} from "../../../../../support/auth.js";

interface PermissionResponse {
  id: string;
  name: string;
  displayName: string;
  serviceId: string;
  serviceName: string;
  retiredAt: string | null;
}

// Permissions are declared in code and registered at boot; the admin API
// only reads them. Retirement is covered with the registry (tests/registry).

let testPermission: Awaited<ReturnType<typeof createTestPermission>>;
let adminToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  testPermission = await createTestPermission();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

const get = (path: string, token?: string) =>
  fetch(`${BASE_URL}/v1/admin/permissions${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

describe("GET /v1/admin/permissions/:id", () => {
  it("gets a permission by id", async () => {
    const response = await get(`/${testPermission.id}`, adminToken);
    const data = (await response.json()) as PermissionResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.id).toBe(testPermission.id);
    expect(data.name).toBe(testPermission.name);
    expect(data.serviceName).toBe(TEST_SERVICE.name);
  });

  it("returns 404 for a non-existent permission", async () => {
    const response = await get(`/${NON_EXISTENT_UUID}`, adminToken);
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});
