// @module-tag int
// @module-tag auth
// @module-tag security
import { SYSTEM_USER_ID } from "../../../../../../../definitions/systemUser.js";
import { LOGIN_CLIENT } from "../../../../../../../definitions/loginClient.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
  grantBranding,
} from "../../../../../../support/branding.js";

type Principal = Awaited<ReturnType<typeof brandingPrincipal>>;

describe("/v1/admin/branding/clients/:id access", () => {
  let owner: Principal;
  let stranger: Principal;
  let grantee: Principal;
  let revoked: Principal;
  let admin: Principal;
  let clientUuid: string;
  let provisionedUuid: string;
  let consoleUuid: string;
  let consoleGrantee: Principal;
  let ownsConsoleProfile = false;
  const clientIds: string[] = [];

  const url = (id: string) => `${BRANDING_URL}/clients/${id}`;
  const put = (id: string, token: string) =>
    fetchJson("PUT", url(id), token, { headline: "Hello" });

  beforeAll(async () => {
    [owner, stranger, grantee, revoked, admin] = await Promise.all([
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.admin"]),
    ]);
    const client = await createBrandingClient(owner.userId);
    const provisioned = await createBrandingClient(owner.userId);
    clientUuid = client.id;
    provisionedUuid = provisioned.id;
    clientIds.push(client.id, provisioned.id);
    await grantBranding(client.id, grantee.userId);
    await grantBranding(client.id, revoked.userId, true);
    await prisma.brandingProfile.create({
      data: {
        clientId: provisioned.id,
        provisioned: true,
        provisionedFrom: "acme.json",
        updatedBy: SYSTEM_USER_ID,
      },
    });
    consoleUuid = (
      await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: LOGIN_CLIENT.clientId },
      })
    ).id;
    // The API refuses grants on the console client; one in the database
    // must still give nothing.
    consoleGrantee = await brandingPrincipal(["branding.write"]);
    await grantBranding(consoleUuid, consoleGrantee.userId);
    ownsConsoleProfile = !(await prisma.brandingProfile.findUnique({
      where: { clientId: consoleUuid },
    }));
    if (ownsConsoleProfile) {
      await prisma.brandingProfile.create({
        data: { clientId: consoleUuid, updatedBy: SYSTEM_USER_ID },
      });
    }
  });

  afterAll(async () => {
    await deleteBrandingClients(clientIds);
    await prisma.brandingGrant.deleteMany({
      where: { clientId: consoleUuid, userId: consoleGrantee.userId },
    });
    if (ownsConsoleProfile) {
      await prisma.brandingProfile.deleteMany({
        where: { clientId: consoleUuid },
      });
    }
  });

  it.each([
    ["the owner", () => owner, 200],
    ["a stranger with branding.write", () => stranger, 403],
    ["an active grantee", () => grantee, 200],
    ["a revoked grantee", () => revoked, 403],
    ["a branding.admin who does not own it", () => admin, 200],
  ])("PUT by %s answers %s", async (_who, principal, status) => {
    const res = await put(clientUuid, principal().token);
    expect(res.status).toBe(status);
    if (status === 403) expect(res.body.error).toBe("forbidden");
  });

  it("a stranger cannot read it either", async () => {
    const res = await fetchJson("GET", url(clientUuid), stranger.token);
    expect(res.status).toBe(403);
  });

  it("an owner holding only branding.read cannot edit", async () => {
    const reader = await brandingPrincipal(["branding.read"]);
    const own = await createBrandingClient(reader.userId);
    clientIds.push(own.id);
    expect((await fetchJson("GET", url(own.id), reader.token)).status).toBe(
      200
    );
    expect((await put(own.id, reader.token)).status).toBe(403);
  });

  it("lets an owner holding only branding.read list grants but not manage them", async () => {
    const reader = await brandingPrincipal(["branding.read"]);
    const own = await createBrandingClient(reader.userId);
    clientIds.push(own.id);
    const res = await fetchJson("GET", url(own.id), reader.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      canEdit: false,
      canManageGrants: false,
      canViewGrants: true,
    });
    const grants = await fetchJson(
      "GET",
      `${url(own.id)}/grants`,
      reader.token
    );
    expect(grants.status).toBe(200);
  });

  it("refuses a branding.admin on a provisioned profile with 409", async () => {
    const res = await put(provisionedUuid, admin.token);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("managed_by_provisioning");
  });

  it("refuses the console client to anyone without branding.admin", async () => {
    for (const principal of [owner, grantee, consoleGrantee]) {
      expect(
        (await fetchJson("GET", url(consoleUuid), principal.token)).status
      ).toBe(403);
      expect((await put(consoleUuid, principal.token)).status).toBe(403);
      expect(
        (await fetchJson("DELETE", url(consoleUuid), principal.token)).status
      ).toBe(403);
    }
  });

  it("leaves the console client out of a console grantee's list", async () => {
    const res = await fetchJson("GET", BRANDING_URL, consoleGrantee.token);
    expect(res.status).toBe(200);
    expect(res.body.clients.map((c: { id: string }) => c.id)).not.toContain(
      consoleUuid
    );
  });

  it("lets a branding.admin read the console client", async () => {
    const res = await fetchJson("GET", url(consoleUuid), admin.token);
    expect(res.status).toBe(200);
    expect(res.body.canManageGrants).toBe(false);
  });

  it.each([
    [
      "the owner",
      () => owner,
      { canEdit: true, canManageGrants: true, canViewGrants: true },
    ],
    [
      "a grantee",
      () => grantee,
      { canEdit: true, canManageGrants: false, canViewGrants: false },
    ],
    [
      "a branding.admin",
      () => admin,
      { canEdit: true, canManageGrants: true, canViewGrants: true },
    ],
  ])("GET tells %s what it may do", async (_who, principal, expected) => {
    const res = await fetchJson("GET", url(clientUuid), principal().token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(expected);
  });

  it("GET reports canEdit false on a provisioned profile", async () => {
    const res = await fetchJson("GET", url(provisionedUuid), owner.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      canEdit: false,
      provisioned: true,
      provisionedFrom: "acme.json",
    });
  });
});
