import { encryptTotpSecret, generateTotpSecret } from "../../utils/totp.js";
import { DEFAULT_ORGANIZATION_ID } from "../../definitions/index.js";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../webhooks/utils/test-helpers.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestClient,
  createTestUser,
  generateTotpCode,
  getAccessTokenForUser,
  getUiAccessTokenForUser,
} from "./utils/test-helpers.js";

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

interface PasswordChangeResponse {
  success: boolean;
  message: string;
}

interface TotpStatusResponse {
  totpEnabled: boolean;
  totpEnabledAt?: string | null;
  totpRequired: boolean;
  recoveryCodesRemaining?: number;
  [key: string]: unknown;
}

interface TotpSetupResponse {
  secret?: string;
  qrCodeUri?: string;
  setupToken?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

describe("Account Endpoints", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let testUser: Awaited<ReturnType<typeof createTestUser>>;
  let accessToken: string;
  // 2FA setup is only for core's UI, on a fresh login.
  let uiToken: string;

  beforeAll(async () => {
    testClient = await createTestClient();
    testUser = await createTestUser({ name: "Test User" });
    accessToken = await getAccessTokenForUser(testUser, testClient);
    uiToken = await getUiAccessTokenForUser(testUser);
  });

  describe("GET /account/me", () => {
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

  describe("POST /account/password", () => {
    it("should return 200 with success message when changing password with valid current password", async () => {
      // Create a separate user for password change test
      const passwordUser = await createTestUser({
        password: "OldPassword123!",
      });
      const passwordToken = await getAccessTokenForUser(
        passwordUser,
        testClient
      );

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
      expect(data.error).toBeDefined();
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
  });

  describe("GET /account/sessions", () => {
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

  describe("DELETE /account/sessions", () => {
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

  describe("GET /account/totp", () => {
    it("should get TOTP status", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const data = (await response.json()) as TotpStatusResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(typeof data.totpEnabled).toBe("boolean");
    });

    it("should reject request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp`);

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("POST /account/totp/setup", () => {
    it("should initiate TOTP setup", async () => {
      // Create a separate user for TOTP setup test
      const totpUser = await createTestUser();
      const totpToken = await getUiAccessTokenForUser(totpUser);

      const response = await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${totpToken}` },
      });

      const data = (await response.json()) as TotpSetupResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.secret).toBeDefined();
      expect(typeof data.secret).toBe("string");
      expect(data.qrCodeUri).toBeDefined();
      expect(data.qrCodeUri).toContain("otpauth://");
      expect(data.setupToken).toBeDefined();
      expect(typeof data.setupToken).toBe("string");

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityType: "User",
          entityId: totpUser.id,
          metadata: { path: ["action"], equals: "totp_setup_started" },
        },
      });
      expect(entry).toMatchObject({ action: "UPDATE", userId: totpUser.id });
    });

    it("should reject request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("refuses a token issued to any client but core's UI", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("refuses a UI token without a recent login with 403 reauth_required", async () => {
      // Minted directly, so it carries no auth_time.
      const token = await getTestPrincipalToken({ permissions: [] });
      const response = await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toBe("reauth_required");
    });
  });

  describe("DELETE /account/photo", () => {
    it("should return 404 when no photo exists to delete", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/photo`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 401 with error for request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/photo`, {
        method: "DELETE",
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("POST /account/photo", () => {
    it("should reject request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/photo`, {
        method: "POST",
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should reject request without photo data", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      // Should fail without proper multipart form data
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 413 payload_too_large for a photo over the size limit", async () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" }),
        "big.png"
      );
      const response = await fetch(`${BASE_URL}/v1/account/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });

      const data = (await response.json()) as ErrorResponse;
      expect(response.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
      expect(data.error).toBe("payload_too_large");
    });

    it("should return 413 payload_too_large for too many text fields", async () => {
      const form = new FormData();
      for (let i = 0; i < 50; i++) form.append(`field${i}`, "x");
      form.append(
        "file",
        new Blob([new Uint8Array(16)], { type: "image/png" }),
        "small.png"
      );
      const response = await fetch(`${BASE_URL}/v1/account/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });

      const data = (await response.json()) as ErrorResponse;
      expect(response.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
      expect(data.error).toBe("payload_too_large");
    });

    it("should return 400 invalid_request for an unexpected file field", async () => {
      const form = new FormData();
      form.append(
        "photo",
        new Blob([new Uint8Array(16)], { type: "image/png" }),
        "small.png"
      );
      const response = await fetch(`${BASE_URL}/v1/account/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });

      const data = (await response.json()) as ErrorResponse;
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe("invalid_request");
    });

    it("sets and removes the photo with an audit entry and auth.user.updated for each", async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.user.updated"] }
      );
      const photoUser = await createTestUser();
      const where = {
        webhookEndpointId: endpoint.id,
        eventType: "auth.user.updated",
        payload: { path: ["entityId"], equals: photoUser.id },
      };
      const updates = () => prisma.webhookDelivery.count({ where });
      const token = await getAccessTokenForUser(photoUser, testClient);
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(64)], { type: "image/png" }),
        "me.png"
      );

      const upload = await fetch(`${BASE_URL}/v1/account/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      expect(upload.status).toBe(HTTP_STATUS.CREATED);
      const stored = await prisma.user.findUniqueOrThrow({
        where: { id: photoUser.id },
      });
      expect(stored.photoObjectId).toBeTruthy();
      const changed = await prisma.auditLogEntry.findFirst({
        where: {
          entityType: "User",
          entityId: photoUser.id,
          metadata: { path: ["action"], equals: "photo_changed" },
        },
      });
      expect(changed?.metadata).toMatchObject({
        photoObjectId: stored.photoObjectId,
      });
      await waitFor(async () => (await updates()) === 1, 10_000);
      const delivery = await prisma.webhookDelivery.findFirstOrThrow({
        where,
      });
      expect(delivery.payload).toMatchObject({
        entityType: "User",
        data: { id: photoUser.id, email: photoUser.email },
      });

      const remove = await fetch(`${BASE_URL}/v1/account/photo`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(remove.status).toBe(HTTP_STATUS.NO_CONTENT);
      const cleared = await prisma.user.findUniqueOrThrow({
        where: { id: photoUser.id },
      });
      expect(cleared.photoObjectId).toBeNull();
      const removed = await prisma.auditLogEntry.findFirst({
        where: {
          entityType: "User",
          entityId: photoUser.id,
          metadata: { path: ["action"], equals: "photo_removed" },
        },
      });
      expect(removed).not.toBeNull();
      await waitFor(async () => (await updates()) === 2, 10_000);
    });

    it("leaves exactly one photo after concurrent uploads of different types", async () => {
      const photoUser = await createTestUser();
      const token = await getAccessTokenForUser(photoUser, testClient);
      const upload = (type: string, name: string) => {
        const form = new FormData();
        form.append(
          "file",
          new Blob([crypto.getRandomValues(new Uint8Array(64))], { type }),
          name
        );
        return fetch(`${BASE_URL}/v1/account/photo`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
      };

      for (let round = 0; round < 3; round++) {
        const statuses = (
          await Promise.all([
            upload("image/png", "me.png"),
            upload("image/jpeg", "me.jpg"),
          ])
        ).map((r) => r.status);
        expect(statuses).toEqual([HTTP_STATUS.CREATED, HTTP_STATUS.CREATED]);

        const stored = await prisma.user.findUniqueOrThrow({
          where: { id: photoUser.id },
        });
        const live = await prisma.object.findMany({
          where: {
            bucket: { name: "auth-service-user-photos" },
            objectKey: { startsWith: `users/${photoUser.id}/` },
            deletedAt: null,
          },
        });
        expect(live.map((o) => o.id)).toEqual([stored.photoObjectId]);
      }
    });
  });

  describe("DELETE /account/sessions/:sessionId", () => {
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

  describe("POST /account/totp/setup/verify", () => {
    it("should reject request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setupToken: "test-token",
          totpCode: "123456",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should reject request without setup token", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          totpCode: "123456",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject request without TOTP code", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          setupToken: "test-token",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("enables TOTP and emits auth.user.totp-enabled", async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.user.totp-enabled"] }
      );
      const totpUser = await createTestUser();
      const totpToken = await getUiAccessTokenForUser(totpUser);
      const headers = {
        Authorization: `Bearer ${totpToken}`,
        "Content-Type": "application/json",
      };

      const setup = (await (
        await fetch(`${BASE_URL}/v1/account/totp/setup`, {
          method: "POST",
          headers,
        })
      ).json()) as TotpSetupResponse;

      const response = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          setupToken: setup.setupToken,
          totpCode: generateTotpCode(setup.secret!),
        }),
      });
      expect(response.status).toBe(HTTP_STATUS.OK);

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: totpUser.id,
          entityType: "User",
          metadata: { path: ["action"], equals: "totp_enabled" },
        },
      });
      expect(entry).toMatchObject({ action: "UPDATE" });

      const where = {
        webhookEndpointId: endpoint.id,
        eventType: "auth.user.totp-enabled",
        payload: { path: ["entityId"], equals: totpUser.id },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
      const delivery = await prisma.webhookDelivery.findFirstOrThrow({
        where,
      });
      expect(delivery.payload).toMatchObject({
        organizationId: DEFAULT_ORGANIZATION_ID,
        entityType: "User",
        data: { userId: totpUser.id, email: totpUser.email },
      });
    });

    it("should reject invalid setup token", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          setupToken: "invalid-token",
          totpCode: "123456",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("POST /account/totp/recovery-codes", () => {
    it("should return 401 with error for request without auth token", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/account/totp/recovery-codes`,
        {
          method: "POST",
        }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 400 with error for user without TOTP enabled", async () => {
      // User doesn't have TOTP enabled, should fail
      const response = await fetch(
        `${BASE_URL}/v1/account/totp/recovery-codes`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${uiToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("DELETE /account/totp", () => {
    it("should return 401 with error for request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp`, {
        method: "DELETE",
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 400 with error for user without TOTP enabled", async () => {
      const response = await fetch(`${BASE_URL}/v1/account/totp`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${uiToken}` },
      });

      // User doesn't have TOTP enabled, can't disable
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("disables TOTP, audits it and emits auth.user.totp-disabled", async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.user.totp-disabled"] }
      );
      const totpUser = await createTestUser();
      const totpToken = await getUiAccessTokenForUser(totpUser);
      const headers = {
        Authorization: `Bearer ${totpToken}`,
        "Content-Type": "application/json",
      };

      const setup = (await (
        await fetch(`${BASE_URL}/v1/account/totp/setup`, {
          method: "POST",
          headers,
        })
      ).json()) as TotpSetupResponse;
      const verify = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          setupToken: setup.setupToken,
          totpCode: generateTotpCode(setup.secret!),
        }),
      });
      expect(verify.status).toBe(HTTP_STATUS.OK);

      const response = await fetch(`${BASE_URL}/v1/account/totp`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ totpCode: generateTotpCode(setup.secret!, 1) }),
      });
      expect(response.status).toBe(HTTP_STATUS.OK);

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: totpUser.id },
      });
      expect(user.totpEnabled).toBe(false);
      expect(
        await prisma.recoveryCode.count({ where: { userId: totpUser.id } })
      ).toBe(0);

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: totpUser.id,
          entityType: "User",
          metadata: { path: ["action"], equals: "totp_disabled" },
        },
      });
      expect(entry).toMatchObject({
        action: "UPDATE",
        userId: totpUser.id,
      });

      const where = {
        webhookEndpointId: endpoint.id,
        eventType: "auth.user.totp-disabled",
        payload: { path: ["entityId"], equals: totpUser.id },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
      const delivery = await prisma.webhookDelivery.findFirstOrThrow({
        where,
      });
      expect(delivery.payload).toMatchObject({
        organizationId: DEFAULT_ORGANIZATION_ID,
        entityType: "User",
        data: { userId: totpUser.id, email: totpUser.email },
      });
    });
  });

  describe("changing 2FA needs core's UI and a recent login", () => {
    const routes = [
      { method: "POST", path: "/v1/account/totp/recovery-codes" },
      { method: "DELETE", path: "/v1/account/totp" },
    ];

    // Tokens first: once 2FA is on, a login needs the second factor. It is
    // switched on directly, since enabling it through the API ends the other
    // sessions.
    const userWithTotp = async () => {
      const user = await createTestUser();
      const token = await getUiAccessTokenForUser(user);
      const otherUiToken = await getUiAccessTokenForUser(user);
      const thirdPartyToken = await getAccessTokenForUser(user, testClient);
      const secret = generateTotpSecret();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          totpSecret: encryptTotpSecret(secret),
          totpEnabled: true,
          totpEnabledAt: new Date(),
        },
      });
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      return { user, headers, secret, otherUiToken, thirdPartyToken };
    };

    for (const { method, path } of routes) {
      it(`refuses ${method} ${path} from a third-party client`, async () => {
        const { user, secret, thirdPartyToken } = await userWithTotp();
        const response = await fetch(`${BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${thirdPartyToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
        });
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        // requireCoreUi's refusal, not another 403 such as reauth_required.
        const body = (await response.json()) as ErrorResponse;
        expect(body.error).toBe("forbidden");
        expect(body.error_description).toBe(
          "Changing how you sign in is only possible in core's own UI"
        );
        const stored = await prisma.user.findUniqueOrThrow({
          where: { id: user.id },
        });
        expect(stored.totpEnabled).toBe(true);
      });

      it(`refuses ${method} ${path} without a recent login with 403 reauth_required`, async () => {
        const { user, secret } = await userWithTotp();
        // Minted directly, so it carries no auth_time.
        const token = await getTestPrincipalToken({
          userId: user.id,
          permissions: [],
        });
        const response = await fetch(`${BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
        });
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(((await response.json()) as ErrorResponse).error).toBe(
          "reauth_required"
        );
      });
    }

    it("regenerates recovery codes from a fresh UI login", async () => {
      const { headers, secret } = await userWithTotp();
      const response = await fetch(
        `${BASE_URL}/v1/account/totp/recovery-codes`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
    });

    it("ends the other sessions with the disable, keeping this one", async () => {
      const { user, headers, secret, otherUiToken } = await userWithTotp();
      const other = otherUiToken;
      const before = await prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      });
      expect(before).toBeGreaterThanOrEqual(2);

      const response = await fetch(`${BASE_URL}/v1/account/totp`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
      });
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(
        await prisma.refreshToken.count({
          where: { userId: user.id, revokedAt: null },
        })
      ).toBe(1);
      const me = await fetch(`${BASE_URL}/v1/account/me`, {
        headers: { Authorization: `Bearer ${other}` },
      });
      expect(me.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(
        (await fetch(`${BASE_URL}/v1/account/me`, { headers })).status
      ).toBe(HTTP_STATUS.OK);
      const revoked = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: user.id,
          metadata: { path: ["action"], equals: "sessions_revoked" },
        },
        orderBy: { createdAt: "desc" },
      });
      expect(revoked).not.toBeNull();
    });
  });

  describe("failed TOTP codes on /account/totp", () => {
    const TOO_MANY_REQUESTS = 429;
    const MAX_FAILURES = 5;

    const wrongCode = (secret: string) =>
      String((Number(generateTotpCode(secret)) + 500_000) % 1_000_000).padStart(
        6,
        "0"
      );

    // Enabled with the previous step's code when the test spends two more.
    const userWithTotp = async (enableStepOffset = 0) => {
      const user = await createTestUser();
      const token = await getUiAccessTokenForUser(user);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const setup = (await (
        await fetch(`${BASE_URL}/v1/account/totp/setup`, {
          method: "POST",
          headers,
        })
      ).json()) as TotpSetupResponse;
      const verify = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          setupToken: setup.setupToken,
          totpCode: generateTotpCode(setup.secret!, enableStepOffset),
        }),
      });
      expect(verify.status).toBe(HTTP_STATUS.OK);
      return { user, headers, secret: setup.secret! };
    };

    const disable = (headers: Record<string, string>, totpCode: string) =>
      fetch(`${BASE_URL}/v1/account/totp`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ totpCode }),
      });

    const expectLockedOut = async (response: Response) => {
      expect(response.status).toBe(TOO_MANY_REQUESTS);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("too_many_requests");
    };

    it("locks DELETE /account/totp after repeated wrong codes, even for a correct one", async () => {
      const { user, headers, secret } = await userWithTotp();

      for (let i = 0; i < MAX_FAILURES; i++) {
        const response = await disable(headers, wrongCode(secret));
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      }

      await expectLockedOut(await disable(headers, generateTotpCode(secret)));

      const stored = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(stored.totpEnabled).toBe(true);
    });

    it("counts failures across the account TOTP routes", async () => {
      const { headers, secret } = await userWithTotp();

      for (let i = 0; i < MAX_FAILURES; i++) {
        const response =
          i % 2 === 0
            ? await disable(headers, wrongCode(secret))
            : await fetch(`${BASE_URL}/v1/account/totp/recovery-codes`, {
                method: "POST",
                headers,
                body: JSON.stringify({ totpCode: wrongCode(secret) }),
              });
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      }

      await expectLockedOut(
        await fetch(`${BASE_URL}/v1/account/totp/recovery-codes`, {
          method: "POST",
          headers,
          body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
        })
      );
    });

    it("locks POST /account/totp/setup/verify after repeated wrong codes", async () => {
      const user = await createTestUser();
      const token = await getUiAccessTokenForUser(user);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const setup = (await (
        await fetch(`${BASE_URL}/v1/account/totp/setup`, {
          method: "POST",
          headers,
        })
      ).json()) as TotpSetupResponse;
      const verify = (totpCode: string) =>
        fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
          method: "POST",
          headers,
          body: JSON.stringify({ setupToken: setup.setupToken, totpCode }),
        });

      for (let i = 0; i < MAX_FAILURES; i++) {
        const response = await verify(wrongCode(setup.secret!));
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      }

      await expectLockedOut(await verify(generateTotpCode(setup.secret!)));
      const stored = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(stored.totpEnabled).toBe(false);
    });

    it("locks out only the user whose codes failed", async () => {
      const locked = await userWithTotp();
      const other = await userWithTotp();

      for (let i = 0; i < MAX_FAILURES; i++) {
        await disable(locked.headers, wrongCode(locked.secret));
      }
      await expectLockedOut(
        await disable(locked.headers, generateTotpCode(locked.secret))
      );

      const response = await disable(
        other.headers,
        generateTotpCode(other.secret, 1)
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
    });

    it("resets the count after a correct code", async () => {
      const { headers, secret } = await userWithTotp(-1);
      const regenerate = (totpCode: string) =>
        fetch(`${BASE_URL}/v1/account/totp/recovery-codes`, {
          method: "POST",
          headers,
          body: JSON.stringify({ totpCode }),
        });

      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        expect((await regenerate(wrongCode(secret))).status).toBe(
          HTTP_STATUS.BAD_REQUEST
        );
      }
      expect((await regenerate(generateTotpCode(secret))).status).toBe(
        HTTP_STATUS.OK
      );
      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        expect((await regenerate(wrongCode(secret))).status).toBe(
          HTTP_STATUS.BAD_REQUEST
        );
      }
      expect((await disable(headers, generateTotpCode(secret, 1))).status).toBe(
        HTTP_STATUS.OK
      );
    });
  });

  describe("TOTP setup under the disabled policy", () => {
    const setPolicy = (value: string) =>
      prisma.systemSetting.upsert({
        where: { key: "totpPolicy" },
        update: { value },
        create: { key: "totpPolicy", value },
      });

    afterEach(async () => {
      await setPolicy("optional");
    });

    it("refuses POST /account/totp/setup with 403 totp_disabled", async () => {
      await setPolicy("disabled");

      const response = await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uiToken}` },
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("totp_disabled");
    });

    it("refuses to complete a setup started before the policy changed", async () => {
      const setupUser = await createTestUser();
      const setupToken = await getUiAccessTokenForUser(setupUser);
      const headers = {
        Authorization: `Bearer ${setupToken}`,
        "Content-Type": "application/json",
      };
      const setup = (await (
        await fetch(`${BASE_URL}/v1/account/totp/setup`, {
          method: "POST",
          headers,
        })
      ).json()) as TotpSetupResponse;
      expect(setup.setupToken).toBeDefined();

      await setPolicy("disabled");

      const response = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          setupToken: setup.setupToken,
          totpCode: generateTotpCode(setup.secret!),
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("totp_disabled");
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: setupUser.id },
      });
      expect(user.totpEnabled).toBe(false);
    });
  });
});
