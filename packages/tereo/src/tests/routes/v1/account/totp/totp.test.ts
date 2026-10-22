// @module-tag int
// @module-tag auth

import { DEFAULT_ORGANIZATION_ID } from "../../../../../definitions/index.js";
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  generateTotpCode,
  getAccessTokenForUser,
  getUiAccessTokenForUser,
} from "../../../../support/auth.js";

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

let accessToken: string;
// 2FA setup is only for core's UI, on a fresh login.
let uiToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const testUser = await createTestUser({ name: "Test User" });
  accessToken = await getAccessTokenForUser(testUser, testClient);
  uiToken = await getUiAccessTokenForUser(testUser);
});

describe("GET /v1/account/totp", () => {
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

describe("POST /v1/account/totp/setup", () => {
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

describe("POST /v1/account/totp/setup/verify", () => {
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

describe("POST /v1/account/totp/recovery-codes", () => {
  it("should return 401 with error for request without auth token", async () => {
    const response = await fetch(`${BASE_URL}/v1/account/totp/recovery-codes`, {
      method: "POST",
    });

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("should return 400 with error for user without TOTP enabled", async () => {
    // User doesn't have TOTP enabled, should fail
    const response = await fetch(`${BASE_URL}/v1/account/totp/recovery-codes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${uiToken}` },
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("DELETE /v1/account/totp", () => {
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

describe("POST /v1/account/totp/setup and /setup/verify under the disabled policy", () => {
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
