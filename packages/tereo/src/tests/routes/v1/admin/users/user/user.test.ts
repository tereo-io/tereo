// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { generateUniqueId } from "../../../../../support/auth/crypto.js";
import { makeServiceOf } from "../../../../../support/testService.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../support/auth/constants.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../../../../definitions/index.js";
import {
  createTestUser,
  createAdminUser,
} from "../../../../../support/auth/users.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";

interface UserResponse {
  id?: string;
  email?: string;
  name?: string;
  isActive?: boolean;
  password?: string;
  passwordHash?: string;
  [key: string]: unknown;
}

interface PermissionsListResponse {
  userId: string;
  permissions: string[];
}

interface UserRolesResponse {
  userId: string;
  roles: Array<{
    id: string;
    name: string;
    displayName: string;
    expiresAt: string | null;
  }>;
}

interface UserSessionsResponse {
  userId: string;
  sessions: Array<{
    id: string;
    clientId: string;
    clientName: string;
    scopes: string[];
    createdAt: string;
    expiresAt: string;
    isCurrent: boolean;
  }>;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

const NEW_PASSWORD = "An0ther-Str0ng-Passw0rd!";

let testClient: Awaited<ReturnType<typeof createTestClient>>;
let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
let regularUser: Awaited<ReturnType<typeof createTestUser>>;
let adminToken: string;

beforeAll(async () => {
  testClient = await createTestClient();
  adminUser = await createAdminUser();
  regularUser = await createTestUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("GET /v1/admin/users/:id", () => {
  it("should get user by ID", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${regularUser.id}`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    const data = (await response.json()) as UserResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.id).toBe(regularUser.id);
    expect(data.email).toBe(regularUser.email);
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe("PATCH /v1/admin/users/:id", () => {
  it("should update user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${regularUser.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Updated Name" }),
      }
    );

    const data = (await response.json()) as UserResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.name).toBe("Updated Name");
  });

  it("lower-cases a new email and refuses one taken in another case", async () => {
    const writer = await getTestPrincipalToken({
      permissions: ["users.write"],
    });
    const target = await createTestUser();
    const patch = (email: string) =>
      fetch(`${BASE_URL}/v1/admin/users/${target.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${writer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      });

    const taken = await patch(regularUser.email.toUpperCase());
    expect(taken.status).toBe(HTTP_STATUS.CONFLICT);

    const renamed = `Renamed-${generateUniqueId()}@Test.Local`;
    const response = await patch(renamed);
    expect(response.status).toBe(HTTP_STATUS.OK);
    const data = (await response.json()) as UserResponse;
    expect(data.email).toBe(renamed.toLowerCase());
  });

  it("should update user active status", async () => {
    const target = await createTestUser();
    const response = await fetch(`${BASE_URL}/v1/admin/users/${target.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isActive: false }),
    });

    const data = (await response.json()) as UserResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.isActive).toBe(false);

    // Restore active status
    await fetch(`${BASE_URL}/v1/admin/users/${target.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isActive: true }),
    });
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Test" }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  const patch = (id: string, body: unknown, token = adminToken) =>
    fetch(`${BASE_URL}/v1/admin/users/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  it("refuses to let an admin deactivate their own account", async () => {
    const response = await patch(adminUser.id, { isActive: false });
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("self_deactivation");

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: adminUser.id },
    });
    expect(row.isActive).toBe(true);
  });

  it("keeps password hashes out of the audit entry", async () => {
    const target = await createTestUser();
    const response = await patch(target.id, {
      name: "Renamed",
      password: "An0ther-Str0ng-Passw0rd!",
    });
    expect(response.status).toBe(HTTP_STATUS.OK);

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityId: target.id, entityType: "User", action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(entry.changes)).not.toContain("passwordHash");
    expect(JSON.stringify(entry.changes)).not.toContain("$argon2");
    expect(entry.changes).toMatchObject({
      name: { new: "Renamed" },
    });
    expect(entry.metadata).toMatchObject({ passwordReset: true });
  });

  it("does not let a user be bound to an OAuth client", async () => {
    const target = await createTestUser();
    const response = await patch(target.id, {
      oauthClientId: testClient.id,
    });
    expect(response.status).toBe(HTTP_STATUS.OK);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.oauthClientId).toBeNull();
  });

  it("refuses a service's account, which /admin/services manages", async () => {
    const created = await fetch(`${BASE_URL}/v1/admin/services`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `svcuser${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      }),
    });
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    const { id } = (await created.json()) as { id: string };
    const service = await prisma.service.findUniqueOrThrow({
      where: { id },
      include: { client: { include: { serviceAccountUser: true } } },
    });
    const accountId = service.client!.serviceAccountUser!.id;

    const response = await patch(accountId, { isActive: false });
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: accountId },
    });
    expect(row.isActive).toBe(true);
  });

  describe("system user", () => {
    it("cannot be modified through the admin API", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${SYSTEM_USER_ID}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("system_user");
    });
  });
});

describe("GET /v1/admin/users/:id/roles", () => {
  it("should return 200 with user roles list", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${adminUser.id}/roles`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    const data = (await response.json()) as UserRolesResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.userId).toBe(adminUser.id);
    expect(data.roles).toBeDefined();
    expect(Array.isArray(data.roles)).toBe(true);
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/roles`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("GET /v1/admin/users/:id/permissions", () => {
  it("should return 200 with user effective permissions", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${adminUser.id}/permissions`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    const data = (await response.json()) as PermissionsListResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.userId).toBe(adminUser.id);
    expect(data.permissions).toBeDefined();
    expect(Array.isArray(data.permissions)).toBe(true);
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/permissions`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("GET /v1/admin/users/:id/sessions", () => {
  it("should return 200 with user sessions list", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${adminUser.id}/sessions`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    const data = (await response.json()) as UserSessionsResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.userId).toBe(adminUser.id);
    expect(data.sessions).toBeDefined();
    expect(Array.isArray(data.sessions)).toBe(true);
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/sessions`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("PATCH /v1/admin/users/:id with a password", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let writerToken: string;

  beforeAll(async () => {
    testClient = await createTestClient();
    // A service's client: its tokens carry the user's full rights. A token
    // of any other client is capped by its core scopes, which never reach
    // the `admin` an admin's credential reset needs.
    await makeServiceOf(testClient.id);
    writerToken = await getTestPrincipalToken({ permissions: ["users.write"] });
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

  /** A user signed in once through the login flow: a session and a token. */
  const signedInUser = async () => {
    const user = await createTestUser();
    const token = await getAccessTokenForUser(user, testClient);
    expect(await liveSessions(user.id)).toBeGreaterThan(0);
    return { user, token };
  };

  const liveSessions = (userId: string) =>
    prisma.refreshToken.count({ where: { userId, revokedAt: null } });

  const userinfo = (token: string) =>
    fetch(`${BASE_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  const passwordHash = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;

  it("ends every session and token family, audited and emitted as a revoke", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.sessions-revoked"] }
    );
    const { user, token } = await signedInUser();
    const before = await passwordHash(user.id);

    const response = await patchUser(writerToken, user.id, {
      password: NEW_PASSWORD,
    });
    expect(response.status).toBe(HTTP_STATUS.OK);

    expect(await passwordHash(user.id)).not.toBe(before);
    expect(await liveSessions(user.id)).toBe(0);
    expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(
      0
    );
    expect((await userinfo(token)).status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityId: user.id,
        metadata: { path: ["action"], equals: "sessions_revoked" },
      },
    });
    expect(entry).toMatchObject({ action: "UPDATE" });
    await waitFor(
      async () =>
        (await prisma.webhookDelivery.count({
          where: {
            webhookEndpointId: endpoint.id,
            eventType: "auth.user.sessions-revoked",
            payload: { path: ["entityId"], equals: user.id },
          },
        })) > 0,
      10_000
    );
  });

  it("leaves sessions alone when no password is set", async () => {
    const { user, token } = await signedInUser();
    const response = await patchUser(writerToken, user.id, {
      name: "Just A Rename",
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await liveSessions(user.id)).toBeGreaterThan(0);
    expect((await userinfo(token)).status).toBe(HTTP_STATUS.OK);
  });

  it("ends sessions when deactivating and resetting together", async () => {
    const { user } = await signedInUser();
    const response = await patchUser(writerToken, user.id, {
      password: NEW_PASSWORD,
      isActive: false,
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await liveSessions(user.id)).toBe(0);
  });

  it("keeps the caller's own session when they reset their own password", async () => {
    const admin = await createAdminUser();
    const current = await getAccessTokenForUser(admin, testClient);
    const other = await getAccessTokenForUser(admin, testClient);
    expect(await liveSessions(admin.id)).toBe(2);

    const response = await patchUser(current, admin.id, {
      password: NEW_PASSWORD,
    });
    expect(response.status).toBe(HTTP_STATUS.OK);

    expect(await liveSessions(admin.id)).toBe(1);
    expect((await userinfo(current)).status).toBe(HTTP_STATUS.OK);
    expect((await userinfo(other)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });
});
