import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeServiceOf } from "../utils/testService.js";
import { hashFlowToken } from "../../utils/crypto.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  OAUTH_ERRORS,
  createTestClient,
  createTestUser,
  createTestPermission,
  createTestRole,
} from "./utils/test-helpers.js";

interface CheckPermissionResponse {
  granted?: boolean;
  error?: string;
  error_description?: string;
}

interface CheckPermissionsResponse {
  results?: Record<string, boolean>;
  error?: string;
  error_description?: string;
}

describe("OAuth Check Permission Endpoints", () => {
  let confidentialClient: Awaited<ReturnType<typeof createTestClient>>;
  let publicClient: Awaited<ReturnType<typeof createTestClient>>;
  let testUser: Awaited<ReturnType<typeof createTestUser>>;
  let testPermission: Awaited<ReturnType<typeof createTestPermission>>;
  let testRole: Awaited<ReturnType<typeof createTestRole>>;
  let hashedSecret: string;

  beforeAll(async () => {
    // Create a confidential client with a hashed secret
    const uniqueId = Math.random().toString(36).substring(2, 10);
    const plainSecret = `test-secret-${uniqueId}`;
    hashedSecret = hashFlowToken(plainSecret);

    // Create test owner user
    const testOwner = await createTestUser({
      email: `test-owner-${uniqueId}@test.local`,
    });

    // Create confidential client directly in DB with hashed secret
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: `test-confidential-${uniqueId}`,
        clientSecret: hashedSecret,
        clientType: "confidential",
        name: `Test Confidential Client ${uniqueId}`,
        redirectUris: ["http://localhost:3000/callback"],
        postLogoutRedirectUris: ["http://localhost:3000/logout"],
        scopes: ["openid", "profile", "email"],
        grantTypes: ["authorization_code", "refresh_token"],
        audience: [],
        ownerId: testOwner.id,
      },
    });

    confidentialClient = {
      ...client,
      plainSecret: plainSecret,
    } as typeof confidentialClient;
    // Only a service's client, or an organization's, may check permissions.
    await makeServiceOf(client.id);

    publicClient = await createTestClient({ clientType: "public" });

    // Create test user with a permission
    testUser = await createTestUser();
    testPermission = await createTestPermission();
    testRole = await createTestRole();

    // Assign permission to role
    await prisma.rolePermission.create({
      data: {
        roleId: testRole.id,
        permissionId: testPermission.id,
      },
    });

    // Assign role to user
    await prisma.userRole.create({
      data: {
        userId: testUser.id,
        roleId: testRole.id,
      },
    });
  });

  afterAll(async () => {
    // Clean up the manually created confidential client
    if (confidentialClient) {
      await prisma.oAuthClient
        .delete({ where: { id: confidentialClient.id } })
        .catch(() => {});
    }
  });

  function getBasicAuthHeader(clientId: string, clientSecret: string): string {
    return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64"
    )}`;
  }

  describe("POST /oauth/check-permission", () => {
    it("should return 200 with granted=true for valid permission check", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: testUser.id,
          permission: testPermission.name,
        }),
      });

      const data = (await response.json()) as CheckPermissionResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.granted).toBe(true);
      expect(data.error).toBeUndefined();
    });

    it("should return 200 with granted=false for permission user doesn't have", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: testUser.id,
          permission: "nonexistent.permission",
        }),
      });

      const data = (await response.json()) as CheckPermissionResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.granted).toBe(false);
      expect(data.error).toBeUndefined();
    });

    it("should return 401 with invalid_client error without authentication", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: testUser.id,
          permission: testPermission.name,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as CheckPermissionResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_CLIENT);
    });

    it("should return 401 with invalid_client error for public client (requires confidential)", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            publicClient.clientId,
            "fake-secret"
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: testUser.id,
          permission: testPermission.name,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as CheckPermissionResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_CLIENT);
    });

    it("should return 401 with invalid_client error for invalid client secret", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            "wrong-secret"
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: testUser.id,
          permission: testPermission.name,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as CheckPermissionResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_CLIENT);
    });

    it("should return 401 with invalid_client error for unknown client", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader("unknown-client", "any-secret"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: testUser.id,
          permission: testPermission.name,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as CheckPermissionResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_CLIENT);
    });

    it("should return 403 for non-existent user", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: NON_EXISTENT_UUID,
          permission: testPermission.name,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(((await response.json()) as { error: string }).error).toBe(
        "forbidden"
      );
    });

    it("should return 400 with invalid_request error without user_id", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          permission: testPermission.name,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as CheckPermissionResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });

    it("should return 400 with invalid_request error without permission", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: testUser.id,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as CheckPermissionResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });

    it("should return 400 with invalid_request error for non-numeric user_id", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: "not-a-number",
          permission: testPermission.name,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as CheckPermissionResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });
  });

  describe("POST /oauth/check-permission/batch", () => {
    it("should return 200 with results for multiple permissions", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission/batch`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: testUser.id,
          permissions: [testPermission.name, "nonexistent.permission"],
        }),
      });

      const data = (await response.json()) as CheckPermissionsResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.results).toBeDefined();
      expect(data.results![testPermission.name]).toBe(true);
      expect(data.results!["nonexistent.permission"]).toBe(false);
      expect(data.error).toBeUndefined();
    });

    it("should return 200 with all false for user with no permissions", async () => {
      // Create a user without any permissions
      const userWithoutPerms = await createTestUser();

      const response = await fetch(`${BASE_URL}/oauth/check-permission/batch`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: userWithoutPerms.id,
          permissions: [testPermission.name, "another.permission"],
        }),
      });

      const data = (await response.json()) as CheckPermissionsResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.results).toBeDefined();
      expect(data.results![testPermission.name]).toBe(false);
      expect(data.results!["another.permission"]).toBe(false);
    });

    it("should return 401 with invalid_client error without authentication", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: testUser.id,
          permissions: [testPermission.name],
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as CheckPermissionsResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_CLIENT);
    });

    it("should return 400 with invalid_request error for empty permissions array", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission/batch`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: testUser.id,
          permissions: [],
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as CheckPermissionsResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });

    it("should return 400 with invalid_request error without permissions field", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission/batch`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: testUser.id,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as CheckPermissionsResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });

    it("should return 403 for non-existent user in batch check", async () => {
      const response = await fetch(`${BASE_URL}/oauth/check-permission/batch`, {
        method: "POST",
        headers: {
          Authorization: getBasicAuthHeader(
            confidentialClient.clientId,
            confidentialClient.plainSecret!
          ),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: NON_EXISTENT_UUID,
          permissions: [testPermission.name],
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(((await response.json()) as { error: string }).error).toBe(
        "forbidden"
      );
    });
  });
});
