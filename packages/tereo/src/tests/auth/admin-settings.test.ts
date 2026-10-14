import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createAdminUser,
  createTestUser,
  getAccessTokenForUser,
} from "./utils/test-helpers.js";

interface SettingsResponse {
  totpPolicy?: "disabled" | "optional" | "required";
  totpRecoveryCodeCount?: number;
  error?: string;
  error_description?: string;
}

describe("Admin Settings Endpoints", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
  let regularUser: Awaited<ReturnType<typeof createTestUser>>;
  let adminToken: string;
  let regularToken: string;
  let originalSettings: SettingsResponse;

  beforeAll(async () => {
    testClient = await createTestClient();
    adminUser = await createAdminUser();
    regularUser = await createTestUser();

    adminToken = await getAccessTokenForUser(adminUser, testClient);
    regularToken = await getAccessTokenForUser(regularUser, testClient);

    // Store original settings to restore after tests
    const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    originalSettings = (await response.json()) as SettingsResponse;
  });

  afterAll(async () => {
    // Restore original settings
    if (originalSettings.totpPolicy || originalSettings.totpRecoveryCodeCount) {
      await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          totpPolicy: originalSettings.totpPolicy,
          totpRecoveryCodeCount: originalSettings.totpRecoveryCodeCount,
        }),
      });
    }
  });

  describe("GET /admin/settings", () => {
    it("should get settings with admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const data = (await response.json()) as SettingsResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.totpPolicy).toBeDefined();
      expect(["disabled", "optional", "required"]).toContain(data.totpPolicy);
      expect(typeof data.totpRecoveryCodeCount).toBe("number");
    });

    it("should reject request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`);

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should reject request with non-admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        headers: { Authorization: `Bearer ${regularToken}` },
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("PATCH /admin/settings", () => {
    it("audits the old and new values", async () => {
      const patch = (body: SettingsResponse) =>
        fetch(`${BASE_URL}/v1/admin/settings`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const before = (await (
        await fetch(`${BASE_URL}/v1/admin/settings`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json()) as SettingsResponse;
      const next: SettingsResponse = {
        totpPolicy: before.totpPolicy === "disabled" ? "optional" : "disabled",
        totpRecoveryCodeCount: before.totpRecoveryCodeCount === 12 ? 13 : 12,
      };

      try {
        expect((await patch(next)).status).toBe(HTTP_STATUS.OK);

        const entry = await prisma.auditLogEntry.findFirst({
          where: { entityType: "SystemSettings", userId: adminUser.id },
          orderBy: { createdAt: "desc" },
        });
        expect(entry).toMatchObject({
          action: "UPDATE",
          entityId: "totp",
          changes: {
            totpPolicy: { old: before.totpPolicy, new: next.totpPolicy },
            totpRecoveryCodeCount: {
              old: before.totpRecoveryCodeCount,
              new: next.totpRecoveryCodeCount,
            },
          },
        });
      } finally {
        await patch({
          totpPolicy: before.totpPolicy,
          totpRecoveryCodeCount: before.totpRecoveryCodeCount,
        });
      }
    });

    it("should update TOTP policy", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ totpPolicy: "optional" }),
      });

      const data = (await response.json()) as SettingsResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.totpPolicy).toBe("optional");
    });

    it("should update recovery code count", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ totpRecoveryCodeCount: 10 }),
      });

      const data = (await response.json()) as SettingsResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.totpRecoveryCodeCount).toBe(10);
    });

    it("should update multiple settings at once", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          totpPolicy: "disabled",
          totpRecoveryCodeCount: 8,
        }),
      });

      const data = (await response.json()) as SettingsResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.totpPolicy).toBe("disabled");
      expect(data.totpRecoveryCodeCount).toBe(8);
    });

    it("should reject empty update", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject invalid TOTP policy value", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ totpPolicy: "invalid" }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject recovery code count below minimum", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ totpRecoveryCodeCount: 2 }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject recovery code count above maximum", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ totpRecoveryCodeCount: 25 }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totpPolicy: "optional" }),
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should reject request with non-admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${regularToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ totpPolicy: "optional" }),
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });
});
