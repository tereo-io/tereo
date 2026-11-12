// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { SYSTEM_USER_ID } from "../../../../../../../definitions/index.js";
import { createScimConnection } from "../../../../../../support/scim.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../../support/http.js";
import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let writeToken: string;
let readToken: string;
let adminToken: string;

beforeAll(async () => {
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  readToken = await getTestPrincipalToken({
    permissions: ["identity-providers.read"],
  });
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

describe("SCIM connection authority", () => {
  it("refuses create to a writer who is not a global admin", async () => {
    const id = randomBytes(5).toString("hex");
    const provider = await prisma.identityProvider.create({
      data: {
        slug: `p-${id}`,
        displayName: "P",
        kind: "oidc",
        issuer: "https://idp.test",
        clientId: "c",
        clientSecret: "s",
        createdBy: SYSTEM_USER_ID,
      },
    });
    const url = `${BASE}/${provider.id}/scim`;
    expect(
      (await fetchJson("PUT", url, writeToken, { isActive: true })).status
    ).toBe(403);
    expect((await fetchJson("GET", url, writeToken)).status).toBe(404);
  });

  it("refuses re-enable and mint, allows disable and revoke", async () => {
    const { providerId, connectionId } = await createScimConnection();
    const url = `${BASE}/${providerId}/scim`;

    const disable = await fetchJson("PUT", url, writeToken, {
      isActive: false,
    });
    expect(disable.status).toBe(200);
    expect(disable.body.isActive).toBe(false);

    const enable = await fetchJson("PUT", url, writeToken, { isActive: true });
    expect(enable.status).toBe(403);
    const mint = await fetchJson("POST", `${url}/tokens`, writeToken);
    expect(mint.status).toBe(403);

    const minted = await fetchJson("POST", `${url}/tokens`, adminToken);
    expect(minted.status).toBe(201);
    const revoke = await fetchJson(
      "DELETE",
      `${url}/tokens/${minted.body.id}`,
      writeToken
    );
    expect(revoke.status).toBe(204);

    const reenabled = await fetchJson("PUT", url, adminToken, {
      isActive: true,
    });
    expect(reenabled.status).toBe(200);
    expect(connectionId).toBe(reenabled.body.id);
  });

  it("lets a reader read and nothing else", async () => {
    const { providerId } = await createScimConnection();
    const url = `${BASE}/${providerId}/scim`;
    expect((await fetchJson("GET", url, readToken)).status).toBe(200);
    expect(
      (await fetchJson("PUT", url, readToken, { isActive: false })).status
    ).toBe(403);
    expect((await fetchJson("DELETE", url, readToken)).status).toBe(403);
    expect((await fetchJson("POST", `${url}/tokens`, readToken)).status).toBe(
      403
    );
  });
});
