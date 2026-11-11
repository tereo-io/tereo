// @module-tag int
// @module-tag auth
import { getTestPrincipalToken } from "../../../support/principals.js";
import { createScimConnection } from "../../../support/scim.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../support/coreUrl.js";
import { describe, expect, it } from "vitest";

const URN = "urn:ietf:params:scim:api:messages:2.0:Error";

const get = async (authorization?: string) => {
  const response = await fetch(`${CORE_URL}/scim/v2/ServiceProviderConfig`, {
    headers: authorization ? { Authorization: authorization } : {},
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
};

const expectUnauthorized = (r: Awaited<ReturnType<typeof get>>) => {
  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toBe("Bearer");
  expect(r.headers.get("content-type")).toContain("application/scim+json");
  expect(r.body).toMatchObject({ schemas: [URN], status: "401" });
};

describe("/scim/v2 authentication", () => {
  it("rejects a request without a header", async () => {
    expectUnauthorized(await get());
  });

  it("rejects a header that is not Bearer", async () => {
    expectUnauthorized(await get("Basic abc"));
  });

  it("rejects an unknown token", async () => {
    expectUnauthorized(await get("Bearer scim_nope"));
  });

  it("rejects a revoked token", async () => {
    const { token, connectionId } = await createScimConnection();
    await prisma.scimToken.updateMany({
      where: { connectionId },
      data: { revokedAt: new Date() },
    });
    expectUnauthorized(await get(`Bearer ${token}`));
  });

  it("rejects an inactive connection", async () => {
    const { token, connectionId } = await createScimConnection();
    await prisma.scimConnection.update({
      where: { id: connectionId },
      data: { isActive: false },
    });
    expectUnauthorized(await get(`Bearer ${token}`));
  });

  it("rejects an inactive provider", async () => {
    const { token, providerId } = await createScimConnection();
    await prisma.identityProvider.update({
      where: { id: providerId },
      data: { isActive: false },
    });
    expectUnauthorized(await get(`Bearer ${token}`));
  });

  it("rejects a core access token", async () => {
    const access = await getTestPrincipalToken({ permissions: [] });
    expectUnauthorized(await get(`Bearer ${access}`));
  });

  const malformed = (authorization?: string) =>
    fetch(`${CORE_URL}/scim/v2/Nope`, {
      method: "POST",
      headers: {
        "Content-Type": "application/scim+json",
        ...(authorization && { Authorization: authorization }),
      },
      body: "{not json",
    });

  it("answers 401, not 400, to a malformed body without a token", async () => {
    const response = await malformed();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("answers a SCIM 400 invalidSyntax to a malformed body with a valid token", async () => {
    const { token } = await createScimConnection();
    const response = await malformed(`Bearer ${token}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      schemas: [URN],
      status: "400",
      scimType: "invalidSyntax",
    });
  });
});
