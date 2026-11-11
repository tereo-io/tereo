// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { SYSTEM_USER_ID } from "../../../../../../../definitions/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../../support/http.js";
import { randomBytes } from "node:crypto";

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const newProvider = async () => {
  const id = randomBytes(5).toString("hex");
  return await prisma.identityProvider.create({
    data: {
      slug: `p-${id}`,
      displayName: "SCIM IdP",
      kind: "oidc",
      issuer: "https://idp.test",
      clientId: "c",
      clientSecret: "s",
      createdBy: SYSTEM_USER_ID,
    },
  });
};

const audit = (entityType: string, entityId: string, action: string) =>
  prisma.auditLogEntry.findFirstOrThrow({
    where: { entityType, entityId, action: action as "CREATE" },
  });

describe("/v1/admin/identity-providers/:id/scim", () => {
  it("is 404 before the connection exists", async () => {
    const provider = await newProvider();
    const res = await fetchJson(
      "GET",
      `${BASE}/${provider.id}/scim`,
      adminToken
    );
    expect(res.status).toBe(404);
  });

  it("creates the connection and reports its base URL", async () => {
    const provider = await newProvider();
    const put = await fetchJson(
      "PUT",
      `${BASE}/${provider.id}/scim`,
      adminToken,
      {
        isActive: true,
      }
    );
    expect(put.status).toBe(201);
    expect(put.body.baseUrl).toMatch(/\/scim\/v2$/);
    expect(put.body.isActive).toBe(true);
    expect(put.body.managedUserCount).toBe(0);
    expect(put.body.tokens).toEqual([]);

    const entry = await audit("ScimConnection", put.body.id, "CREATE");
    expect(entry.entityName).toBe("SCIM IdP");
  });

  it("sets isActive and a second create is a 200", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    await fetchJson("PUT", url, adminToken, { isActive: true });
    const off = await fetchJson("PUT", url, adminToken, { isActive: false });
    expect(off.status).toBe(200);
    const got = await fetchJson("GET", url, adminToken);
    expect(got.body.isActive).toBe(false);
    const entry = await audit("ScimConnection", got.body.id, "UPDATE");
    expect(entry.changes).toEqual({ isActive: { old: true, new: false } });
    const on = await fetchJson("PUT", url, adminToken, { isActive: true });
    expect(on.status).toBe(200);
    expect(on.body.isActive).toBe(true);
  });

  it("rejects a body without isActive", async () => {
    const provider = await newProvider();
    const res = await fetchJson(
      "PUT",
      `${BASE}/${provider.id}/scim`,
      adminToken,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("deletes the connection and audits it", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    const put = await fetchJson("PUT", url, adminToken, { isActive: true });
    const del = await fetchJson("DELETE", url, adminToken);
    expect(del.status).toBe(204);
    expect((await fetchJson("GET", url, adminToken)).status).toBe(404);
    await audit("ScimConnection", put.body.id, "DELETE");
  });

  it("refuses to delete while it manages a user", async () => {
    const provider = await newProvider();
    const url = `${BASE}/${provider.id}/scim`;
    const put = await fetchJson("PUT", url, adminToken, { isActive: true });
    const user = await prisma.user.create({
      data: {
        email: `u-${randomBytes(5).toString("hex")}@scim.test`,
        name: "U",
      },
    });
    await prisma.scimUser.create({
      data: {
        connectionId: put.body.id,
        userId: user.id,
        userName: user.email,
        idpActive: true,
        adminHold: false,
      },
    });
    const del = await fetchJson("DELETE", url, adminToken);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe("scim_users_exist");
    const got = await fetchJson("GET", url, adminToken);
    expect(got.body.managedUserCount).toBe(1);
  });

  it("is 404 for an unknown provider", async () => {
    const res = await fetchJson(
      "PUT",
      `${BASE}/00000000-0000-7000-8000-00000000dead/scim`,
      adminToken,
      { isActive: true }
    );
    expect(res.status).toBe(404);
  });
});
