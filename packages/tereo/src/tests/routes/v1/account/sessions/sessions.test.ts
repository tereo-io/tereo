// @module-tag int
// @module-tag auth

import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
} from "../../../../support/auth.js";

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
let accessToken: string;

beforeAll(async () => {
  testClient = await createTestClient();
  const testUser = await createTestUser({ name: "Test User" });
  accessToken = await getAccessTokenForUser(testUser, testClient);
});

describe("GET /v1/account/sessions", () => {
  it("should return 200 with sessions list", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/sessions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = (await response.json()) as SessionsResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.sessions).toBeDefined();
    expect(Array.isArray(data.sessions)).toBe(true);

    // Should have at least one session (the current one)
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);

    // Validate session structure
    const currentSession = data.sessions.find((s) => s.isCurrent);
    expect(currentSession).toBeDefined();
    expect(currentSession?.clientId).toBeDefined();
    expect(currentSession?.clientName).toBeDefined();
    expect(currentSession?.createdAt).toBeDefined();
    expect(currentSession?.expiresAt).toBeDefined();
  });

  it("should return 401 with error for request without auth token", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/sessions`);

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("DELETE /v1/account/sessions", () => {
  it("should return 200 with revocation details when revoking all sessions", async () => {
    // Create a separate user for session revocation test
    const sessionUser = await createTestUser();
    const sessionToken = await getAccessTokenForUser(sessionUser, testClient);

    const response = await fetch(`${BASE_URL}/v1/account/sessions`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ includeCurrentSession: false }),
    });

    const data = (await response.json()) as RevokeAllSessionsResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(typeof data.revokedCount).toBe("number");
    expect(data.currentSessionRevoked).toBe(false);
  });

  it("should return 401 with error for request without auth token", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/sessions`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeCurrentSession: false }),
    });

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});
