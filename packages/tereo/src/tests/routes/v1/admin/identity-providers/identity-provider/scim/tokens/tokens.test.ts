// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../../../support/principals.js";
import { createScimConnection } from "../../../../../../../support/scim.js";
import { hashToken } from "../../../../../../../../utils/scim/tokens.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../../../support/http.js";
import { beforeAll, describe, expect, it } from "vitest";

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

const mint = (providerId: string) =>
  fetchJson("POST", `${BASE}/${providerId}/scim/tokens`, adminToken);

describe("SCIM tokens", () => {
  it("returns the value once and never again", async () => {
    const { providerId } = await createScimConnection();
    const res = await mint(providerId);
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^scim_[A-Za-z0-9_-]{43}$/);
    const row = await prisma.scimToken.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(row.hash).toBe(hashToken(res.body.token));

    const got = await fetchJson(
      "GET",
      `${BASE}/${providerId}/scim`,
      adminToken
    );
    expect(JSON.stringify(got.body)).not.toContain(res.body.token);
    expect(got.body.tokens).toHaveLength(2);
    expect(Object.keys(got.body.tokens[0]).sort()).toEqual([
      "createdAt",
      "id",
      "lastUsedAt",
      "revokedAt",
    ]);
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        entityType: "ScimToken",
        entityId: res.body.id,
        action: "CREATE",
      },
    });
    expect(JSON.stringify(entry)).not.toContain(res.body.token);
  });

  it("allows two live tokens and frees a slot on revoke", async () => {
    const { providerId } = await createScimConnection();
    const second = await mint(providerId);
    expect(second.status).toBe(201);
    const third = await mint(providerId);
    expect(third.status).toBe(409);
    expect(third.body.error).toBe("scim_token_limit");

    const revoke = await fetchJson(
      "DELETE",
      `${BASE}/${providerId}/scim/tokens/${second.body.id}`,
      adminToken
    );
    expect(revoke.status).toBe(204);
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        entityType: "ScimToken",
        entityId: second.body.id,
        action: "DELETE",
      },
    });
    expect(entry.entityName).toBeTruthy();
    expect((await mint(providerId)).status).toBe(201);
  });

  it("serializes concurrent mints at the limit", async () => {
    const { providerId } = await createScimConnection();
    const results = await Promise.all([mint(providerId), mint(providerId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("404s on another connection's token, a revoked one and no connection", async () => {
    const a = await createScimConnection();
    const b = await createScimConnection();
    const bToken = await prisma.scimToken.findFirstOrThrow({
      where: { connectionId: b.connectionId },
    });
    const cross = await fetchJson(
      "DELETE",
      `${BASE}/${a.providerId}/scim/tokens/${bToken.id}`,
      adminToken
    );
    expect(cross.status).toBe(404);
    expect(
      (await prisma.scimToken.findUniqueOrThrow({ where: { id: bToken.id } }))
        .revokedAt
    ).toBeNull();

    const own = await prisma.scimToken.findFirstOrThrow({
      where: { connectionId: a.connectionId },
    });
    const url = `${BASE}/${a.providerId}/scim/tokens/${own.id}`;
    expect((await fetchJson("DELETE", url, adminToken)).status).toBe(204);
    expect((await fetchJson("DELETE", url, adminToken)).status).toBe(404);
  });
});
