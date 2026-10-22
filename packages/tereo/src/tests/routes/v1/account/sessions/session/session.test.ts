// @module-tag int
// @module-tag auth

import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
} from "../../../../../support/auth.js";

interface SessionsResponse {
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

let testClient: Awaited<ReturnType<typeof createTestClient>>;
let accessToken: string;

beforeAll(async () => {
  testClient = await createTestClient();
  const testUser = await createTestUser({ name: "Test User" });
  accessToken = await getAccessTokenForUser(testUser, testClient);
});

describe("DELETE /v1/account/sessions/:sessionId", () => {
  it("should return 204 when revoking a specific session", async () => {
    // Create a separate user for session-specific revocation test
    const sessionUser = await createTestUser();
    const sessionToken = await getAccessTokenForUser(sessionUser, testClient);

    // Get another session for the same user by creating a second token
    await getAccessTokenForUser(sessionUser, testClient);

    // List sessions to get a session ID
    const listResponse = await fetch(`${BASE_URL}/v1/account/sessions`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });

    expect(listResponse.status).toBe(HTTP_STATUS.OK);
    const sessionsData = (await listResponse.json()) as SessionsResponse;
    const sessions = sessionsData.sessions;

    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // Find a non-current session to revoke
    const nonCurrentSession = sessions.find((s) => !s.isCurrent);
    expect(nonCurrentSession).toBeDefined();
    const response = await fetch(
      `${BASE_URL}/v1/account/sessions/${nonCurrentSession!.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${sessionToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
  });

  it("should return 401 with error for request without auth token", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/sessions/123`, {
      method: "DELETE",
    });

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("should return 404 for non-existent session", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/account/sessions/${NON_EXISTENT_UUID}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});
