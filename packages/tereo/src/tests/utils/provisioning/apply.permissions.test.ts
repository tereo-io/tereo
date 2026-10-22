// @module-tag int
// @module-tag provisioning
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { type CustomRoleEntry } from "../../../utils/provisioning/schema.js";
import { applyProvisioning } from "../../../utils/provisioning/index.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateClientSecret } from "../../../utils/crypto.js";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { fetchJson } from "../../support/http.js";
import db from "../../../utils/db/index.js";
import { randomBytes } from "crypto";
import {
  type LoadedDocument,
  type ProvisioningSet,
  type ResolvedClient,
  type ResolvedService,
} from "../../../utils/provisioning/load.js";
import {
  removeLoginClients,
  removeRoles,
  removeServices,
} from "../../support/provisioning.js";

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

/** A declaration with one role, `<ns>_item_reader`, granting `grants`. */
const ownerDeclaration = (ns: string, grants: string[] = ["read"]) => ({
  permissions: ["read", "write"].map((verb) => ({
    name: `${ns}.items.${verb}`,
    displayName: `${verb} items`,
    description: "",
    orgAssignable: false,
  })),
  systemRoles: [
    {
      name: `${ns}_item_reader`,
      displayName: "Item reader",
      description: "",
      permissions: grants.map((verb) => `${ns}.items.${verb}`),
    },
  ],
});

const roleTarget = (owner: ServiceDoc) =>
  `${owner.service.slug}/${owner.service.namespace}_item_reader`;

const api = (method: string, path: string, body?: unknown) =>
  fetchJson(method, `${CORE_URL}${path}`, adminToken, body);

const serviceRow = (slug: string) =>
  prisma.service.findUniqueOrThrow({
    where: { slug },
    include: { client: { include: { serviceAccountUser: true } } },
  });

const clientRow = (clientId: string) =>
  prisma.oAuthClient.findUniqueOrThrow({ where: { clientId } });

const serviceToken = async (d: ServiceDoc) => {
  const response = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${d.service.clientId}:${d.plainSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
};

const accessRow = async (
  serviceId: string,
  kind: "role" | "audience",
  target: string
) =>
  prisma.serviceAccess.findUniqueOrThrow({
    where: { serviceId_kind_target: { serviceId, kind, target } },
  });

/** The token's row, by the jti in its payload. */
const tokenRow = (token: string) => {
  const { jti } = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString()
  ) as { jti: string };
  return prisma.accessToken.findUniqueOrThrow({ where: { jti } });
};

const holdsRole = async (slug: string, roleName: string) => {
  const userId = (await serviceRow(slug)).client!.serviceAccountUser!.id;
  return (
    (await prisma.userRole.count({
      where: { userId, role: { name: roleName }, organizationId: null },
    })) > 0
  );
};

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
  describe("access", () => {
    it("grants a core role and an audience", async () => {
      const target = serviceDoc();
      const d = serviceDoc({
        access: { roles: ["file_user"], audiences: [target.service.slug] },
      });
      const result = await apply(target, d);
      expect(result.access.length).toBe(2);

      const s = await serviceRow(d.service.slug);
      expect(await holdsRole(d.service.slug, "file_user")).toBe(true);
      expect(s.client?.audience).toEqual([target.service.slug]);
      for (const [kind, name] of [
        ["role", "file_user"],
        ["audience", target.service.slug],
      ] as const) {
        const row = await accessRow(s.id, kind, name);
        expect(row.status).toBe("approved");
        expect(row.decidedBy).toBe(SYSTEM_USER_ID);
      }
    });

    it("grants a mutual pair each other's roles in one apply", async () => {
      const a = serviceDoc();
      const b = serviceDoc();
      Object.assign(a.service, ownerDeclaration(a.service.namespace), {
        access: { roles: [roleTarget(b)], audiences: [] },
      });
      Object.assign(b.service, ownerDeclaration(b.service.namespace), {
        access: { roles: [roleTarget(a)], audiences: [] },
      });
      await apply(a, b);

      for (const [consumer, owner] of [
        [a, b],
        [b, a],
      ]) {
        expect(
          await holdsRole(
            consumer.service.slug,
            `${owner.service.namespace}_item_reader`
          )
        ).toBe(true);
        const s = await serviceRow(consumer.service.slug);
        const row = await accessRow(s.id, "role", roleTarget(owner));
        expect(row.status).toBe("approved");
        expect(row.decidedBy).toBe(SYSTEM_USER_ID);
        expect(row.approvedPermissionIds).toHaveLength(1);
      }
    });

    it("extends approved access when the role grows", async () => {
      const owner = serviceDoc();
      Object.assign(owner.service, ownerDeclaration(owner.service.namespace));
      const consumer = serviceDoc({
        access: { roles: [roleTarget(owner)], audiences: [] },
      });
      await apply(owner, consumer);

      const grown = withService(
        owner,
        ownerDeclaration(owner.service.namespace, ["read", "write"]),
        { version: "1.1.0" }
      );
      const result = await apply(grown, consumer);
      expect(result.access).toEqual([
        `service:${consumer.service.slug} extended role:${roleTarget(owner)}`,
      ]);

      const c = await serviceRow(consumer.service.slug);
      const row = await accessRow(c.id, "role", roleTarget(owner));
      expect(row.status).toBe("approved");
      expect(row.approvedPermissionIds).toHaveLength(2);
      expect(
        await db.roles.getUserPermissions(c.client!.serviceAccountUser!.id)
      ).toEqual(
        expect.arrayContaining([
          `${owner.service.namespace}.items.read`,
          `${owner.service.namespace}.items.write`,
        ])
      );
      expect(
        await prisma.auditLogEntry.count({
          where: {
            entityId: c.id,
            metadata: { path: ["action"], equals: "access_requested" },
          },
        })
      ).toBe(0);
    });

    it("follows a role that shrinks, auditing it", async () => {
      const owner = serviceDoc();
      Object.assign(
        owner.service,
        ownerDeclaration(owner.service.namespace, ["read", "write"])
      );
      const consumer = serviceDoc({
        access: { roles: [roleTarget(owner)], audiences: [] },
      });
      await apply(owner, consumer);
      const token = await serviceToken(consumer);

      const shrunk = withService(
        owner,
        ownerDeclaration(owner.service.namespace, ["read"]),
        { version: "1.1.0" }
      );
      const result = await apply(shrunk, consumer);
      expect(result.access).toEqual([
        `service:${consumer.service.slug} narrowed role:${roleTarget(owner)}`,
      ]);
      // It embeds the permission the role no longer grants.
      expect((await tokenRow(token)).revokedAt).not.toBeNull();

      const c = await serviceRow(consumer.service.slug);
      expect(
        (await accessRow(c.id, "role", roleTarget(owner))).approvedPermissionIds
      ).toHaveLength(1);
      const entries = await prisma.auditLogEntry.findMany({
        where: {
          entityId: c.id,
          metadata: { path: ["action"], equals: "access_approved" },
        },
        orderBy: { createdAt: "asc" },
      });
      expect(entries).toHaveLength(2);
      expect(entries[1].userId).toBe(SYSTEM_USER_ID);
      expect(entries[1].metadata).toMatchObject({
        file: consumer.file,
        version: consumer.version,
        access: [
          {
            kind: "role",
            target: roleTarget(owner),
            permissions: [],
            removedPermissions: [`${owner.service.namespace}.items.write`],
          },
        ],
      });
    });

    it("revokes tokens when a role swaps one permission for another", async () => {
      const owner = serviceDoc();
      Object.assign(
        owner.service,
        ownerDeclaration(owner.service.namespace, ["read"])
      );
      const consumer = serviceDoc({
        access: { roles: [roleTarget(owner)], audiences: [] },
      });
      await apply(owner, consumer);
      const token = await serviceToken(consumer);

      const swapped = withService(
        owner,
        ownerDeclaration(owner.service.namespace, ["write"]),
        { version: "1.1.0" }
      );
      const result = await apply(swapped, consumer);
      expect(result.access).toEqual([
        `service:${consumer.service.slug} extended role:${roleTarget(owner)}`,
      ]);
      expect((await tokenRow(token)).revokedAt).not.toBeNull();
    });

    it("revokes access removed from the set", async () => {
      const owner = serviceDoc();
      Object.assign(owner.service, ownerDeclaration(owner.service.namespace));
      const consumer = serviceDoc({
        access: {
          roles: [roleTarget(owner)],
          audiences: [owner.service.slug],
        },
      });
      await apply(owner, consumer);
      const token = await serviceToken(consumer);
      expect((await tokenRow(token)).revokedAt).toBeNull();

      const result = await apply(
        owner,
        withService(consumer, { access: { roles: [], audiences: [] } })
      );
      expect(result.access.sort()).toEqual(
        [
          `service:${consumer.service.slug} revoked audience:${owner.service.slug}`,
          `service:${consumer.service.slug} revoked role:${roleTarget(owner)}`,
        ].sort()
      );
      const c = await serviceRow(consumer.service.slug);
      expect((await accessRow(c.id, "role", roleTarget(owner))).status).toBe(
        "revoked"
      );
      expect(
        await holdsRole(
          consumer.service.slug,
          `${owner.service.namespace}_item_reader`
        )
      ).toBe(false);
      expect(c.client?.audience).toEqual([]);
      expect((await tokenRow(token)).revokedAt).not.toBeNull();
    });

    it("grants again access the set lists again after removing it", async () => {
      const owner = serviceDoc();
      Object.assign(owner.service, ownerDeclaration(owner.service.namespace));
      const consumer = serviceDoc({
        access: { roles: [roleTarget(owner)], audiences: [] },
      });
      await apply(owner, consumer);
      await apply(
        owner,
        withService(consumer, { access: { roles: [], audiences: [] } })
      );

      const result = await apply(owner, consumer);
      expect(result.access).toEqual([
        `service:${consumer.service.slug} granted role:${roleTarget(owner)}`,
      ]);
      const c = await serviceRow(consumer.service.slug);
      const row = await accessRow(c.id, "role", roleTarget(owner));
      expect(row.status).toBe("approved");
      expect(row.decidedBy).toBe(SYSTEM_USER_ID);
      expect(row.approvedPermissionIds).toHaveLength(1);
      expect(
        await holdsRole(
          consumer.service.slug,
          `${owner.service.namespace}_item_reader`
        )
      ).toBe(true);
    });

    it("keeps an admin's revocation while the set lists it", async () => {
      const d = serviceDoc({
        access: { roles: ["file_user"], audiences: [] },
      });
      await apply(d);
      const s = await serviceRow(d.service.slug);
      const row = await accessRow(s.id, "role", "file_user");

      const revoked = await api(
        "POST",
        `/v1/admin/services/${s.id}/access/revoke`,
        { ids: [row.id] }
      );
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

      const again = await apply(d);
      expect(again.access).toEqual([]);
      expect((await accessRow(s.id, "role", "file_user")).status).toBe(
        "revoked"
      );
      expect(await holdsRole(d.service.slug, "file_user")).toBe(false);
    });

    it("still lets an admin approve or revoke a provisioned service's access", async () => {
      const d = serviceDoc();
      const other = serviceDoc();
      await apply(d, other);
      const s = await serviceRow(d.service.slug);
      const request = await prisma.serviceAccess.create({
        data: { serviceId: s.id, kind: "audience", target: other.service.slug },
      });

      const approved = await api(
        "POST",
        `/v1/admin/services/${s.id}/access/approve`,
        { ids: [request.id] }
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect((await serviceRow(d.service.slug)).client?.audience).toEqual([
        other.service.slug,
      ]);

      const revoked = await api(
        "POST",
        `/v1/admin/services/${s.id}/access/revoke`,
        { ids: [request.id] }
      );
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect((await serviceRow(d.service.slug)).client?.audience).toEqual([]);
    });
  });

  describe("managed_by_provisioning", () => {
    it("refuses admin edits to a provisioned client or service with 409 managed_by_provisioning", async () => {
      const d = serviceDoc();
      const secret = newSecret();
      const client = clientSpec({
        clientType: "confidential",
        secretEnv: "APP_SECRET",
        secretHash: secret.hash,
      });
      await apply(d, clientsDoc(client));
      const s = await serviceRow(d.service.slug);
      const c = await clientRow(client.clientId);

      const attempts = [
        await api("PATCH", `/v1/admin/clients/${c.id}`, { name: "Edited" }),
        await api("POST", `/v1/admin/clients/${c.id}/regenerate-secret`),
        await api("DELETE", `/v1/admin/clients/${c.id}`),
        await api("PATCH", `/v1/admin/services/${s.id}`, { name: "Edited" }),
        await api("POST", `/v1/admin/services/${s.id}/regenerate-secret`),
      ];
      for (const res of attempts) {
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.error).toBe("managed_by_provisioning");
      }
      expect((await clientRow(client.clientId)).name).toBe(client.name);
      expect((await serviceRow(d.service.slug)).name).toBe(d.service.name);

      const shown = await api("GET", `/v1/admin/clients/${c.id}`);
      expect(shown.body.provisioned).toBe(true);
      const shownService = await api("GET", `/v1/admin/services/${s.id}`);
      expect(shownService.body.provisioned).toBe(true);
    });

    it("lets an admin end a provisioned service's secret overlap at once", async () => {
      const d = serviceDoc();
      await apply(d);
      const next = newSecret();
      await apply(withService(d, { secretHash: next.hash }));
      expect(await fetchToken(d.service.clientId, d.plainSecret)).toBe(200);
      const s = await serviceRow(d.service.slug);

      const res = await api(
        "POST",
        `/v1/admin/services/${s.id}/revoke-previous-secret`
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.provisioned).toBe(true);
      expect(
        (await serviceRow(d.service.slug)).client?.previousSecretHash
      ).toBe(null);
      expect(await fetchToken(d.service.clientId, d.plainSecret)).toBe(401);
      expect(await fetchToken(d.service.clientId, next.plain)).toBe(200);
    });

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

    const ownerDoc = () => {
      const ns = `prov-${rand()}`;
      return serviceDoc({ slug: ns, namespace: ns, ...ownerDeclaration(ns) });
    };

    const roleApi = async (method: string, path: string, body?: unknown) =>
      fetchJson(
        method,
        `${CORE_URL}${path}`,
        await getTestPrincipalToken({ permissions: ["admin"] }),
        body
      );

    it("refuses admin edits with 409 managed_by_provisioning, but still assigns the role", async () => {
      const owner = ownerDoc();
      const role = roleSpec([
        "roles.read",
        `${owner.service.namespace}.items.read`,
      ]);
      await apply(owner, rolesDoc(role));
      const row = await roleRow(role.name);
      const permissionId = row.rolePermissions[0].permissionId;

      const attempts = [
        await roleApi("PATCH", `/v1/admin/roles/${row.id}`, {
          displayName: "X",
        }),
        await roleApi("PUT", `/v1/admin/roles/${row.id}/permissions`, {
          permissionIds: [permissionId],
        }),
        await roleApi("POST", `/v1/admin/roles/${row.id}/archive`),
        await roleApi("DELETE", `/v1/admin/roles/${row.id}`),
        await roleApi("POST", `/v1/admin/roles/${row.id}/restore`),
      ];
      for (const res of attempts) {
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.error).toBe("managed_by_provisioning");
      }
      const shown = await roleApi("GET", `/v1/admin/roles/${row.id}`);
      expect(shown.body.provisioned).toBe(true);

      const user = await prisma.user.create({
        data: {
          email: `prov-role-${rand()}@test.local`,
          name: "Holder",
          isActive: true,
        },
      });
      try {
        const assigned = await roleApi(
          "PUT",
          `/v1/admin/users/${user.id}/roles`,
          { roleIds: [row.id] }
        );
        expect(assigned.status, JSON.stringify(assigned.body)).toBeLessThan(
          300
        );
        expect(
          await prisma.userRole.count({
            where: { userId: user.id, roleId: row.id },
          })
        ).toBe(1);

        const copy = await roleApi(
          "POST",
          `/v1/admin/roles/${row.id}/duplicate`,
          { name: `${role.name}-copy` }
        );
        createdRoleNames.push(`${role.name}-copy`);
        expect(copy.status, JSON.stringify(copy.body)).toBe(201);
        expect(copy.body.provisioned).toBe(false);
      } finally {
        await prisma.userRole.deleteMany({ where: { userId: user.id } });
        await prisma.user.delete({ where: { id: user.id } });
      }
    });
  });
});
