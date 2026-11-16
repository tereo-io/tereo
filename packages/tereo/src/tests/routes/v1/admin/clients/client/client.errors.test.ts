// @module-tag int
// @module-tag auth
import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { createAdminUser } from "../../../../../support/auth/users.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import { beforeAll, describe, expect, it } from "vitest";

describe("PATCH /v1/admin/clients/:id on a provisioned client", () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAccessTokenForUser(
      await createAdminUser(),
      await createTestClient()
    );
  });

  it("refuses liveEvents: 409 managed_by_provisioning", async () => {
    const client = await createTestClient({ clientType: "confidential" });
    await prisma.oAuthClient.update({
      where: { id: client.id },
      data: { provisioned: true },
    });
    const response = await fetchJson(
      "PATCH",
      `${CORE_URL}/v1/admin/clients/${client.id}`,
      adminToken,
      { liveEvents: true }
    );
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("managed_by_provisioning");
  });
});
