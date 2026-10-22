// @module-tag int
// @module-tag auth

import { DEFAULT_ORGANIZATION_ID } from "../../../../../../definitions/index.js";
import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { makeServiceOf } from "../../../../../support/testService.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../support/auth/constants.js";
import {
  createTestUser,
  createAdminUser,
} from "../../../../../support/auth/users.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";

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

interface RevokeAllSessionsResponse {
  revokedCount: number;
  currentSessionRevoked: boolean;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

let testClient: Awaited<ReturnType<typeof createTestClient>>;
let regularUser: Awaited<ReturnType<typeof createTestUser>>;
let adminToken: string;

beforeAll(async () => {
  testClient = await createTestClient();
  const adminUser = await createAdminUser();
  regularUser = await createTestUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
  // A live session, so the 404 for an unknown session id is not just an
  // empty session list.
  await getAccessTokenForUser(regularUser, testClient);
});

describe("DELETE /v1/admin/users/:id", () => {
  // Users are deactivated, never deleted — audit history and file
  // ownership reference them.
  it("is not routed", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${regularUser.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const row = await prisma.user.findUnique({
      where: { id: regularUser.id },
    });
    expect(row).not.toBeNull();
  });
});

describe("DELETE /v1/admin/users/:id/sessions/all", () => {
  it("should return 200 with revocation details when revoking all user sessions", async () => {
    const target = await createTestUser();
    await getAccessTokenForUser(target, testClient);
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${target.id}/sessions/all`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ includeCurrentSession: false }),
      }
    );

    const data = (await response.json()) as RevokeAllSessionsResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.revokedCount).toBeGreaterThanOrEqual(1);
    expect(data.currentSessionRevoked).toBe(false);
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/sessions/all`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ includeCurrentSession: false }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("DELETE /v1/admin/users/:id/sessions", () => {
  it("should return 204 when revoking a specific user session", async () => {
    // Create a test user and get them multiple sessions
    const sessionTestUser = await createTestUser();
    await getAccessTokenForUser(sessionTestUser, testClient);
    await getAccessTokenForUser(sessionTestUser, testClient);

    // Get user sessions
    const sessionsResponse = await fetch(
      `${BASE_URL}/v1/admin/users/${sessionTestUser.id}/sessions`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(sessionsResponse.status).toBe(HTTP_STATUS.OK);
    const sessionsData =
      (await sessionsResponse.json()) as UserSessionsResponse;
    const sessions = sessionsData.sessions;

    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    const sessionId = sessions[0].id;

    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${sessionTestUser.id}/sessions`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
  });

  it("should return 404 for non-existent session", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${regularUser.id}/sessions`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId: NON_EXISTENT_UUID }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("DELETE /v1/admin/users/:id/sessions/all with only an SSO session", () => {
  let adminToken: string;

  beforeAll(async () => {
    const testClient = await createTestClient();
    // A service's client: its tokens carry the user's full rights. A token
    // of any other client is capped by its core scopes, which never reach
    // the `admin` an admin's credential reset needs.
    await makeServiceOf(testClient.id);
    const admin = await createAdminUser();
    adminToken = await getAccessTokenForUser(admin, testClient);
  });

  // A browser can hold an SSO session with no live refresh token (a code
  // never exchanged, or its tokens already revoked). Ending it alone is
  // still a revocation: audited and emitted.
  it("audits and emits the ended SSO session", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.sessions-revoked"] }
    );
    const user = await createTestUser();
    const sso = await prisma.userSession.create({
      data: {
        tokenHash: crypto.randomUUID().replace(/-/g, ""),
        userId: user.id,
        authTime: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${user.id}/sessions/all`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await response.json()).toMatchObject({ revokedCount: 0 });
    expect(await prisma.userSession.count({ where: { id: sso.id } })).toBe(0);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityId: user.id,
        metadata: { path: ["action"], equals: "sessions_revoked" },
      },
    });
    expect(entry?.metadata).toMatchObject({
      sessionIds: [],
      ssoSessionIds: [sso.id],
    });
    await waitFor(
      async () =>
        (await prisma.webhookDelivery.count({
          where: {
            webhookEndpointId: endpoint.id,
            eventType: "auth.user.sessions-revoked",
            payload: { path: ["data", "ssoSessionIds"], equals: [sso.id] },
          },
        })) > 0,
      10_000
    );
  });
});
