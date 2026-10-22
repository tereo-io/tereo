// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { makeServiceOf } from "../../../../../../support/testService.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../../../../../definitions/index.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../support/webhooks.js";
import {
  encryptTotpSecret,
  generateTotpSecret,
} from "../../../../../../../utils/totp.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestClient,
  createTestUser,
  createAdminUser,
  getAccessTokenForUser,
} from "../../../../../../support/auth.js";

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

let regularUser: Awaited<ReturnType<typeof createTestUser>>;
let adminToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  regularUser = await createTestUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("GET /v1/admin/users/:id/totp", () => {
  it("should return 200 with TOTP status", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${regularUser.id}/totp`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.OK);

    const data = (await response.json()) as {
      totpEnabled: boolean;
      totpEnabledAt: string | null;
    };
    expect(typeof data.totpEnabled).toBe("boolean");
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/totp`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("POST /v1/admin/users/:id/totp/reset", () => {
  let serviceClient: Awaited<ReturnType<typeof createTestClient>>;
  let adminUserId: string;
  let serviceAdminToken: string;
  let writerToken: string;

  beforeAll(async () => {
    serviceClient = await createTestClient();
    // A service's client: its tokens carry the user's full rights. A token
    // of any other client is capped by its core scopes, which never reach
    // the `admin` an admin's credential reset needs.
    await makeServiceOf(serviceClient.id);
    const admin = await createAdminUser();
    adminUserId = admin.id;
    serviceAdminToken = await getAccessTokenForUser(admin, serviceClient);
    writerToken = await getTestPrincipalToken({ permissions: ["users.write"] });
  });

  const resetTotp = (token: string, id: string) =>
    fetch(`${BASE_URL}/v1/admin/users/${id}/totp/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

  const enrolTotp = async (userId: string) => {
    await prisma.user.update({
      where: { id: userId },
      data: {
        totpSecret: encryptTotpSecret(generateTotpSecret()),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });
  };

  /** A user signed in once through the login flow: a session and a token. */
  const signedInUser = async () => {
    const user = await createTestUser();
    const token = await getAccessTokenForUser(user, serviceClient);
    expect(await liveSessions(user.id)).toBeGreaterThan(0);
    return { user, token };
  };

  const liveSessions = (userId: string) =>
    prisma.refreshToken.count({ where: { userId, revokedAt: null } });

  const userinfo = (token: string) =>
    fetch(`${BASE_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  const enrolledUser = async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: encryptTotpSecret(generateTotpSecret()),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });
    await prisma.recoveryCode.createMany({
      data: ["a", "b", "c"].map((c) => ({ userId: user.id, codeHash: c })),
    });
    return user;
  };

  it("resets TOTP for an admin with only users.write, returning no codes", async () => {
    const writerToken = await getTestPrincipalToken({
      permissions: ["users.write"],
    });
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.totp-reset"] }
    );
    const totpUser = await enrolledUser();

    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${totpUser.id}/totp/reset`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${writerToken}` },
      }
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("recoveryCodes");
    expect(JSON.stringify(body)).not.toMatch(/codes?":/);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: totpUser.id },
    });
    expect(after).toMatchObject({
      totpEnabled: false,
      totpSecret: null,
      totpEnabledAt: null,
    });
    expect(
      await prisma.recoveryCode.count({ where: { userId: totpUser.id } })
    ).toBe(0);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityId: totpUser.id,
        entityType: "User",
        metadata: { path: ["action"], equals: "totp_reset" },
      },
    });
    expect(entry).toMatchObject({ action: "UPDATE" });

    const where = {
      webhookEndpointId: endpoint.id,
      eventType: "auth.user.totp-reset",
      payload: { path: ["entityId"], equals: totpUser.id },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
  });

  it("no longer serves the recovery-codes route", async () => {
    const totpUser = await enrolledUser();
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${totpUser.id}/totp/recovery-codes`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(
      await prisma.recoveryCode.count({ where: { userId: totpUser.id } })
    ).toBe(3);
  });

  it("should return 400 for user without TOTP enabled", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${regularUser.id}/totp/reset`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    // User doesn't have TOTP enabled
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/totp/reset`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("ends every session in the reset", async () => {
    const { user, token } = await signedInUser();
    await enrolTotp(user.id);

    const response = await resetTotp(writerToken, user.id);
    expect(response.status).toBe(HTTP_STATUS.OK);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(row.totpEnabled).toBe(false);
    expect(await liveSessions(user.id)).toBe(0);
    expect((await userinfo(token)).status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityId: user.id, entityType: "User" },
    });
    const actions = entries.map(
      (e) => (e.metadata as { action?: string } | null)?.action
    );
    expect(actions).toEqual(
      expect.arrayContaining(["totp_reset", "sessions_revoked"])
    );
  });

  it("refuses a user without TOTP: 400 totp_not_enabled", async () => {
    const user = await createTestUser();
    const response = await resetTotp(serviceAdminToken, user.id);
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toBe("totp_not_enabled");
  });

  it("refuses the system user", async () => {
    const response = await resetTotp(serviceAdminToken, SYSTEM_USER_ID);
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toBe("system_user");
  });

  it("refuses a service's account", async () => {
    const created = await fetch(`${BASE_URL}/v1/admin/services`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceAdminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `svctotp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      }),
    });
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    const { id } = (await created.json()) as { id: string };
    const service = await prisma.service.findUniqueOrThrow({
      where: { id },
      include: { client: { include: { serviceAccountUser: true } } },
    });
    const accountId = service.client!.serviceAccountUser!.id;
    await enrolTotp(accountId);

    const response = await resetTotp(serviceAdminToken, accountId);
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: accountId },
    });
    expect(row.totpEnabled).toBe(true);
  });

  it("is the only reset: DELETE /admin/users/:id/totp is not routed", async () => {
    const user = await createTestUser();
    await enrolTotp(user.id);
    const response = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/totp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${serviceAdminToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(row.totpEnabled).toBe(true);
  });

  it("records the caller as the actor of a reset", async () => {
    const user = await createTestUser();
    await enrolTotp(user.id);
    expect((await resetTotp(serviceAdminToken, user.id)).status).toBe(
      HTTP_STATUS.OK
    );
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        entityId: user.id,
        metadata: { path: ["action"], equals: "totp_reset" },
      },
    });
    expect(entry.userId).toBe(adminUserId);
  });
});
