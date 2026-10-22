// @module-tag int
// @module-tag auth
import { getTestPrincipalToken } from "../../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUniqueId } from "../../../support/auth/crypto.js";
import { CORE_URL } from "../../../support/coreUrl.js";
import {
  startFakeOidcProvider,
  type FakeOidcProvider,
} from "../../../support/fakeOidcProvider.js";

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
});

interface Provider {
  id: string;
  slug: string;
  displayName: string;
}

const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${CORE_URL}/v1/admin/identity-providers${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createProvider = async (
  fake: FakeOidcProvider,
  overrides: Record<string, unknown> = {}
): Promise<Provider> => {
  const res = await admin("POST", "", {
    slug: `up-${generateUniqueId().toLowerCase()}`.slice(0, 40),
    displayName: `Upstream ${generateUniqueId()}`,
    kind: "oidc",
    issuer: fake.issuer,
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Provider;
};

const deactivate = async (provider: Provider) => {
  expect((await admin("POST", `/${provider.id}/deactivate`)).status).toBe(200);
};

describe("GET /oauth/upstream/providers", () => {
  describe("GET /oauth/upstream/providers", () => {
    let fake: FakeOidcProvider;

    beforeAll(async () => {
      fake = await startFakeOidcProvider();
    });

    afterAll(async () => {
      await fake.close();
    });

    it("lists active providers by display name and hides deactivated ones", async () => {
      const zed = await createProvider(fake, { displayName: "Zed Upstream" });
      const abe = await createProvider(fake, { displayName: "Abe Upstream" });
      const gone = await createProvider(fake);
      await deactivate(gone);

      const res = await fetch(`${CORE_URL}/oauth/upstream/providers`);
      expect(res.status).toBe(200);
      const list = (await res.json()) as {
        slug: string;
        displayName: string;
      }[];
      expect(Object.keys(list[0]).sort()).toEqual(["displayName", "slug"]);
      const slugs = list.map((p) => p.slug);
      expect(slugs).not.toContain(gone.slug);
      expect(slugs.indexOf(abe.slug)).toBeLessThan(slugs.indexOf(zed.slug));
      expect(list).toContainEqual({
        slug: abe.slug,
        displayName: "Abe Upstream",
      });
    });
  });
});
