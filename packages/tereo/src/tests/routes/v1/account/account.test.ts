// @module-tag int
// @module-tag auth

import { DEFAULT_ORGANIZATION_ID } from "../../../../definitions/index.js";
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { getAccessTokenForUser } from "../../../support/auth/login.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { createTestUser } from "../../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../support/webhooks.js";

interface AccountResponse {
  id?: string;
  email?: string;
  name?: string;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
  photoUrl?: string | null;
  roles?: Array<{
    id: string;
    name: string;
    displayName: string;
    expiresAt: string | null;
  }>;
  permissions?: string[];
  totp?: {
    enabled: boolean;
    enabledAt: string | null;
    required: boolean;
    recoveryCodesRemaining: number;
  };
  password?: string;
  passwordHash?: string;
  [key: string]: unknown;
}

interface PasswordChangeResponse {
  success: boolean;
  message: string;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

const TOO_MANY_REQUESTS = 429;
const MAX_FAILURES = 5;

const expectTooMany = async (res: Response) => {
  expect(res.status).toBe(TOO_MANY_REQUESTS);
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(0);
  const body = (await res.json()) as { error: string; retry_after: number };
  expect(body.error).toBe("too_many_requests");
  expect(body.retry_after).toBe(retryAfter);
  return retryAfter;
};

let testClient: Awaited<ReturnType<typeof createTestClient>>;
let testUser: Awaited<ReturnType<typeof createTestUser>>;
let accessToken: string;

beforeAll(async () => {
  testClient = await createTestClient();
  testUser = await createTestUser({ name: "Test User" });
  accessToken = await getAccessTokenForUser(testUser, testClient);
});

describe("GET /v1/account/me", () => {
  it("should return 200 with current user profile including all fields", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = (await response.json()) as AccountResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.id).toBe(testUser.id);
    expect(data.email).toBe(testUser.email);
    expect(data.name).toBe("Test User");
    expect(typeof data.isActive).toBe("boolean");
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
    expect(data.roles).toBeDefined();
    expect(Array.isArray(data.roles)).toBe(true);
    expect(data.permissions).toBeDefined();
    expect(Array.isArray(data.permissions)).toBe(true);
    expect(data.totp).toBeDefined();
    expect(typeof data.totp?.enabled).toBe("boolean");
  });

  it("should not return password hash in response", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = (await response.json()) as AccountResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.passwordHash).toBeUndefined();
    expect(data.password).toBeUndefined();
  });

  it("should return 401 with error response without auth token", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/me`);

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("should return 401 with error response for invalid token", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: "Bearer invalid-token" },
    });

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("POST /v1/account/password", () => {
  it("should return 200 with success message when changing password with valid current password", async () => {
    // Create a separate user for password change test
    const passwordUser = await createTestUser({
      password: "OldPassword123!",
    });
    const passwordToken = await getAccessTokenForUser(passwordUser, testClient);

    const response = await fetch(`${BASE_URL}/v1/account/password`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${passwordToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: "OldPassword123!",
        newPassword: "NewPassword456!",
      }),
    });

    const data = (await response.json()) as PasswordChangeResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.success).toBe(true);
    expect(data.message).toBe("Password changed successfully");

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityId: passwordUser.id,
        entityType: "User",
        metadata: { path: ["action"], equals: "password_changed" },
      },
    });
    expect(entry).toMatchObject({
      action: "UPDATE",
      userId: passwordUser.id,
      metadata: { action: "password_changed" },
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("OldPassword123!");
    expect(serialized).not.toContain("NewPassword456!");
  });

  it("records the other sessions it ends: audited and emitted as a revoke", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.sessions-revoked"] }
    );
    const passwordUser = await createTestUser({
      password: "OldPassword123!",
    });
    const current = await getAccessTokenForUser(passwordUser, testClient);
    await getAccessTokenForUser(passwordUser, testClient);

    const response = await fetch(`${BASE_URL}/v1/account/password`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${current}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: "OldPassword123!",
        newPassword: "NewPassword456!",
      }),
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(
      await prisma.refreshToken.count({
        where: { userId: passwordUser.id, revokedAt: null },
      })
    ).toBe(1);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityId: passwordUser.id,
        metadata: { path: ["action"], equals: "sessions_revoked" },
      },
    });
    expect(entry).toMatchObject({ userId: passwordUser.id });
    expect(
      (entry?.metadata as { sessionIds: string[] }).sessionIds
    ).toHaveLength(1);
    await waitFor(
      async () =>
        (await prisma.webhookDelivery.count({
          where: {
            webhookEndpointId: endpoint.id,
            eventType: "auth.user.sessions-revoked",
            payload: { path: ["entityId"], equals: passwordUser.id },
          },
        })) > 0,
      10_000
    );
  });

  it("should return 400 with invalid_password error for wrong current password", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/password`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: "WrongPassword123!",
        newPassword: "NewPassword456!",
      }),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("invalid_password");
    expect(data.error_description).toBe("Current password is incorrect");
  });

  it("should reject weak new password with 400 error", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/password`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: testUser.plainPassword,
        newPassword: "weak",
      }),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("invalid_request");
    expect(data.error_description).toMatch(
      /^Invalid request body\. newPassword: /
    );
  });

  it("should reject request without auth token with 401 error", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: "test",
        newPassword: "test",
      }),
    });

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("locks POST /account/password after repeated wrong current passwords", async () => {
    const user = await createTestUser();
    const token = await getAccessTokenForUser(user, testClient);
    const change = (currentPassword: string) =>
      fetch(`${BASE_URL}/v1/account/password`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword,
          newPassword: "AnotherPassword456!",
        }),
      });

    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await change("not-the-password");
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    }
    await expectTooMany(await change(user.plainPassword));

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.passwordHash).toBe(user.passwordHash);
  });
});
