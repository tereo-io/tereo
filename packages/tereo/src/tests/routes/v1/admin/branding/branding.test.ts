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
  clearDefaultProfile,
} from "../../../../support/branding.js";

type Principal = Awaited<ReturnType<typeof brandingPrincipal>>;

describe("GET /v1/admin/branding", () => {
  let user: Principal;
  let writer: Principal;
  let admin: Principal;
  const ids = {} as Record<
    | "owned"
    | "granted"
    | "revoked"
    | "unbranded"
    | "other"
    | "writerOwned"
    | "writerBranded"
    | "writerGranted"
    | "writerRevoked",
    string
  >;

  const brand = (clientUuid: string) =>
    prisma.brandingProfile.create({
      data: { clientId: clientUuid, appName: "x", updatedBy: SYSTEM_USER_ID },
    });

  beforeAll(async () => {
    [user, writer, admin] = await Promise.all([
      brandingPrincipal(["branding.read"]),
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.admin"]),
    ]);
    const stranger = await brandingPrincipal([]);
    ids.owned = (await createBrandingClient(user.userId)).id;
    ids.unbranded = (await createBrandingClient(user.userId)).id;
    ids.granted = (await createBrandingClient(stranger.userId)).id;
    ids.revoked = (await createBrandingClient(stranger.userId)).id;
    ids.other = (await createBrandingClient(stranger.userId)).id;
    ids.writerOwned = (await createBrandingClient(writer.userId)).id;
    ids.writerBranded = (await createBrandingClient(writer.userId)).id;
    ids.writerGranted = (await createBrandingClient(stranger.userId)).id;
    ids.writerRevoked = (await createBrandingClient(stranger.userId)).id;
    await grantBranding(ids.writerGranted, writer.userId);
    await grantBranding(ids.writerRevoked, writer.userId, true);
    await brand(ids.writerBranded);
    await grantBranding(ids.granted, user.userId);
    await grantBranding(ids.revoked, user.userId, true);
    for (const key of ["owned", "granted", "revoked", "other"] as const) {
      await brand(ids[key]);
    }
    await clearDefaultProfile();
    await prisma.brandingProfile.create({
      data: { clientId: null, appName: "Default", updatedBy: SYSTEM_USER_ID },
    });
  });

  afterAll(async () => {
    await deleteBrandingClients(Object.values(ids));
    await deleteDefaultProfile();
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

  it("offers a writer the unbranded clients it owns or holds an active grant on", async () => {
    const res = await fetchJson("GET", BRANDING_URL, writer.token);
    expect(res.status).toBe(200);
    expect(res.body.brandable).toEqual(
      expect.arrayContaining([
        {
          id: ids.writerOwned,
          clientId: expect.any(String),
          name: expect.any(String),
        },
      ])
    );
    const offered = res.body.brandable.map((c: { id: string }) => c.id);
    expect([...offered].sort()).toEqual(
      [ids.writerOwned, ids.writerGranted].sort()
    );
  });

  it("offers nothing to a caller without branding.write", async () => {
    const res = await fetchJson("GET", BRANDING_URL, user.token);
    expect(res.body.brandable).toEqual([]);
  });

  it("offers a branding.admin every unbranded client", async () => {
    const res = await fetchJson("GET", BRANDING_URL, admin.token);
    const offered = res.body.brandable.map((c: { id: string }) => c.id);
    expect(offered).toEqual(
      expect.arrayContaining([
        ids.unbranded,
        ids.writerOwned,
        ids.writerGranted,
        ids.writerRevoked,
      ])
    );
    expect(offered).not.toContain(ids.owned);
    expect(offered).not.toContain(ids.writerBranded);
  });
});
