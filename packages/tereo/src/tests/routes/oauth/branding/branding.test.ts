// @module-tag int
// @module-tag auth
import { SYSTEM_USER_ID } from "../../../../definitions/systemUser.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUniqueId } from "../../../support/auth/crypto.js";
import { createTestUser } from "../../../support/auth/users.js";
import { BASE_URL } from "../../../support/auth/constants.js";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  invalidateBranding,
  resolveBranding,
} from "../../../../utils/branding/resolve.js";

const get = async (clientId?: string) => {
  const query = clientId === undefined ? "" : `?client_id=${clientId}`;
  const response = await fetch(`${BASE_URL}/oauth/branding${query}`);
  return { response, body: await response.json() };
};

// The default profile is a singleton in a shared DB: one that pre-exists is
// never touched, and the tests that need to own it skip.
describe("GET /oauth/branding", () => {
  let hadDefault = false;
  let ownedDefaultId: string | null = null;
  let clientUuid: string;
  let clientId: string;

  beforeAll(async () => {
    const owner = await createTestUser();
    hadDefault = !!(await prisma.brandingProfile.findFirst({
      where: { clientId: null },
    }));
    clientId = `branding-route-${generateUniqueId()}`;
    const client = await prisma.oAuthClient.create({
      data: {
        clientId,
        name: "Branding route test client",
        redirectUris: [],
        scopes: [],
        grantTypes: ["client_credentials"],
        ownerId: owner.id,
      },
    });
    clientUuid = client.id;
    await prisma.brandingProfile.create({
      data: {
        clientId: clientUuid,
        appName: "Route app",
        headline: "Route headline",
        updatedBy: SYSTEM_USER_ID,
      },
    });
    await invalidateBranding();
  });

  afterAll(async () => {
    await prisma.oAuthClient.deleteMany({ where: { id: clientUuid } });
    if (ownedDefaultId) {
      await prisma.brandingProfile.deleteMany({
        where: { id: ownedDefaultId },
      });
    }
    await invalidateBranding();
  });

  it("returns a client's branding as the injected block would carry it", async () => {
    const { response, body } = await get(clientId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      ...(await resolveBranding(clientId)),
      scope: "auth",
    });
    expect(body.appName).toBe("Route app");
  });

  it("gives an unknown client the default, or null without one", async (ctx) => {
    if (hadDefault) ctx.skip();
    const unknown = `unknown-${generateUniqueId()}`;
    expect((await get(unknown)).body).toBeNull();

    const row = await prisma.brandingProfile.create({
      data: {
        clientId: null,
        appName: "Default route app",
        updatedBy: SYSTEM_USER_ID,
      },
    });
    ownedDefaultId = row.id;
    await invalidateBranding();
    const { response, body } = await get(unknown);
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ...(await resolveBranding(unknown)),
      scope: "auth",
    });
    expect(body.appName).toBe("Default route app");
  });

  it("treats a missing client_id as no client", async () => {
    const { response, body } = await get();
    expect(response.status).toBe(200);
    const expected = await resolveBranding(null);
    expect(body).toEqual(expected && { ...expected, scope: "auth" });
  });
});
