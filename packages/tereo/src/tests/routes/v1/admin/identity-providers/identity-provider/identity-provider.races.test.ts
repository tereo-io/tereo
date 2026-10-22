// @module-tag int
// @module-tag auth
// @module-tag race

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUniqueId } from "../../../../../support/auth.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../../../../../support/fakeOidcProvider.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../support/principals.js";

declare global {
  interface Response {
    // Test bodies are checked field by field.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(): Promise<any>;
  }
}

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let fake: FakeOidcProvider;
let writeToken: string;
let adminToken: string;
let orgId: string;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  // SSO-only changes and moving such a provider need a global admin.
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
  orgId = await ensureTestOrganization(`idp-org-${generateUniqueId()}`);
});

afterAll(async () => {
  await fake.close();
});

const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createProvider = async (overrides: Record<string, unknown> = {}) => {
  const response = await call(writeToken, "POST", "", {
    slug: `p-${generateUniqueId().toLowerCase()}`.slice(0, 40),
    displayName: "Fake IdP",
    kind: "oidc",
    issuer: fake.issuer,
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    ...overrides,
  });
  return response;
};

const newProvider = async () => {
  const response = await createProvider();
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; slug: string };
};

const postDomain = (token: string, providerId: string, body: object) =>
  call(token, "POST", `/${providerId}/domains`, {
    organizationId: orgId,
    autoAccept: false,
    ssoOnly: false,
    roleIds: [],
    ...body,
  });

describe("POST /v1/admin/identity-providers/:id/deactivate", () => {
  it("never leaves an SSO-only domain on an inactive provider when deactivation races the domain", async () => {
    for (let i = 0; i < 10; i++) {
      const provider = await newProvider();
      const domain = await (
        await postDomain(writeToken, provider.id, {
          domain: `race-${generateUniqueId().toLowerCase()}.com`,
        })
      ).json();

      const [deactivated, patched] = await Promise.all([
        call(writeToken, "POST", `/${provider.id}/deactivate`),
        call(adminToken, "PATCH", `/${provider.id}/domains/${domain.id}`, {
          ssoOnly: true,
        }),
      ]);
      expect([deactivated.status, patched.status].sort()).toEqual([200, 409]);

      const [p, d] = await Promise.all([
        prisma.identityProvider.findUniqueOrThrow({
          where: { id: provider.id },
        }),
        prisma.identityProviderDomain.findUniqueOrThrow({
          where: { id: domain.id },
        }),
      ]);
      expect(!p.isActive && d.ssoOnly).toBe(false);
    }
  });
});
