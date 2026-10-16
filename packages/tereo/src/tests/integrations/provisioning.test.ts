import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import type { CustomRoleEntry } from "../../utils/provisioning/schema.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateClientSecret } from "../../utils/crypto.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { fetchJson } from "../utils/http.js";
import { randomBytes } from "crypto";
import {
  removeRoles,
  removeServices,
} from "../provisioning/utils/test-helpers.js";
import {
  applyProvisioning,
  deprovisionMissing,
} from "../../utils/provisioning/index.js";
import {
  ProvisioningError,
  parseDocuments,
  type LoadedDocument,
  type ResolvedIntegration,
  type ResolvedService,
} from "../../utils/provisioning/load.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";

const createdSlugs: string[] = [];
const createdRoleNames: string[] = [];
let adminToken: string;
let orgId: string;

beforeAll(async () => {
  // Events are written in this process, outside the server.
  await ensureDefaultOrganization();
  adminToken = await getTestPrincipalToken({
    permissions: ["integrations.read", "integrations.write", "admin"],
  });
  orgId = await ensureTestOrganization("integrations-prov-org");
});

afterAll(async () => {
  await removeServices(createdSlugs);
  await removeRoles(createdRoleNames);
});

const rand = () => randomBytes(5).toString("hex");

const newSecret = () => {
  const { plainSecret, hashedSecret } = generateClientSecret();
  return { plain: plainSecret, hash: hashedSecret };
};

const api = (method: string, path: string, body?: unknown) =>
  fetchJson(method, `${CORE_URL}${path}`, adminToken, body);

const integrationSpec = (
  extra: Partial<ResolvedIntegration> = {}
): ResolvedIntegration & { plainSecret: string } => {
  const slug = extra.slug ?? `int-prov-${rand()}`;
  createdSlugs.push(slug);
  const secret = newSecret();
  return {
    slug,
    name: `Integration ${slug}`,
    organizationId: null,
    clientId: slug,
    secretEnv: "INTEGRATION_SECRET",
    secretHash: secret.hash,
    roles: [],
    audiences: [],
    ...extra,
    plainSecret: secret.plain,
  };
};

const serviceSpec = (): ResolvedService => {
  const slug = `prov-${rand()}`;
  createdSlugs.push(slug);
  return {
    slug,
    name: `Service ${slug}`,
    namespace: slug,
    clientId: slug,
    internalHost: null,
    secretEnv: "SERVICE_SECRET",
    secretHash: newSecret().hash,
    access: { roles: [], audiences: [] },
    permissions: [],
    systemRoles: [],
    buckets: [],
    eventTypes: [],
    webhooks: [],
  };
};

const roleEntry = (
  permissions: string[],
  orgAssignable = true
): CustomRoleEntry => {
  const name = `prov-role-${rand()}`;
  createdRoleNames.push(name);
  return {
    name,
    displayName: name,
    orgAssignable,
    requires2fa: false,
    permissions,
  };
};

const doc = (
  parts: Partial<Pick<LoadedDocument, "service" | "roles" | "integrations">>
): LoadedDocument => ({
  file: `doc-${rand()}.json`,
  version: "1.0.0",
  service: null,
  clients: [],
  roles: [],
  integrations: [],
  ...parts,
});

const problemsOf = async (...docs: LoadedDocument[]): Promise<string[]> => {
  try {
    await applyProvisioning({ documents: docs });
  } catch (err) {
    if (err instanceof ProvisioningError) return err.problems;
    throw err;
  }
  throw new Error("expected a ProvisioningError");
};

const issueToken = async (clientId: string, secret: string) => {
  const response = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
};

const tokenClaims = async (clientId: string, secret: string) => {
  const token = await issueToken(clientId, secret);
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString()
  ) as { org_id?: string; aud?: string | string[] };
};

/** The live permissions of a fresh token, as introspection reports them. */
const tokenPermissions = async (clientId: string, secret: string) => {
  const res = await fetch(`${CORE_URL}/oauth/introspect`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      token: await issueToken(clientId, secret),
    }).toString(),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { permissions?: string[] }).permissions ?? [];
};

describe("provisioned integrations", () => {
  it("creates an org-bound integration with its roles and audiences, read-only in the admin API", async () => {
    const service = serviceSpec();
    const role = roleEntry(["webhooks.read"]);
    const spec = integrationSpec({
      organizationId: orgId,
      roles: [role.name],
      audiences: [service.slug],
    });
    const { plainSecret, ...integration } = spec;
    const result = await applyProvisioning({
      documents: [
        doc({ service }),
        doc({ roles: [role], integrations: [integration] }),
      ],
    });
    expect(result.created).toContain(`integration:${spec.slug}`);

    const row = await prisma.service.findUniqueOrThrow({
      where: { slug: spec.slug },
    });
    expect(row).toMatchObject({
      kind: "integration",
      provisioned: true,
      organizationId: orgId,
      namespace: null,
    });

    const claims = await tokenClaims(spec.clientId, plainSecret);
    expect(claims.org_id).toBe(orgId);
    expect(await tokenPermissions(spec.clientId, plainSecret)).toContain(
      "webhooks.read"
    );
    expect([claims.aud].flat()).toContain(service.slug);

    const got = await api("GET", `/v1/admin/integrations/${row.id}`);
    expect(got.status).toBe(200);
    expect(got.body.provisioned).toBe(true);

    for (const [method, path, body] of [
      ["PATCH", "", { name: "x" }],
      ["PUT", "/roles", { roleIds: [] }],
      ["PUT", "/audiences", { slugs: [] }],
      ["POST", "/regenerate-secret", undefined],
    ] as const) {
      const res = await api(
        method,
        `/v1/admin/integrations/${row.id}${path}`,
        body
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("managed_by_provisioning");
    }
    expect(
      (
        await api(
          "POST",
          `/v1/admin/integrations/${row.id}/revoke-previous-secret`
        )
      ).status
    ).toBe(200);

    // Unchanged on a second apply.
    const again = await applyProvisioning({
      documents: [
        doc({ service }),
        doc({ roles: [role], integrations: [integration] }),
      ],
    });
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.access).toEqual([]);
  });

  it("creates a platform integration with a core role", async () => {
    const { plainSecret, ...integration } = integrationSpec({
      roles: ["user_resolver"],
    });
    await applyProvisioning({
      documents: [doc({ integrations: [integration] })],
    });
    const claims = await tokenClaims(integration.clientId, plainSecret);
    expect(claims.org_id).toBeUndefined();
    expect(await tokenPermissions(integration.clientId, plainSecret)).toContain(
      "users.read"
    );
  });

  it("resolves a core role's name to core's role, never an admin-made custom role", async () => {
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { name: "webhooks.read" },
    });
    await prisma.role.create({
      data: {
        name: "user_resolver",
        displayName: "Admin-made lookalike",
        rolePermissions: { create: [{ permissionId: permission.id }] },
      },
    });
    try {
      const { plainSecret, ...integration } = integrationSpec({
        roles: ["user_resolver"],
      });
      await applyProvisioning({
        documents: [doc({ integrations: [integration] })],
      });
      const permissions = await tokenPermissions(
        integration.clientId,
        plainSecret
      );
      expect(permissions).toContain("users.read");
      expect(permissions).not.toContain("webhooks.read");
    } finally {
      await removeRoles(["user_resolver"]);
    }
  });

  it("changes roles on reapply, and marks a dropped integration unprovisioned then deactivates it", async () => {
    const { plainSecret, ...integration } = integrationSpec({
      roles: ["user_resolver"],
    });
    await applyProvisioning({
      documents: [doc({ integrations: [integration] })],
    });
    const changed = await applyProvisioning({
      documents: [doc({ integrations: [{ ...integration, roles: [] }] })],
    });
    expect(changed.access).toContain(`integration:${integration.slug} roles`);
    expect(
      await tokenPermissions(integration.clientId, plainSecret)
    ).not.toContain("users.read");

    const now = new Date();
    const dropped = await applyProvisioning(
      { documents: [doc({ roles: [roleEntry(["webhooks.read"])] })] },
      now
    );
    expect(dropped.unprovisioned).toContain(`integration:${integration.slug}`);
    const later = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 365);
    await deprovisionMissing(later);
    const row = await prisma.service.findUniqueOrThrow({
      where: { slug: integration.slug },
    });
    expect(row.isActive).toBe(false);
  });

  it("validates roles, audiences and slugs across the set", async () => {
    const service = serviceSpec();
    const globalRole = roleEntry(["users.read"], false);
    const { plainSecret: _a, ...orgBound } = integrationSpec({
      organizationId: orgId,
      roles: [globalRole.name, "user_resolver", "no-such-role"],
      audiences: ["no-such-service"],
    });
    const { plainSecret: _b, ...clash } = integrationSpec({
      slug: service.slug,
    });
    const problems = await problemsOf(
      doc({ service }),
      doc({ roles: [globalRole], integrations: [orgBound, clash] })
    );
    const text = problems.join("\n");
    expect(text).toContain(
      `integrations[${orgBound.slug}]: roles "${globalRole.name}"`
    );
    expect(text).toContain(
      `integrations[${orgBound.slug}]: roles "user_resolver"`
    );
    expect(text).toContain(
      `integrations[${orgBound.slug}]: roles "no-such-role"`
    );
    expect(text).toContain(
      `integrations[${orgBound.slug}]: audiences "no-such-service"`
    );
    expect(text).toContain(`service slug "${service.slug}"`);
  });

  it("refuses a platform integration a role carrying admin", async () => {
    const adminRole = roleEntry(["admin"], false);
    const { plainSecret: _p, ...integration } = integrationSpec({
      roles: ["admin", adminRole.name],
    });
    const problems = await problemsOf(
      doc({ roles: [adminRole], integrations: [integration] })
    );
    const label = `integrations[${integration.slug}]`;
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `${label}: roles "admin" carries the admin permission; integrations can't hold it`
        ),
        expect.stringContaining(
          `${label}: roles "${adminRole.name}" carries the admin permission; integrations can't hold it`
        ),
      ])
    );
  });

  it("refuses an organization that does not exist", async () => {
    const { plainSecret: _p, ...integration } = integrationSpec({
      organizationId: "00000000-0000-7000-8000-00000000dead",
    });
    const problems = await problemsOf(doc({ integrations: [integration] }));
    expect(problems.join("\n")).toContain("no organization with id");
  });
});

describe("integrations in documents", () => {
  it("parses an integrations section, enough on its own", () => {
    const secret = newSecret();
    const set = parseDocuments(
      [
        {
          file: "integrations.json",
          text: JSON.stringify({
            version: "1.0.0",
            integrations: [
              {
                slug: "acme-3pl",
                name: "Acme 3PL",
                organizationId: orgId,
                secretFrom: "ACME_SECRET",
                roles: ["shipper"],
              },
            ],
          }),
        },
      ],
      { ACME_SECRET: secret.plain }
    );
    expect(set.documents[0].integrations).toEqual([
      {
        slug: "acme-3pl",
        name: "Acme 3PL",
        organizationId: orgId,
        clientId: "acme-3pl",
        secretEnv: "ACME_SECRET",
        secretHash: secret.hash,
        roles: ["shipper"],
        audiences: [],
      },
    ]);
  });

  it("requires the integration's secret", () => {
    expect(() =>
      parseDocuments(
        [
          {
            file: "integrations.json",
            text: JSON.stringify({
              version: "1.0.0",
              integrations: [
                { slug: "acme-3pl", name: "Acme", secretFrom: "MISSING_X" },
              ],
            }),
          },
        ],
        {}
      )
    ).toThrow(/integrations\[acme-3pl\]: MISSING_X is not set/);
  });
});
