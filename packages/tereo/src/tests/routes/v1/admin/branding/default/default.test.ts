// @module-tag int
// @module-tag auth
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import {
  BRANDING_URL,
  brandingPrincipal,
  deleteDefaultProfile,
  noDefaultProfile,
} from "../../../../../support/branding.js";

const url = `${BRANDING_URL}/default`;

describe("/v1/admin/branding/default", () => {
  let admin: Awaited<ReturnType<typeof brandingPrincipal>>;
  let owned = false;

  beforeAll(async () => {
    admin = await brandingPrincipal(["branding.admin"]);
    owned = await noDefaultProfile();
  });

  afterAll(async () => {
    if (owned) await deleteDefaultProfile();
  });

  it("lets a branding.admin save, read and delete the default", async (ctx) => {
    if (!owned) ctx.skip();
    const put = await fetchJson("PUT", url, admin.token, {
      appName: "Everyone",
    });
    expect(put.status).toBe(200);

    const get = await fetchJson("GET", url, admin.token);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      client: null,
      own: { appName: "Everyone" },
      effective: { appName: "Everyone" },
      inherited: null,
      sources: { appName: "default" },
      canEdit: true,
      canManageGrants: false,
    });

    const del = await fetchJson("DELETE", url, admin.token);
    expect(del.status).toBe(204);
    expect(
      await prisma.brandingProfile.findFirst({ where: { clientId: null } })
    ).toBeNull();
    const after = await fetchJson("GET", url, admin.token);
    expect(after.body.own).toBeNull();
  });

  it.each(["GET", "PUT", "DELETE"])(
    "refuses %s to a caller with branding.write alone",
    async (method) => {
      const writer = await brandingPrincipal(["branding.write"]);
      const res = await fetchJson(
        method,
        url,
        writer.token,
        method === "PUT" ? { appName: "Nope" } : undefined
      );
      expect(res.status).toBe(403);
    }
  );
});
