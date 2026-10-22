// @module-tag int
// @module-tag auth
// @module-tag provisioning
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CORE_URL } from "../../../../support/coreUrl.js";
import axios from "axios";
import {
  provisionService,
  removeServices,
  type ProvisionedService,
} from "../../../../support/provisioning.js";
import {
  cleanup as cleanupIntegrations,
  createIntegration,
  integrationToken,
} from "../../../../support/integrations.js";

// GET /v1/account/service: a service reads its own row — the declaration core
// last applied and its access — with no permission.

const URL = `${CORE_URL}/v1/account/service`;
const api = axios.create({ validateStatus: () => true });
const get = (token: string) =>
  api.get(URL, { headers: { Authorization: `Bearer ${token}` } });

const clientToken = async (service: ProvisionedService) => {
  const { clientId, clientSecret } = service.credentials;
  const response = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
};

describe("GET /v1/account/service", () => {
  const slugs: string[] = [];
  let service: ProvisionedService;

  beforeAll(async () => {
    service = await provisionService({
      version: "1.2.0",
      access: { roles: ["tenant_resolver"] },
    });
    slugs.push(service.slug);
  });

  afterAll(async () => {
    await removeServices(slugs);
    await cleanupIntegrations();
  });

  it("returns the caller's own service, its declaration and access", async () => {
    const response = await get(await clientToken(service));
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      id: service.id,
      slug: service.slug,
      namespace: service.namespace,
      isActive: true,
      provisioned: true,
      unprovisionedAt: null,
      declarationVersion: "1.2.0",
      access: [
        {
          kind: "role",
          target: "tenant_resolver",
          status: "approved",
        },
      ],
    });
    expect(response.data.declarationHash).toEqual(expect.any(String));
    expect(response.data.declaredAt).toEqual(expect.any(String));
    expect(response.data.access[0].decidedAt).toEqual(expect.any(String));
    expect(Object.keys(response.data).sort()).toEqual(
      [
        "id",
        "slug",
        "name",
        "namespace",
        "isActive",
        "provisioned",
        "unprovisionedAt",
        "declarationVersion",
        "declarationHash",
        "declaredAt",
        "access",
      ].sort()
    );
    expect(Object.keys(response.data.access[0]).sort()).toEqual(
      ["kind", "target", "status", "decidedAt"].sort()
    );
  });

  it("follows a re-provision that changes only the version", async () => {
    const token = await clientToken(service);
    const before = (await get(token)).data;
    await provisionService({
      slug: service.slug,
      version: "1.3.0",
      access: { roles: ["tenant_resolver"] },
    });
    const after = (await get(token)).data;
    expect(after.declarationVersion).toBe("1.3.0");
    expect(after.declarationHash).toBe(before.declarationHash);
  });

  it("is 404 for a person", async () => {
    const token = await getTestPrincipalToken({
      organizationId: null,
      permissions: [],
    });
    const response = await get(token);
    expect(response.status).toBe(404);
  });

  it("is 404 for an integration", async () => {
    const adminToken = await getTestPrincipalToken({
      permissions: ["integrations.read", "integrations.write"],
    });
    const integration = await createIntegration(adminToken);
    const response = await get(await integrationToken(integration));
    expect(response.status).toBe(404);
  });
});
