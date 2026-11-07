// @module-tag int
// @module-tag auth
// @module-tag race
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchJson } from "../../../../../../../support/http.js";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
} from "../../../../../../../support/branding.js";

describe("concurrent grants", () => {
  let owner: Awaited<ReturnType<typeof brandingPrincipal>>;
  let grantee: Awaited<ReturnType<typeof brandingPrincipal>>;
  let clientUuid: string;

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

  it("one of several simultaneous identical grants wins, the rest get 409", async () => {
    const url = `${BRANDING_URL}/clients/${clientUuid}/grants`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetchJson("POST", url, owner.token, { userId: grantee.userId })
      )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(
      await prisma.brandingGrant.count({
        where: {
          clientId: clientUuid,
          userId: grantee.userId,
          revokedAt: null,
        },
      })
    ).toBe(1);
  });
});
