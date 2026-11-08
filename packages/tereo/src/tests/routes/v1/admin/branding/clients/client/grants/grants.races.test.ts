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
import {
  lockWaiters,
  untilQueued,
} from "../../../../../../../support/dbLocks.js";

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

  it("is 404 when the client is deleted while the grant waits on it", async () => {
    const doomed = await createBrandingClient(owner.userId);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    // A client delete holding the client's row until it commits.
    const deletion = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "auth"."oauth_clients"
          WHERE "id" = ${doomed.id}::uuid FOR UPDATE`;
        locked();
        await released;
        await tx.oAuthClient.delete({ where: { id: doomed.id } });
      },
      { timeout: 30_000 }
    );
    await held;

    const baseline = await lockWaiters();
    const grant = fetchJson(
      "POST",
      `${BRANDING_URL}/clients/${doomed.id}/grants`,
      owner.token,
      { userId: grantee.userId }
    );
    await untilQueued(baseline, 1, 5_000);
    release();
    await deletion;

    expect((await grant).status).toBe(404);
  });
});
