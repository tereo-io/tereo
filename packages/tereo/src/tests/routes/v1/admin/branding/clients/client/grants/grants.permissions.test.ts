// @module-tag int
// @module-tag auth
// @module-tag security
import { LOGIN_CLIENT } from "../../../../../../../../definitions/loginClient.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchJson } from "../../../../../../../support/http.js";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
  grantBranding,
} from "../../../../../../../support/branding.js";

type Principal = Awaited<ReturnType<typeof brandingPrincipal>>;

describe("/v1/admin/branding/clients/:id/grants access", () => {
  let owner: Principal;
  let grantee: Principal;
  let stranger: Principal;
  let target: Principal;
  let admin: Principal;
  let clientUuid: string;
  let consoleUuid: string;

  const grantsUrl = (id: string) => `${BRANDING_URL}/clients/${id}/grants`;

  beforeAll(async () => {
    [owner, grantee, stranger, target, admin] = await Promise.all([
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.admin"]),
    ]);
    clientUuid = (await createBrandingClient(owner.userId)).id;
    await grantBranding(clientUuid, grantee.userId);
    consoleUuid = (
      await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: LOGIN_CLIENT.clientId },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteBrandingClients([clientUuid]);
    await prisma.brandingGrant.deleteMany({
      where: { clientId: consoleUuid, userId: target.userId },
    });
  });

  it("a grantee cannot list, add or revoke grants", async () => {
    const list = await fetchJson("GET", grantsUrl(clientUuid), grantee.token);
    const add = await fetchJson("POST", grantsUrl(clientUuid), grantee.token, {
      userId: target.userId,
    });
    const revoke = await fetchJson(
      "DELETE",
      `${grantsUrl(clientUuid)}/${grantee.userId}`,
      grantee.token
    );
    expect([list.status, add.status, revoke.status]).toEqual([403, 403, 403]);
  });

  it("a stranger with branding.write is refused", async () => {
    const res = await fetchJson("GET", grantsUrl(clientUuid), stranger.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("an owner holding only branding.read cannot add a grant", async () => {
    const reader = await brandingPrincipal(["branding.read"]);
    const own = await createBrandingClient(reader.userId);
    try {
      expect(
        (await fetchJson("GET", grantsUrl(own.id), reader.token)).status
      ).toBe(200);
      const res = await fetchJson("POST", grantsUrl(own.id), reader.token, {
        userId: target.userId,
      });
      expect(res.status).toBe(403);
    } finally {
      await deleteBrandingClients([own.id]);
    }
  });

  it("a branding.admin who does not own the client can grant and revoke", async () => {
    const add = await fetchJson("POST", grantsUrl(clientUuid), admin.token, {
      userId: target.userId,
    });
    expect(add.status).toBe(201);
    const revoke = await fetchJson(
      "DELETE",
      `${grantsUrl(clientUuid)}/${target.userId}`,
      admin.token
    );
    expect(revoke.status).toBe(204);
  });

  it("refuses grants on the console client for everyone, branding.admin included", async () => {
    for (const who of [owner, admin]) {
      const add = await fetchJson("POST", grantsUrl(consoleUuid), who.token, {
        userId: target.userId,
      });
      expect(add.status).toBe(403);
    }
    expect(
      await prisma.brandingGrant.count({
        where: { clientId: consoleUuid, userId: target.userId },
      })
    ).toBe(0);
  });

  it("a grant on a client never reaches the default profile", async () => {
    await grantBranding(clientUuid, target.userId);
    const res = await fetchJson(
      "PUT",
      `${BRANDING_URL}/default`,
      target.token,
      {
        headline: "No",
      }
    );
    expect(res.status).toBe(403);
  });
});
