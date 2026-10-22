// @module-tag int
// @module-tag auth

import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  CORE_SERVICE,
  CORE_SERVICE_ID,
} from "../../../../../definitions/index.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createAdminUser,
  createTestUser,
  createTestPermission,
  getAccessTokenForUser,
} from "../../../../support/auth.js";

interface PermissionResponse {
  id: string;
  name: string;
  displayName: string;
  serviceId: string;
  serviceName: string;
  retiredAt: string | null;
}

interface PermissionsListResponse {
  data: PermissionResponse[];
}

// Permissions are declared in code and registered at boot; the admin API
// only reads them. Retirement is covered with the registry (tests/registry).

let testPermission: Awaited<ReturnType<typeof createTestPermission>>;
let adminToken: string;
let regularToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  const regularUser = await createTestUser();
  testPermission = await createTestPermission();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
  regularToken = await getAccessTokenForUser(regularUser, testClient);
});

const get = (path: string, token?: string) =>
  fetch(`${BASE_URL}/v1/admin/permissions${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

describe("GET /v1/admin/permissions", () => {
  it("lists permissions, core's among them, with their owner", async () => {
    const response = await get(
      "?filter[name]=users.read&filter[name_op]=equals",
      adminToken
    );
    const data = (await response.json()) as PermissionsListResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].serviceId).toBe(CORE_SERVICE_ID);
    expect(data.data[0].serviceName).toBe(CORE_SERVICE.name);
  });

  it("hides retired permissions unless includeRetired=true", async () => {
    const retired = await createTestPermission();
    await prisma.permission.update({
      where: { id: retired.id },
      data: { retiredAt: new Date() },
    });
    const filter = `filter[name]=${retired.name}&filter[name_op]=equals`;

    const hidden = (await (
      await get(`?${filter}`, adminToken)
    ).json()) as PermissionsListResponse;
    expect(hidden.data).toHaveLength(0);

    const shown = (await (
      await get(`?${filter}&includeRetired=true`, adminToken)
    ).json()) as PermissionsListResponse;
    expect(shown.data).toHaveLength(1);
    expect(shown.data[0].retiredAt).not.toBeNull();
  });

  it("rejects a request without a token", async () => {
    expect((await get("")).status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("rejects a caller without permissions.read", async () => {
    expect((await get("", regularToken)).status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});

describe("POST /v1/admin/permissions, PATCH and DELETE /v1/admin/permissions/:id, POST /v1/admin/permissions/:id/archive and /restore: writes are gone", () => {
  it.each([
    ["POST", ""],
    ["PATCH", "/:id"],
    ["DELETE", "/:id"],
    ["POST", "/:id/archive"],
    ["POST", "/:id/restore"],
  ])("%s %s is 404", async (method, path) => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/permissions${path.replace(":id", testPermission.id)}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "x.read", displayName: "X" }),
      }
    );
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});
