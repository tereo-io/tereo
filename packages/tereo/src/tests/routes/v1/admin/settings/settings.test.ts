// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeServiceOf } from "../../../../support/testService.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createAdminUser,
  getAccessTokenForUser,
} from "../../../../support/auth.js";

interface SettingsResponse {
  totpPolicy?: "disabled" | "optional" | "required";
  totpRecoveryCodeCount?: number;
  error?: string;
  error_description?: string;
}

describe("GET /v1/admin/settings and PATCH /v1/admin/settings", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
  let adminToken: string;
  let originalSettings: SettingsResponse;

  beforeAll(async () => {
    testClient = await createTestClient();
    // A service's client: its tokens carry the user's full rights. Any other
    // client's are capped by its core scopes, which never reach the `admin`
    // relaxing the 2FA policy needs.
    await makeServiceOf(testClient.id);
    adminUser = await createAdminUser();

    adminToken = await getAccessTokenForUser(adminUser, testClient);

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
      const error = (await response.json()) as {
        error?: string;
        error_description?: string;
      };
      expect(error.error).toBe("invalid_request");
      expect(error.error_description).toMatch(
        /^Invalid request body\. totpPolicy: /
      );
    });

    it("lets only a global admin relax the 2FA policy", async () => {
      const setPolicy = (value: string) =>
        prisma.systemSetting.upsert({
          where: { key: "totpPolicy" },
          update: { value },
          create: { key: "totpPolicy", value },
        });
      const storedPolicy = async () =>
        (
          await prisma.systemSetting.findUniqueOrThrow({
            where: { key: "totpPolicy" },
          })
        ).value;
      const patch = (token: string, body: SettingsResponse) =>
        fetch(`${BASE_URL}/v1/admin/settings`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const writer = await getTestPrincipalToken({
        permissions: ["settings.write"],
      });
      const before = await storedPolicy().catch(() => "optional");

      try {
        await setPolicy("required");
        for (const totpPolicy of ["optional", "disabled"] as const) {
          const refused = await patch(writer, { totpPolicy });
          expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
        }
        expect(await storedPolicy()).toBe("required");
        // Not a relaxation: the policy it sends is the one in force.
        expect((await patch(writer, { totpPolicy: "required" })).status).toBe(
          HTTP_STATUS.OK
        );
        expect(
          (await patch(writer, { totpRecoveryCodeCount: 10 })).status
        ).toBe(HTTP_STATUS.OK);

        await setPolicy("optional");
        expect((await patch(writer, { totpPolicy: "disabled" })).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
        expect(await storedPolicy()).toBe("optional");

        const admin = await getTestPrincipalToken({ permissions: ["admin"] });
        expect((await patch(admin, { totpPolicy: "disabled" })).status).toBe(
          HTTP_STATUS.OK
        );
        // Tightening needs nothing beyond settings.write.
        expect((await patch(writer, { totpPolicy: "optional" })).status).toBe(
          HTTP_STATUS.OK
        );
        expect(await storedPolicy()).toBe("optional");
      } finally {
        await setPolicy(before);
      }
    });
  });
});
