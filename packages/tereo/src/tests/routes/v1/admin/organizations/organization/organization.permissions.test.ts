// @module-tag int
// @module-tag auth

import { createTestOrganization } from "../../../../../support/auth/organizations.js";
import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../support/auth/constants.js";
import {
  createTestUser,
  createAdminUser,
} from "../../../../../support/auth/users.js";

let adminToken: string;
let regularToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  const regularUser = await createTestUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
  regularToken = await getAccessTokenForUser(regularUser, testClient);
});

describe("POST /v1/admin/organizations/:id/archive and /restore", () => {
  async function deactivateOrg(orgId: string) {
    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${orgId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isActive: false }),
      }
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
  }

  async function archiveOrg(orgId: string, token = adminToken) {
    return fetch(`${BASE_URL}/v1/admin/organizations/${orgId}/archive`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("should return 403 for archive without permission", async () => {
    const org = await createTestOrganization(adminToken);
    await deactivateOrg(org.id);

    const response = await archiveOrg(org.id, regularToken);
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("should return 403 (not 409) for unauthorized callers on live and archived organizations alike", async () => {
    const liveOrg = await createTestOrganization(adminToken);
    const archivedOrg = await createTestOrganization(adminToken);
    await deactivateOrg(archivedOrg.id);
    await archiveOrg(archivedOrg.id);

    // regularUser is neither a platform admin nor a member of either org.
    // Same status for both ids — an unauthorized caller must not be able
    // to distinguish archived rows (409) from live ones (403).
    for (const id of [liveOrg.id, archivedOrg.id]) {
      const response = await fetch(`${BASE_URL}/v1/admin/organizations/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${regularToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Should Not Apply" }),
      });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    }
  });
});
