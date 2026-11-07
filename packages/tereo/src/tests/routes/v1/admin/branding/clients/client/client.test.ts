// @module-tag int
// @module-tag auth
import { SYSTEM_USER_ID } from "../../../../../../../definitions/systemUser.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { randomUUID } from "node:crypto";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
  deleteDefaultProfile,
  noDefaultProfile,
  storeTestLogo,
} from "../../../../../../support/branding.js";

describe("/v1/admin/branding/clients/:id", () => {
  let owner: Awaited<ReturnType<typeof brandingPrincipal>>;
  const clientIds: string[] = [];

  const newClient = async () => {
    const client = await createBrandingClient(owner.userId);
    clientIds.push(client.id);
    return client;
  };
  const url = (id: string) => `${BRANDING_URL}/clients/${id}`;

  beforeAll(async () => {
    owner = await brandingPrincipal(["branding.write"]);
  });

  afterAll(async () => {
    await deleteBrandingClients(clientIds);
  });

  it("saves a profile and returns it with its sources", async () => {
    const client = await newClient();
    const put = await fetchJson("PUT", url(client.id), owner.token, {
      appName: "Acme",
      colorsLight: { "--k-primary-color": "#0b5" },
    });
    expect(put.status).toBe(200);

    const get = await fetchJson("GET", url(client.id), owner.token);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      client: { id: client.id, clientId: client.clientId, name: client.name },
      own: {
        appName: "Acme",
        headline: null,
        colorsLight: { "--k-primary-color": "#0b5" },
        logo: null,
      },
      effective: { appName: "Acme" },
      sources: { appName: "client" },
      colorSources: { light: { "--k-primary-color": "client" } },
      provisioned: false,
      provisionedFrom: null,
      canEdit: true,
      canManageGrants: true,
    });
    expect(typeof get.body.updatedAt).toBe("string");
  });

  it("references an uploaded image by its sha256", async () => {
    const client = await newClient();
    const logo = await storeTestLogo();
    const put = await fetchJson("PUT", url(client.id), owner.token, {
      logo: { sha256: logo.sha256 },
    });
    expect(put.status).toBe(200);
    expect(put.body.own.logo).toEqual({
      sha256: logo.sha256,
      url: `/oauth/branding/assets/${logo.objectKey}`,
    });
    const object = await prisma.object.findUniqueOrThrow({
      where: { id: logo.objectId },
    });
    expect(object.deleteAfter).toBeNull();
  });

  it("returns 400 for an image hash that was never uploaded", async () => {
    const client = await newClient();
    const res = await fetchJson("PUT", url(client.id), owner.token, {
      logo: { sha256: "f".repeat(64) },
    });
    expect(res.status).toBe(400);
    expect(res.body.issues?.[0]?.path).toBe("logo");
  });

  it("returns 400 in core's error shape for a bad colour", async () => {
    const client = await newClient();
    const res = await fetchJson("PUT", url(client.id), owner.token, {
      colorsLight: { "--k-primary-color": "url(x)" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(typeof res.body.error_description).toBe("string");
  });

  it("deletes a profile, after which GET has no own values", async () => {
    const client = await newClient();
    await fetchJson("PUT", url(client.id), owner.token, { appName: "Gone" });
    const del = await fetchJson("DELETE", url(client.id), owner.token);
    expect(del.status).toBe(204);

    const get = await fetchJson("GET", url(client.id), owner.token);
    expect(get.status).toBe(200);
    expect(get.body.own).toBeNull();
    expect(get.body.sources.appName).not.toBe("client");
  });

  it("reports what the client inherits beneath its own values", async (ctx) => {
    if (!(await noDefaultProfile())) ctx.skip();
    const client = await newClient();
    await prisma.brandingProfile.create({
      data: { clientId: null, appName: "Default", updatedBy: SYSTEM_USER_ID },
    });
    try {
      await fetchJson("PUT", url(client.id), owner.token, { appName: "Own" });
      const get = await fetchJson("GET", url(client.id), owner.token);
      expect(get.body).toMatchObject({
        own: { appName: "Own" },
        effective: { appName: "Own" },
        inherited: { appName: "Default" },
      });

      await fetchJson("DELETE", url(client.id), owner.token);
      const bare = await fetchJson("GET", url(client.id), owner.token);
      expect(bare.body).toMatchObject({
        own: null,
        effective: { appName: "Default" },
        inherited: { appName: "Default" },
        sources: { appName: "default" },
      });
    } finally {
      await deleteDefaultProfile();
    }
  });

  it("returns 404 for DELETE when the client has no profile", async () => {
    const client = await newClient();
    const del = await fetchJson("DELETE", url(client.id), owner.token);
    expect(del.status).toBe(404);
  });

  it("returns 404 for an unknown client", async () => {
    const res = await fetchJson("GET", url(randomUUID()), owner.token);
    expect(res.status).toBe(404);
  });

  it("refuses PUT and DELETE on a provisioned profile with 409", async () => {
    const client = await newClient();
    await prisma.brandingProfile.create({
      data: {
        clientId: client.id,
        appName: "Declared",
        provisioned: true,
        provisionedFrom: "acme.json",
        updatedBy: SYSTEM_USER_ID,
      },
    });
    for (const method of ["PUT", "DELETE"]) {
      const res = await fetchJson(
        method,
        url(client.id),
        owner.token,
        method === "PUT" ? { appName: "Changed" } : undefined
      );
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: "managed_by_provisioning",
        provisionedFrom: "acme.json",
      });
    }
    const row = await prisma.brandingProfile.findUniqueOrThrow({
      where: { clientId: client.id },
    });
    expect(row.appName).toBe("Declared");
  });
});
