// @module-tag int
// @module-tag auth
import { SYSTEM_USER_ID } from "../../../../../definitions/systemUser.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
  deleteDefaultProfile,
  grantBranding,
  noDefaultProfile,
} from "../../../../support/branding.js";

type Principal = Awaited<ReturnType<typeof brandingPrincipal>>;

describe("GET /v1/admin/branding", () => {
  let user: Principal;
  let admin: Principal;
  let ownedDefault = false;
  const ids = {} as Record<
    "owned" | "granted" | "revoked" | "unbranded" | "other",
    string
  >;

  const brand = (clientUuid: string) =>
    prisma.brandingProfile.create({
      data: { clientId: clientUuid, appName: "x", updatedBy: SYSTEM_USER_ID },
    });

  beforeAll(async () => {
    [user, admin] = await Promise.all([
      brandingPrincipal(["branding.read"]),
      brandingPrincipal(["branding.admin"]),
    ]);
    const stranger = await brandingPrincipal([]);
    ids.owned = (await createBrandingClient(user.userId)).id;
    ids.unbranded = (await createBrandingClient(user.userId)).id;
    ids.granted = (await createBrandingClient(stranger.userId)).id;
    ids.revoked = (await createBrandingClient(stranger.userId)).id;
    ids.other = (await createBrandingClient(stranger.userId)).id;
    await grantBranding(ids.granted, user.userId);
    await grantBranding(ids.revoked, user.userId, true);
    for (const key of ["owned", "granted", "revoked", "other"] as const) {
      await brand(ids[key]);
    }
    ownedDefault = await noDefaultProfile();
    if (ownedDefault) {
      await prisma.brandingProfile.create({
        data: { clientId: null, appName: "Default", updatedBy: SYSTEM_USER_ID },
      });
    }
  });

  afterAll(async () => {
    await deleteBrandingClients(Object.values(ids));
    if (ownedDefault) await deleteDefaultProfile();
  });

  it("lists only the branded clients a non-admin owns or holds an active grant on, and no default", async () => {
    const res = await fetchJson("GET", BRANDING_URL, user.token);
    expect(res.status).toBe(200);
    expect(res.body.default).toBeNull();
    const listed = res.body.clients.map((c: { id: string }) => c.id);
    expect([...listed].sort()).toEqual([ids.owned, ids.granted].sort());
    expect(res.body.clients[0]).toEqual({
      id: expect.any(String),
      clientId: expect.any(String),
      name: expect.any(String),
      provisioned: false,
      updatedAt: expect.any(String),
    });
  });

  it("lists every branded client and the default for a branding.admin", async () => {
    const res = await fetchJson("GET", BRANDING_URL, admin.token);
    expect(res.status).toBe(200);
    expect(res.body.default).toEqual({
      provisioned: expect.any(Boolean),
      updatedAt: expect.any(String),
    });
    const listed = res.body.clients.map((c: { id: string }) => c.id);
    expect(listed).toEqual(
      expect.arrayContaining([ids.owned, ids.granted, ids.revoked, ids.other])
    );
    expect(listed).not.toContain(ids.unbranded);
  });
});
