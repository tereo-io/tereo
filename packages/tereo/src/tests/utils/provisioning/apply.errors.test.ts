// @module-tag int
// @module-tag provisioning
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { type CustomRoleEntry } from "../../../utils/provisioning/schema.js";
import { applyProvisioning } from "../../../utils/provisioning/index.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateClientSecret } from "../../../utils/crypto.js";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { fetchJson } from "../../support/http.js";
import { randomBytes } from "crypto";
import env from "../../../env.js";
import {
  ProvisioningError,
  type LoadedDocument,
  type ProvisioningSet,
  type ResolvedClient,
  type ResolvedService,
  type ResolvedWebhook,
  type ResolvedIntegration,
} from "../../../utils/provisioning/load.js";
import {
  removeLoginClients,
  removeRoles,
  removeServices,
} from "../../support/provisioning.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";

let adminToken: string;

const createdSlugs: string[] = [];

const createdClientIds: string[] = [];

const createdRoleNames: string[] = [];

const rand = () => `p${randomBytes(5).toString("hex")}`;

const newSecret = () => {
  const { plainSecret, hashedSecret } = generateClientSecret();
  return { plain: plainSecret, hash: hashedSecret };
};

interface ServiceDoc extends LoadedDocument {
  service: ResolvedService;
  plainSecret: string;
}

const serviceDoc = (
  extra: Partial<ResolvedService> = {},
  doc: { file?: string; version?: string } = {}
): ServiceDoc => {
  const slug = extra.slug ?? `prov-${rand()}`;
  createdSlugs.push(slug);
  const secret = newSecret();
  return {
    file: doc.file ?? `${slug}.json`,
    version: doc.version ?? "1.0.0",
    service: {
      slug,
      name: `Service ${slug}`,
      namespace: slug,
      clientId: slug,
      internalHost: null,
      secretEnv: "SERVICE_SECRET",
      secretHash: secret.hash,
      access: { roles: [], audiences: [] },
      permissions: [],
      systemRoles: [],
      buckets: [],
      eventTypes: [],
      webhooks: [],
      ...extra,
    },
    clients: [],
    roles: [],
    plainSecret: secret.plain,
  };
};

/** The document again, its service changed. */
const withService = (
  d: ServiceDoc,
  extra: Partial<ResolvedService>,
  doc: { file?: string; version?: string } = {}
): ServiceDoc => ({ ...d, ...doc, service: { ...d.service, ...extra } });

const clientSpec = (extra: Partial<ResolvedClient> = {}): ResolvedClient => {
  const spec: ResolvedClient = {
    clientId: `prov-client-${rand()}`,
    name: "Provisioned app",
    description: null,
    clientType: "public",
    secretEnv: null,
    secretHash: null,
    redirectUris: ["https://app.example.com/callback"],
    postLogoutRedirectUris: [],
    scopes: ["openid", "profile"],
    grantTypes: ["authorization_code", "refresh_token"],
    audience: [],
    consentRequired: true,
    trustedCoreScopes: [],
    ...extra,
  };
  createdClientIds.push(spec.clientId);
  return spec;
};

const clientsDoc = (...clients: ResolvedClient[]): LoadedDocument => ({
  file: "clients.json",
  version: "1.0.0",
  service: null,
  clients,
  roles: [],
});

const setOf = (...docs: LoadedDocument[]): ProvisioningSet => ({
  documents: docs.map(({ file, version, service, clients, roles }) => ({
    file,
    version,
    service,
    clients,
    roles,
  })),
});

const apply = (...docs: LoadedDocument[]) => applyProvisioning(setOf(...docs));

const problemsOf = async (...docs: LoadedDocument[]): Promise<string[]> => {
  try {
    await apply(...docs);
  } catch (err) {
    if (err instanceof ProvisioningError) return err.problems;
    throw err;
  }
  throw new Error("expected a ProvisioningError");
};

const fetchToken = async (clientId: string, clientSecret: string) => {
  const response = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  return response.status;
};

const api = (method: string, path: string, body?: unknown) =>
  fetchJson(method, `${CORE_URL}${path}`, adminToken, body);

const serviceRow = (slug: string) =>
  prisma.service.findUniqueOrThrow({
    where: { slug },
    include: { client: { include: { serviceAccountUser: true } } },
  });

beforeAll(async () => {
  // Events are written in this process, outside the server.
  await ensureDefaultOrganization();
  adminToken = await getTestPrincipalToken({
    permissions: [
      "services.read",
      "services.write",
      "services.approve",
      "clients.read",
      "clients.write",
      "clients.delete",
      "clients.admin",
    ],
  });
});

afterAll(async () => {
  await removeRoles(createdRoleNames);
  await removeServices(createdSlugs);
  await removeLoginClients(createdClientIds);
});

describe("applyProvisioning", () => {
  it("refuses a login client audience naming no service", async () => {
    const spec = clientSpec({ audience: ["no-such-service"] });
    const problems = await problemsOf(clientsDoc(spec));
    expect(problems.join("\n")).toContain("no-such-service");
    expect(
      await prisma.oAuthClient.findUnique({
        where: { clientId: spec.clientId },
      })
    ).toBeNull();
  });

  it("refuses the whole set when one document is invalid", async () => {
    const good = serviceDoc();
    const bad = serviceDoc({
      access: { roles: ["no-such-core-role"], audiences: [] },
    });
    const problems = await problemsOf(good, bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${bad.file}: services[${bad.service.slug}]`);
    expect(
      await prisma.service.findUnique({ where: { slug: good.service.slug } })
    ).toBeNull();
  });

  it("refuses a secret already used by another client, current or previous", async () => {
    const holder = serviceDoc();
    await apply(holder);
    const rotated = newSecret();
    const holderRotated = withService(holder, { secretHash: rotated.hash });
    await apply(holderRotated);

    const takesCurrent = serviceDoc({ secretHash: rotated.hash });
    const takesPrevious = clientSpec({
      clientType: "confidential",
      secretEnv: "APP_SECRET",
      secretHash: holder.service.secretHash,
    });
    const problems = await problemsOf(
      holderRotated,
      takesCurrent,
      clientsDoc(takesPrevious)
    );
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain(
      `services[${takesCurrent.service.slug}]`
    );
    expect(problems.join("\n")).toContain(`clients[${takesPrevious.clientId}]`);
    expect(problems.join("\n")).not.toContain(rotated.hash);
    expect(problems.join("\n")).not.toContain(holder.service.secretHash);
    expect(
      await prisma.service.findUnique({
        where: { slug: takesCurrent.service.slug },
      })
    ).toBeNull();
    expect(
      await prisma.oAuthClient.findUnique({
        where: { clientId: takesPrevious.clientId },
      })
    ).toBeNull();
  });

  it("explains how to recover from reusing the previous secret", async () => {
    const d = serviceDoc();
    await apply(d);
    const next = newSecret();
    await apply(withService(d, { secretHash: next.hash }));

    // A rollback that restores the old value.
    const problems = await problemsOf(d);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${d.file}: services[${d.service.slug}]`);
    expect(problems[0]).toContain("previous secret");
    expect(problems[0]).toContain("generate-secret");
    expect((await serviceRow(d.service.slug)).client?.clientSecret).toBe(
      next.hash
    );
  });

  it("refuses an entry that matches an unprovisioned row", async () => {
    const created = await api("POST", "/v1/admin/services", {
      name: "Hand made",
      slug: `hand-${rand()}`,
    });
    expect(created.status).toBe(201);
    createdSlugs.push(created.body.slug);
    const handClient = await api("POST", "/v1/admin/clients", {
      name: "Hand made app",
      clientType: "public",
      redirectUris: ["https://hand.example.com/callback"],
      grantTypes: ["authorization_code"],
    });
    expect(handClient.status, JSON.stringify(handClient.body)).toBe(201);
    createdClientIds.push(handClient.body.clientId);

    const fresh = serviceDoc();
    const problems = await problemsOf(
      serviceDoc({
        slug: created.body.slug,
        namespace: created.body.namespace,
      }),
      fresh,
      clientsDoc(clientSpec({ clientId: handClient.body.clientId }))
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(created.body.slug);
    expect(problems[0]).toContain("not created from the provisioning file");
    expect(problems[1]).toContain(handClient.body.clientId);
    expect(problems[1]).toContain("not created from the provisioning file");
    // No partial writes: the valid entry was not created either.
    expect(
      await prisma.service.findUnique({ where: { slug: fresh.service.slug } })
    ).toBeNull();
    expect((await serviceRow(created.body.slug)).provisioned).toBe(false);
  });

  it("refuses a rollback to a secret an admin revoked", async () => {
    const d = serviceDoc();
    await apply(d);
    const next = newSecret();
    await apply(withService(d, { secretHash: next.hash }));
    const s = await serviceRow(d.service.slug);
    const res = await api(
      "POST",
      `/v1/admin/services/${s.id}/revoke-previous-secret`
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const problems = await problemsOf(d);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${d.file}: services[${d.service.slug}]`);
    expect(problems[0]).toContain("retired");
    expect(problems[0]).toContain("generate-secret");
    expect(problems[0]).not.toContain(d.service.secretHash);
    expect((await serviceRow(d.service.slug)).client?.clientSecret).toBe(
      next.hash
    );
    expect(await fetchToken(d.service.clientId, d.plainSecret)).toBe(401);
  });

  it("refuses a rollback past two rotations, and the old secret for another client", async () => {
    const d = serviceDoc();
    await apply(d);
    const second = newSecret();
    const third = newSecret();
    await apply(withService(d, { secretHash: second.hash }));
    const current = withService(d, { secretHash: third.hash });
    await apply(current);

    const problems = await problemsOf(d);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("retired");

    const other = serviceDoc({ secretHash: d.service.secretHash });
    const otherProblems = await problemsOf(current, other);
    expect(otherProblems).toHaveLength(1);
    expect(otherProblems[0]).toContain(`services[${other.service.slug}]`);
    expect(
      await prisma.service.findUnique({ where: { slug: other.service.slug } })
    ).toBeNull();
    expect((await serviceRow(d.service.slug)).client?.clientSecret).toBe(
      third.hash
    );
  });

  it("refuses a rollback after a rotation without an overlap", async () => {
    const d = serviceDoc();
    await apply(d);
    const next = newSecret();
    const overlap = env.SERVICE_SECRET_OVERLAP_HOURS;
    env.SERVICE_SECRET_OVERLAP_HOURS = 0;
    try {
      await apply(withService(d, { secretHash: next.hash }));
    } finally {
      env.SERVICE_SECRET_OVERLAP_HOURS = overlap;
    }
    expect((await serviceRow(d.service.slug)).client?.previousSecretHash).toBe(
      null
    );

    const problems = await problemsOf(d);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("retired");
  });

  it("refuses a login client's secret again once it was removed", async () => {
    const secret = newSecret();
    const confidential = clientSpec({
      clientType: "confidential",
      secretEnv: "APP_SECRET",
      secretHash: secret.hash,
    });
    await apply(clientsDoc(confidential));
    await apply(
      clientsDoc({
        ...confidential,
        clientType: "public",
        secretEnv: null,
        secretHash: null,
      })
    );

    const problems = await problemsOf(clientsDoc(confidential));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`clients[${confidential.clientId}]`);
    expect(problems[0]).toContain("retired");
  });

  describe("declarations", () => {
    it("refuses a declaration naming a permission another service owns", async () => {
      const first = serviceDoc();
      await apply(first);
      const second = serviceDoc();
      const name = `${second.service.namespace}.items.read`;
      // Set validation cannot see a row outside the set.
      await prisma.permission.create({
        data: {
          name,
          displayName: "Read",
          serviceId: (await serviceRow(first.service.slug)).id,
        },
      });
      second.service.permissions = [
        { name, displayName: "Read", description: "", orgAssignable: false },
      ];

      const problems = await problemsOf(first, second);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(
        `${second.file}: services[${second.service.slug}]`
      );
      expect(problems[0]).toContain(name);
      expect(
        await prisma.service.findUnique({
          where: { slug: second.service.slug },
        })
      ).toBeNull();
    });
  });

  describe("custom roles", () => {
    const roleSpec = (
      permissions: string[],
      extra: Partial<CustomRoleEntry> = {}
    ): CustomRoleEntry => {
      const name = extra.name ?? `prov-role-${rand()}`;
      createdRoleNames.push(name);
      return {
        name,
        displayName: `Role ${name}`,
        orgAssignable: false,
        requires2fa: false,
        permissions,
        ...extra,
      };
    };

    const rolesDoc = (...roles: CustomRoleEntry[]): LoadedDocument => ({
      file: "roles.json",
      version: "1.0.0",
      service: null,
      clients: [],
      roles,
    });

    const roleRow = (name: string) =>
      prisma.role.findFirstOrThrow({
        where: { name, serviceId: null },
        include: { rolePermissions: { include: { permission: true } } },
      });

    it("refuses a permission missing from the database as a problem", async () => {
      // Validation knows it from core's code; the database lacks it until
      // core's declaration is registered.
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { name: "roles.read" },
      });
      await prisma.permission.update({
        where: { id: permission.id },
        data: { retiredAt: new Date() },
      });
      try {
        const role = roleSpec(["roles.read"]);
        expect(await problemsOf(rolesDoc(role))).toEqual([
          `roles.json: roles[${role.name}]: permission "roles.read" does not exist in the database`,
        ]);
      } finally {
        await prisma.permission.update({
          where: { id: permission.id },
          data: { retiredAt: permission.retiredAt },
        });
      }
    });

    it("refuses a custom role whose name a hand-made role holds", async () => {
      const name = `prov-role-${rand()}`;
      createdRoleNames.push(name);
      await prisma.role.create({
        data: { name, displayName: "Hand made", requires2fa: false },
      });
      const problems = await problemsOf(
        rolesDoc(roleSpec(["roles.read"], { name }))
      );
      expect(problems.join("\n")).toContain(
        "was not created from the provisioning file"
      );
      expect((await roleRow(name)).provisioned).toBe(false);
    });
  });

  describe("webhooks", () => {
    const ORG_CREATED = "auth.organization.created";

    const webhook = (
      extra: Partial<ResolvedWebhook> = {}
    ): ResolvedWebhook => ({
      key: "org-events",
      url: "https://example.com/owned",
      events: [ORG_CREATED],
      organizations: "all",
      description: null,
      secretEnv: "ORG_EVENTS_WEBHOOK_SECRET",
      secretPlain: randomBytes(32).toString("hex"),
      ...extra,
    });

    /** A service that reads organization events, subscribed through `webhooks`. */
    const subscriber = (...webhooks: ResolvedWebhook[]) =>
      serviceDoc({
        access: { roles: ["tenant_resolver"], audiences: [] },
        webhooks,
      });

    it("refuses an organization that does not exist", async () => {
      const missing = "00000000-0000-7000-8000-00000000dead";
      const d = subscriber(webhook({ organizations: [missing] }));
      const problems = await problemsOf(d);
      expect(problems).toEqual([
        `${d.file}: services[${d.service.slug}]: webhooks[org-events]: no organization with id ${missing}`,
      ]);
    });
  });

  describe("provisioned integrations", () => {
    const createdSlugs: string[] = [];

    const createdRoleNames: string[] = [];

    let adminToken: string;

    let orgId: string;

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

    it("refuses a rollback to a secret an admin revoked", async () => {
      const { plainSecret: _p, ...integration } = integrationSpec();
      const first = doc({ integrations: [integration] });
      await applyProvisioning({ documents: [first] });
      const next = newSecret();
      await applyProvisioning({
        documents: [
          doc({ integrations: [{ ...integration, secretHash: next.hash }] }),
        ],
      });
      const row = await prisma.service.findUniqueOrThrow({
        where: { slug: integration.slug },
      });
      const res = await api(
        "POST",
        `/v1/admin/integrations/${row.id}/revoke-previous-secret`
      );
      expect(res.status).toBe(200);

      const problems = await problemsOf(first);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`integrations[${integration.slug}]`);
      expect(problems[0]).toContain("retired");

      // After another rotation, one secret back is the previous one.
      const third = newSecret();
      await applyProvisioning({
        documents: [
          doc({ integrations: [{ ...integration, secretHash: third.hash }] }),
        ],
      });
      const back = await problemsOf(
        doc({ integrations: [{ ...integration, secretHash: next.hash }] })
      );
      expect(back).toHaveLength(1);
      expect(back[0]).toContain("previous secret");
      expect((await problemsOf(first))[0]).toContain("retired");
    });
  });
});
