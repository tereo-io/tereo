// @module-tag int
// @module-tag auth
import { createScimConnection, scimFetch } from "../../../support/scim.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../support/coreUrl.js";
import { describe, expect, it } from "vitest";

const raw = (token: string, path: string, init: RequestInit = {}) =>
  fetch(`${CORE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });

describe("/scim/v2 discovery", () => {
  it.each(["/ServiceProviderConfig", "/ResourceTypes", "/Schemas"])(
    "GET %s answers application/scim+json",
    async (path) => {
      const { token } = await createScimConnection();
      const response = await raw(token, `/scim/v2${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/scim+json"
      );
    }
  );

  it("lists the User and Group resource types", async () => {
    const { token } = await createScimConnection();
    const { body } = await scimFetch(token, "GET", "/scim/v2/ResourceTypes");
    const names = (body.Resources as { id: string }[]).map((r) => r.id);
    expect(names).toEqual(["User", "Group"]);
  });

  it("builds locations from PUBLIC_URL", async () => {
    const { token } = await createScimConnection();
    const { body } = await scimFetch(
      token,
      "GET",
      "/scim/v2/ServiceProviderConfig"
    );
    expect(body.meta.location).toMatch(/\/scim\/v2\/ServiceProviderConfig$/);
  });

  it("records the use of the token and the connection", async () => {
    const { token, connectionId } = await createScimConnection();
    await scimFetch(token, "GET", "/scim/v2/ServiceProviderConfig");
    await expect
      .poll(async () => {
        const [connection, tokenRow] = await Promise.all([
          prisma.scimConnection.findUnique({ where: { id: connectionId } }),
          prisma.scimToken.findFirst({ where: { connectionId } }),
        ]);
        return [connection?.lastUsedAt, tokenRow?.lastUsedAt].every(Boolean);
      })
      .toBe(true);
  });

  it("answers an unknown path with a SCIM 404", async () => {
    const { token } = await createScimConnection();
    const response = await raw(token, "/scim/v2/Nope", {
      headers: { Accept: "text/html" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/scim+json"
    );
    expect(await response.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
    });
  });

  it("answers malformed JSON with 400 invalidSyntax", async () => {
    const { token } = await createScimConnection();
    const response = await raw(token, "/scim/v2/Nope", {
      method: "POST",
      headers: { "Content-Type": "application/scim+json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).scimType).toBe("invalidSyntax");
  });

  it("sets rate limit headers", async () => {
    const { token } = await createScimConnection();
    const response = await raw(token, "/scim/v2/Schemas");
    expect(response.headers.get("x-ratelimit-limit")).not.toBeNull();
  });
});
