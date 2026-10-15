import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../utils/principals.js";
import { generateClientSecret } from "../../utils/crypto.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { randomBytes } from "crypto";
import env from "../../env.js";
import {
  applyProvisioning,
  provision,
} from "../../utils/provisioning/index.js";
import {
  ProvisioningError,
  type ProvisionedClientSpec,
  type ProvisionedServiceSpec,
  type Provisioning,
} from "../../utils/provisioning/load.js";

let adminToken: string;

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

const rand = () => `p${randomBytes(5).toString("hex")}`;

const newSecret = () => {
  const { plainSecret, hashedSecret } = generateClientSecret();
  return { plain: plainSecret, hash: hashedSecret };
};

const serviceSpec = (
  extra: Partial<ProvisionedServiceSpec> = {}
): ProvisionedServiceSpec & { plainSecret: string } => {
  const slug = extra.slug ?? `prov-${rand()}`;
  const secret = newSecret();
  return {
    slug,
    name: `Service ${slug}`,
    namespace: slug,
    clientId: slug,
    secretEnv: "SERVICE_SECRET",
    secretHash: secret.hash,
    plainSecret: secret.plain,
    access: { roles: [], audiences: [] },
    ...extra,
  };
};

const clientSpec = (
  extra: Partial<ProvisionedClientSpec> = {}
): ProvisionedClientSpec => ({
  clientId: `prov-client-${rand()}`,
  name: "Provisioned app",
  clientType: "public",
  secretEnv: null,
  secretHash: null,
  redirectUris: ["https://app.example.com/callback"],
  postLogoutRedirectUris: [],
  scopes: ["openid", "profile"],
  grantTypes: ["authorization_code", "refresh_token"],
  audience: [],
  consentRequired: true,
  ...extra,
});

const file = (
  services: ProvisionedServiceSpec[] = [],
  clients: ProvisionedClientSpec[] = []
): Provisioning => ({
  services: services.map(({ ...s }) => {
    delete (s as { plainSecret?: string }).plainSecret;
    return s;
  }),
  clients,
});

const problemsOf = async (p: Provisioning): Promise<string[]> => {
  try {
    await applyProvisioning(p);
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

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${CORE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (text ? JSON.parse(text) : null) as any,
  };
};

const serviceRow = (slug: string) =>
  prisma.service.findUniqueOrThrow({
    where: { slug },
    include: { client: { include: { serviceAccountUser: true } } },
  });

const clientRow = (clientId: string) =>
  prisma.oAuthClient.findUniqueOrThrow({ where: { clientId } });

const auditCount = (entityIds: string[]) =>
  prisma.auditLogEntry.count({ where: { entityId: { in: entityIds } } });

describe("applyProvisioning", () => {
  it("creates a service with its client, service-account user and given secret", async () => {
    const spec = serviceSpec({
      access: { roles: ["file_user"], audiences: [] },
    });
    const result = await applyProvisioning(file([spec]));
    expect(result.created).toContain(`service:${spec.slug}`);

    const row = await serviceRow(spec.slug);
    expect(row.provisioned).toBe(true);
    expect(row.unprovisionedAt).toBeNull();
    expect(row.namespace).toBe(spec.namespace);
    expect(row.provisionedAccess).toEqual({
      roles: ["file_user"],
      audiences: [],
    });
    expect(row.createdBy).toBe(SYSTEM_USER_ID);
    expect(row.client?.clientId).toBe(spec.clientId);
    expect(row.client?.provisioned).toBe(true);
    expect(row.client?.grantTypes).toEqual(["client_credentials"]);
    expect(row.client?.clientSecret).toBe(spec.secretHash);
    expect(row.client?.serviceAccountUser?.userType).toBe("service_account");
    // Approving access is the next task's: nothing is approved here.
    expect(
      await prisma.serviceAccess.count({ where: { serviceId: row.id } })
    ).toBe(0);

    expect(await fetchToken(spec.clientId, spec.plainSecret)).toBe(200);
  });

  it("creates a login client with audience and consentRequired", async () => {
    const target = serviceSpec();
    const secret = newSecret();
    const spec = clientSpec({
      clientType: "confidential",
      secretEnv: "APP_SECRET",
      secretHash: secret.hash,
      audience: [target.slug],
      consentRequired: false,
    });
    const result = await applyProvisioning(file([target], [spec]));
    expect(result.created).toEqual(
      expect.arrayContaining([
        `service:${target.slug}`,
        `client:${spec.clientId}`,
      ])
    );

    const row = await clientRow(spec.clientId);
    expect(row.provisioned).toBe(true);
    expect(row.ownerId).toBe(SYSTEM_USER_ID);
    expect(row.clientType).toBe("confidential");
    expect(row.clientSecret).toBe(secret.hash);
    expect(row.audience).toEqual([target.slug]);
    expect(row.consentRequired).toBe(false);
    expect(row.redirectUris).toEqual(spec.redirectUris);
    expect(row.scopes).toEqual(spec.scopes);
  });

  it("refuses a login client audience naming no service, or core", async () => {
    const spec = clientSpec({ audience: ["no-such-service", "core"] });
    const problems = await problemsOf(file([], [spec]));
    expect(problems.join("\n")).toContain("no-such-service");
    expect(problems.join("\n")).toContain('"core"');
    expect(
      await prisma.oAuthClient.findUnique({
        where: { clientId: spec.clientId },
      })
    ).toBeNull();
  });

  it("is idempotent: a second apply changes nothing and writes no audit entry", async () => {
    const service = serviceSpec();
    const client = clientSpec({ audience: [service.slug] });
    const p = file([service], [client]);
    await applyProvisioning(p);
    const ids = [
      (await serviceRow(service.slug)).id,
      (await clientRow(client.clientId)).id,
    ];
    const before = await auditCount(ids);
    const updatedAt = (await clientRow(client.clientId)).updatedAt;

    const again = await applyProvisioning(p);
    expect(again).toEqual({
      created: [],
      updated: [],
      rotated: [],
      unprovisioned: [],
    });
    expect(await auditCount(ids)).toBe(before);
    expect((await clientRow(client.clientId)).updatedAt).toEqual(updatedAt);
  });

  it("updates a changed name, redirect URIs, audience or consent setting", async () => {
    const service = serviceSpec();
    const other = serviceSpec();
    const client = clientSpec();
    await applyProvisioning(file([service, other], [client]));

    const result = await applyProvisioning(
      file(
        [{ ...service, name: "Renamed service" }, other],
        [
          {
            ...client,
            name: "Renamed app",
            redirectUris: ["https://app.example.com/other-callback"],
            audience: [other.slug],
            consentRequired: false,
          },
        ]
      )
    );
    expect(result.updated.sort()).toEqual(
      [`client:${client.clientId}`, `service:${service.slug}`].sort()
    );

    const s = await serviceRow(service.slug);
    expect(s.name).toBe("Renamed service");
    expect(s.client?.name).toBe("Renamed service");
    const c = await clientRow(client.clientId);
    expect(c.name).toBe("Renamed app");
    expect(c.redirectUris).toEqual(["https://app.example.com/other-callback"]);
    expect(c.audience).toEqual([other.slug]);
    expect(c.consentRequired).toBe(false);
  });

  it("rotates a changed secret, keeping the old one for the overlap", async () => {
    const service = serviceSpec();
    await applyProvisioning(file([service]));
    const next = newSecret();

    const now = new Date();
    const result = await applyProvisioning(
      file([{ ...service, secretHash: next.hash }]),
      now
    );
    expect(result.rotated).toEqual([`service:${service.slug}`]);

    const row = await serviceRow(service.slug);
    expect(row.client?.clientSecret).toBe(next.hash);
    expect(row.client?.previousSecretHash).toBe(service.secretHash);
    expect(row.client?.previousSecretExpiresAt?.getTime()).toBe(
      now.getTime() + env.SERVICE_SECRET_OVERLAP_HOURS * 60 * 60 * 1000
    );
    expect(await fetchToken(service.clientId, service.plainSecret)).toBe(200);
    expect(await fetchToken(service.clientId, next.plain)).toBe(200);
  });

  it("refuses a secret already used by another client, current or previous", async () => {
    const holder = serviceSpec();
    await applyProvisioning(file([holder]));
    const rotated = newSecret();
    await applyProvisioning(file([{ ...holder, secretHash: rotated.hash }]));

    const takesCurrent = serviceSpec({ secretHash: rotated.hash });
    const takesPrevious = clientSpec({
      clientType: "confidential",
      secretEnv: "APP_SECRET",
      secretHash: holder.secretHash,
    });
    const problems = await problemsOf(
      file(
        [{ ...holder, secretHash: rotated.hash }, takesCurrent],
        [takesPrevious]
      )
    );
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain(`services[${takesCurrent.slug}]`);
    expect(problems.join("\n")).toContain(`clients[${takesPrevious.clientId}]`);
    expect(problems.join("\n")).not.toContain(rotated.hash);
    expect(problems.join("\n")).not.toContain(holder.secretHash);
    expect(
      await prisma.service.findUnique({ where: { slug: takesCurrent.slug } })
    ).toBeNull();
    expect(
      await prisma.oAuthClient.findUnique({
        where: { clientId: takesPrevious.clientId },
      })
    ).toBeNull();
  });

  it("explains how to recover from reusing the previous secret", async () => {
    const service = serviceSpec();
    await applyProvisioning(file([service]));
    const next = newSecret();
    await applyProvisioning(file([{ ...service, secretHash: next.hash }]));

    // A rollback that restores the old value.
    const problems = await problemsOf(file([service]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`services[${service.slug}]`);
    expect(problems[0]).toContain("previous secret");
    expect(problems[0]).toContain("generate-secret");
    expect((await serviceRow(service.slug)).client?.clientSecret).toBe(
      next.hash
    );
  });

  it("refuses an entry that matches an unprovisioned row", async () => {
    const created = await api("POST", "/v1/admin/services", {
      name: "Hand made",
      slug: `hand-${rand()}`,
    });
    expect(created.status).toBe(201);
    const handClient = await api("POST", "/v1/admin/clients", {
      name: "Hand made app",
      clientType: "public",
      redirectUris: ["https://hand.example.com/callback"],
      grantTypes: ["authorization_code"],
    });
    expect(handClient.status, JSON.stringify(handClient.body)).toBe(201);

    const fresh = serviceSpec();
    const problems = await problemsOf(
      file(
        [
          serviceSpec({
            slug: created.body.slug,
            namespace: created.body.namespace,
          }),
          fresh,
        ],
        [clientSpec({ clientId: handClient.body.clientId })]
      )
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(created.body.slug);
    expect(problems[0]).toContain("not created from the provisioning file");
    expect(problems[1]).toContain(handClient.body.clientId);
    expect(problems[1]).toContain("not created from the provisioning file");
    // No partial writes: the valid entry was not created either.
    expect(
      await prisma.service.findUnique({ where: { slug: fresh.slug } })
    ).toBeNull();
    expect((await serviceRow(created.body.slug)).provisioned).toBe(false);
  });

  it("marks an entry missing from the file as unprovisioned, and clears it when it returns", async () => {
    const service = serviceSpec();
    const client = clientSpec();
    await applyProvisioning(file([service], [client]));

    const now = new Date();
    const result = await applyProvisioning(file(), now);
    expect(result.unprovisioned).toEqual(
      expect.arrayContaining([
        `service:${service.slug}`,
        `client:${client.clientId}`,
      ])
    );
    expect((await serviceRow(service.slug)).unprovisionedAt).toEqual(now);
    expect((await clientRow(client.clientId)).unprovisionedAt).toEqual(now);

    // A later start without it keeps the first time it went missing.
    await applyProvisioning(file(), new Date(now.getTime() + 60_000));
    expect((await serviceRow(service.slug)).unprovisionedAt).toEqual(now);

    const back = await applyProvisioning(file([service], [client]));
    expect(back.updated.sort()).toEqual(
      [`client:${client.clientId}`, `service:${service.slug}`].sort()
    );
    expect((await serviceRow(service.slug)).unprovisionedAt).toBeNull();
    expect((await clientRow(client.clientId)).unprovisionedAt).toBeNull();
  });

  it("applies once when two starts race", async () => {
    const service = serviceSpec();
    const client = clientSpec();
    const p = file([service], [client]);
    const [a, b] = await Promise.all([
      applyProvisioning(p),
      applyProvisioning(p),
    ]);
    expect([...a.created, ...b.created].sort()).toEqual(
      [`client:${client.clientId}`, `service:${service.slug}`].sort()
    );
    const row = await serviceRow(service.slug);
    const entries = await prisma.auditLogEntry.count({
      where: { entityId: row.id, action: "CREATE" },
    });
    expect(entries).toBe(1);
  });

  it("refuses admin edits to a provisioned client or service with 409 managed_by_provisioning", async () => {
    const service = serviceSpec();
    const secret = newSecret();
    const client = clientSpec({
      clientType: "confidential",
      secretEnv: "APP_SECRET",
      secretHash: secret.hash,
    });
    await applyProvisioning(file([service], [client]));
    const s = await serviceRow(service.slug);
    const c = await clientRow(client.clientId);

    const attempts = [
      await api("PATCH", `/v1/admin/clients/${c.id}`, { name: "Edited" }),
      await api("POST", `/v1/admin/clients/${c.id}/regenerate-secret`),
      await api("DELETE", `/v1/admin/clients/${c.id}`),
      await api("PATCH", `/v1/admin/services/${s.id}`, { name: "Edited" }),
      await api("POST", `/v1/admin/services/${s.id}/regenerate-secret`),
      await api("POST", `/v1/admin/services/${s.id}/revoke-previous-secret`),
    ];
    for (const res of attempts) {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe("managed_by_provisioning");
    }
    expect((await clientRow(client.clientId)).name).toBe(client.name);
    expect((await serviceRow(service.slug)).name).toBe(service.name);

    const shown = await api("GET", `/v1/admin/clients/${c.id}`);
    expect(shown.body.provisioned).toBe(true);
    const shownService = await api("GET", `/v1/admin/services/${s.id}`);
    expect(shownService.body.provisioned).toBe(true);
  });

  it("still lets an admin approve or revoke a provisioned service's access", async () => {
    const service = serviceSpec();
    const other = serviceSpec();
    await applyProvisioning(file([service, other]));
    const s = await serviceRow(service.slug);
    const request = await prisma.serviceAccess.create({
      data: { serviceId: s.id, kind: "audience", target: other.slug },
    });

    const approved = await api(
      "POST",
      `/v1/admin/services/${s.id}/access/approve`,
      {
        ids: [request.id],
      }
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await serviceRow(service.slug)).client?.audience).toEqual([
      other.slug,
    ]);

    const revoked = await api(
      "POST",
      `/v1/admin/services/${s.id}/access/revoke`,
      {
        ids: [request.id],
      }
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect((await serviceRow(service.slug)).client?.audience).toEqual([]);
  });

  it("records audit entries as the system user", async () => {
    const service = serviceSpec();
    const client = clientSpec();
    await applyProvisioning(file([service], [client]));
    const ids = [
      (await serviceRow(service.slug)).id,
      (await clientRow(client.clientId)).id,
    ];
    const entries = await prisma.auditLogEntry.findMany({
      where: { entityId: { in: ids } },
    });
    expect(entries.map((e) => e.entityType).sort()).toEqual([
      "OAuthClient",
      "Service",
    ]);
    for (const entry of entries) {
      expect(entry.action).toBe("CREATE");
      expect(entry.userId).toBe(SYSTEM_USER_ID);
      expect(entry.writerUserId).toBe(SYSTEM_USER_ID);
    }
  });
});

describe("provision", () => {
  it("does nothing without PROVISIONING_FILE", async () => {
    await expect(provision()).resolves.toBeUndefined();
  });
});
