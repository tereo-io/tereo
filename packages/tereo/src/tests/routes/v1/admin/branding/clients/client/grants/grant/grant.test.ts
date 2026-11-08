// @module-tag int
// @module-tag auth
import { fetchJson } from "../../../../../../../../support/http.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
  grantBranding,
} from "../../../../../../../../support/branding.js";

describe("DELETE /v1/admin/branding/clients/:id/grants/:userId", () => {
  let owner: Awaited<ReturnType<typeof brandingPrincipal>>;
  let grantee: Awaited<ReturnType<typeof brandingPrincipal>>;
  let clientUuid: string;

  const url = (userId: string) =>
    `${BRANDING_URL}/clients/${clientUuid}/grants/${userId}`;

  beforeAll(async () => {
    [owner, grantee] = await Promise.all([
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.write"]),
    ]);
    clientUuid = (await createBrandingClient(owner.userId)).id;
  });

  afterAll(async () => {
    await deleteBrandingClients([clientUuid]);
  });

  it("answers 404 when the user holds no active grant", async () => {
    const res = await fetchJson("DELETE", url(randomUUID()), owner.token);
    expect(res.status).toBe(404);
  });

  it("answers 404 for an already revoked grant", async () => {
    await grantBranding(clientUuid, grantee.userId, true);
    const res = await fetchJson("DELETE", url(grantee.userId), owner.token);
    expect(res.status).toBe(404);
  });

  it("answers 400 for a malformed user id", async () => {
    const res = await fetchJson("DELETE", url("nope"), owner.token);
    expect(res.status).toBe(400);
  });
});
