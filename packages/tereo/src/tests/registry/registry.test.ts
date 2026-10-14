import { uploadTestObject } from "../files/utils/test-helpers.js";
import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { CORE_VERSION } from "../../utils/version.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes, randomUUID } from "crypto";
import { CORE_URL } from "../utils/coreUrl.js";
import db from "../../utils/db/index.js";
import FormData from "form-data";
import env from "../../env.js";
import axios from "axios";
import {
  CORE_DECLARATION,
  CORE_SERVICE_ID,
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../definitions/index.js";
import {
  declarationHash,
  declarationSchema,
  retireMissing,
} from "../../utils/registry.js";

const ROOT = CORE_URL;

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: [
      "services.read",
      "services.write",
      "services.approve",
      "roles.read",
      "roles.write",
      // What the roles approved below grant: an approver grants only what
      // they hold.
      "webhooks.emit",
      "file-service.buckets.read",
      "file-service.objects.delete",
    ],
  });
});

const rand = () => `x${randomBytes(5).toString("hex")}`;

const api = async (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => {
  const response = await fetch(`${ROOT}${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
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

interface Credentials {
  clientId: string;
  clientSecret: string;
}

interface AddedService {
  id: string;
  slug: string;
  namespace: string;
  credentials: Credentials;
}

const addService = async (
  overrides: { name?: string; slug?: string; namespace?: string } = {}
): Promise<AddedService> => {
  const id = rand();
  const res = await api("POST", "/v1/admin/services", adminToken, {
    name: `Svc ${id}`,
    slug: `svc-${id}-service`,
    ...overrides,
  });
  // The body says which conflict, should this ever answer 409 again.
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

const fetchToken = async ({ clientId, clientSecret }: Credentials) => {
  const response = await fetch(`${ROOT}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await response.json()) as { access_token?: string };
  return { status: response.status, token: body.access_token ?? null };
};

const tokenFor = async (service: AddedService) => {
  const { status, token } = await fetchToken(service.credentials);
  expect(status).toBe(200);
  return token!;
};

const declare = (token: string, declaration: unknown) =>
  api("POST", "/v1/registry/declaration", token, declaration);

/** A small valid declaration under the service's namespace. */
const declarationFor = (ns: string, extra: Record<string, unknown> = {}) => ({
  version: "1.0.0",
  permissions: [
    { name: `${ns}.items.read`, displayName: "Read items" },
    { name: `${ns}.items.write`, displayName: "Write items" },
  ],
  systemRoles: [
    {
      name: `${ns}_item_reader`,
      displayName: "Item reader",
      permissions: [`${ns}.items.read`],
    },
  ],
  buckets: [],
  eventTypes: [
    { eventType: `${ns}.item.created`, description: "Item created" },
  ],
  ...extra,
});

const emit = (token: string, eventType: string) =>
  api("POST", "/v1/webhooks/events", token, {
    organizationId: DEFAULT_ORGANIZATION_ID,
    eventType,
    entityType: "Item",
    entityId: rand(),
    data: {},
  });

describe("adding a service", () => {
  it("returns credentials once, with defaults from the name", async () => {
    const id = rand();
    const res = await api("POST", "/v1/admin/services", adminToken, {
      name: `Widget ${id} Service`,
    });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe(`widget-${id}-service`);
    expect(res.body.namespace).toBe(`widget-${id}`);
    expect(res.body.credentials.clientSecret).toMatch(/.{32,}/);

    const listed = await api(
      "GET",
      `/v1/admin/services/${res.body.id}`,
      adminToken
    );
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(
      res.body.credentials.clientSecret
    );

    const client = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: res.body.credentials.clientId },
      include: { serviceAccountUser: true },
    });
    expect(client.grantTypes).toEqual(["client_credentials"]);
    expect(client.serviceAccountUser?.userType).toBe("service_account");
  });

  it("refuses a taken slug or an overlapping namespace", async () => {
    const service = await addService();
    expect(
      (
        await api("POST", "/v1/admin/services", adminToken, {
          name: "Dup",
          slug: service.slug,
        })
      ).status
    ).toBe(409);
    for (const namespace of [
      service.namespace,
      `${service.namespace}-sub`,
      "file-service",
      "auth-extra",
      "users",
    ]) {
      const res = await api("POST", "/v1/admin/services", adminToken, {
        name: "Overlap",
        slug: `overlap-${rand()}`,
        namespace,
      });
      expect(res.status, namespace).toBe(409);
    }
  });

  it("refuses a namespace over buckets created outside any service", async () => {
    const namespace = rand();
    await prisma.bucket.create({
      data: {
        name: `${namespace}-images`,
        policy: "private",
        createdBy: SYSTEM_USER_ID,
      },
    });
    try {
      const res = await api("POST", "/v1/admin/services", adminToken, {
        name: "Late",
        slug: `late-${rand()}`,
        namespace,
      });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain(`${namespace}-images`);
    } finally {
      await prisma.bucket.deleteMany({
        where: { name: `${namespace}-images` },
      });
    }
  });

  it("frees a namespace and its bucket names once those buckets are deleted", async () => {
    const namespace = rand();
    const bucketName = `${namespace}-images`;
    const admin = await getTestPrincipalToken({ permissions: ["admin"] });
    const created = await api("POST", "/v1/files/buckets", admin, {
      name: bucketName,
      policy: "private",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const deleted = await api(
      "DELETE",
      `/v1/files/buckets/${bucketName}`,
      admin
    );
    expect(deleted.status).toBe(204);

    try {
      const service = await addService({ namespace });
      const res = await declare(
        await tokenFor(service),
        declarationFor(namespace, {
          buckets: [{ bucketName, policy: "private" }],
        })
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const rows = await prisma.bucket.findMany({
        where: { name: bucketName },
        select: { serviceId: true, deletedAt: true },
        orderBy: { id: "asc" },
      });
      expect(rows).toEqual([
        { serviceId: null, deletedAt: expect.any(Date) },
        { serviceId: service.id, deletedAt: null },
      ]);
    } finally {
      await prisma.bucket.deleteMany({ where: { name: bucketName } });
    }
  });

  it("caps a slug derived from a long name at 64 characters", async () => {
    const id = rand();
    const name = `${id} ${"abcdefgh ".repeat(10)}`.slice(0, 100);
    const res = await api("POST", "/v1/admin/services", adminToken, { name });
    expect(res.status).toBe(201);
    expect(res.body.slug.length).toBeLessThanOrEqual(64);
    expect(res.body.slug).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(res.body.slug.startsWith(id)).toBe(true);
    expect(res.body.namespace).toBe(res.body.slug);
  });

  it("rejects an explicit slug over 64 characters", async () => {
    const res = await api("POST", "/v1/admin/services", adminToken, {
      name: "Too long",
      slug: `x${"a".repeat(64)}`,
    });
    expect(res.status).toBe(400);
  });

  it("needs services.write", async () => {
    const reader = await getTestPrincipalToken({
      permissions: ["services.read"],
    });
    expect(
      (await api("POST", "/v1/admin/services", reader, { name: "X" })).status
    ).toBe(403);
  });
});

describe("registering a declaration", () => {
  it("applies it, and an unchanged one is a no-op", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const declaration = declarationFor(service.namespace);

    const first = await declare(token, declaration);
    expect(first.status).toBe(200);
    expect(first.body.changed).toBe(true);

    const permission = await prisma.permission.findUniqueOrThrow({
      where: { name: `${service.namespace}.items.read` },
    });
    expect(permission.serviceId).toBe(service.id);
    const role = await prisma.role.findFirstOrThrow({
      where: {
        serviceId: service.id,
        name: `${service.namespace}_item_reader`,
      },
      include: { rolePermissions: true },
    });
    expect(role.rolePermissions).toHaveLength(1);
    const eventType = await prisma.eventType.findUniqueOrThrow({
      where: { eventType: `${service.namespace}.item.created` },
    });
    expect(eventType.source).toBe(service.slug);

    // Same content, different order: still unchanged.
    const reordered = {
      ...declaration,
      permissions: [...declaration.permissions].reverse(),
    };
    const second = await declare(token, reordered);
    expect(second.status).toBe(200);
    expect(second.body.changed).toBe(false);
  });

  it("refuses names outside the namespace, applying nothing", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const res = await declare(token, {
      ...declarationFor(service.namespace),
      permissions: [
        { name: `${service.namespace}.items.read`, displayName: "Read" },
        { name: "users.read", displayName: "Hijack" },
      ],
      buckets: [{ bucketName: "someone-elses-bucket", policy: "private" }],
    });
    expect(res.status).toBe(422);
    expect(
      res.body.error_description ?? res.body.message ?? JSON.stringify(res.body)
    ).toContain("users.read");
    expect(
      await prisma.permission.count({ where: { serviceId: service.id } })
    ).toBe(0);
  });

  it("refuses a system role granting another service's permission", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const res = await declare(token, {
      ...declarationFor(service.namespace),
      systemRoles: [
        {
          name: `${service.namespace}_sneaky`,
          displayName: "Sneaky",
          permissions: ["admin"],
        },
      ],
    });
    expect(res.status).toBe(422);
  });

  it("stores an event type's read permission, its own or core's", async () => {
    const service = await addService();
    const ns = service.namespace;
    const res = await declare(
      await tokenFor(service),
      declarationFor(ns, {
        eventTypes: [
          {
            eventType: `${ns}.item.created`,
            readPermission: `${ns}.items.read`,
          },
          { eventType: `${ns}.user.linked`, readPermission: "users.read" },
          { eventType: `${ns}.item.pinged` },
        ],
      })
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await prisma.eventType.findMany({
      where: { serviceId: service.id },
      orderBy: { eventType: "asc" },
    });
    expect(rows.map((r) => [r.eventType, r.readPermission])).toEqual([
      [`${ns}.item.created`, `${ns}.items.read`],
      [`${ns}.item.pinged`, null],
      [`${ns}.user.linked`, "users.read"],
    ]);
  });

  it("refuses an event type read with a permission nobody declares", async () => {
    const service = await addService();
    const ns = service.namespace;
    const res = await declare(
      await tokenFor(service),
      declarationFor(ns, {
        eventTypes: [
          { eventType: `${ns}.item.created`, readPermission: "nobody.read" },
        ],
      })
    );
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("nobody.read");
  });

  it("refuses a system role not named under the service's namespace", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const ns = service.namespace;
    for (const name of ["admin", "item_reader", `${ns}_`, `${ns}-x_reader`]) {
      const res = await declare(token, {
        ...declarationFor(ns),
        systemRoles: [{ name, displayName: "Unprefixed", permissions: [] }],
      });
      expect(res.status, name).toBe(400);
      expect(res.body.error, name).toBe("invalid_role_name");
      expect(res.body.error_description, name).toContain(`"${ns}_"`);
    }
    expect(
      await prisma.permission.count({ where: { serviceId: service.id } })
    ).toBe(0);
    expect(
      await prisma.service.findUniqueOrThrow({ where: { id: service.id } })
    ).toMatchObject({ declarationHash: null });
  });

  it("ignores a declaration older than the one applied", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const ns = service.namespace;
    const withRead = declarationFor(ns, { version: "1.2.0" });
    const first = await declare(token, withRead);
    expect(first.body).toMatchObject({ applied: true, changed: true });

    // An older release's replica, restarting after the rollout.
    const older = await declare(token, {
      ...withRead,
      version: "1.2.0-rc.1",
      permissions: withRead.permissions.slice(0, 1),
    });
    expect(older.status).toBe(200);
    expect(older.body).toMatchObject({ applied: false, changed: false });
    const write = await prisma.permission.findUniqueOrThrow({
      where: { name: `${ns}.items.write` },
    });
    expect(write.missingSince).toBeNull();

    // The same version applies as before: hash-gated.
    const same = await declare(token, withRead);
    expect(same.body).toMatchObject({ applied: true, changed: false });

    // A newer one applies, even with what an older one had dropped.
    const newer = await declare(token, {
      ...withRead,
      version: "1.10.0",
      permissions: withRead.permissions.slice(0, 1),
    });
    expect(newer.body).toMatchObject({ applied: true, changed: true });
    expect(
      (
        await prisma.permission.findUniqueOrThrow({
          where: { name: `${ns}.items.write` },
        })
      ).missingSince
    ).not.toBeNull();
    expect(
      await prisma.service.findUniqueOrThrow({ where: { id: service.id } })
    ).toMatchObject({ declarationVersion: "1.10.0" });

    // Unchanged content under a newer version moves the version on.
    const bumped = await declare(token, {
      ...withRead,
      version: "2.0.0",
      permissions: withRead.permissions.slice(0, 1),
    });
    expect(bumped.body).toMatchObject({ applied: true, changed: false });
    expect(
      (await declare(token, { ...withRead, version: "1.10.0" })).body
    ).toMatchObject({ applied: false });
  });

  it("requires a semver version", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const { version: _, ...unversioned } = declarationFor(service.namespace);
    expect((await declare(token, unversioned)).status).toBe(400);
    for (const version of ["1.0", "v1.0.0", "1.0.0+build", "latest"]) {
      expect(
        (await declare(token, declarationFor(service.namespace, { version })))
          .status,
        version
      ).toBe(400);
    }
  });

  it("is refused to a caller that is not a service", async () => {
    const res = await declare(adminToken, declarationFor("anything"));
    expect(res.status).toBe(403);
  });

  it("applies concurrent identical declarations once", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const declaration = declarationFor(service.namespace);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => declare(token, declaration))
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(results.filter((r) => r.body.changed)).toHaveLength(1);
  });
});

describe("requested access", () => {
  it("stays pending until approved, then works; revoking takes it away", async () => {
    const service = await addService();
    let token = await tokenFor(service);
    const eventType = `${service.namespace}.item.created`;

    const registered = await declare(
      token,
      declarationFor(service.namespace, {
        requestedAccess: { roles: ["webhook_publisher"] },
      })
    );
    expect(registered.status).toBe(200);
    expect(registered.body.access).toEqual([
      expect.objectContaining({
        kind: "role",
        target: "webhook_publisher",
        status: "pending",
      }),
    ]);

    expect((await emit(token, eventType)).status).toBe(403);

    const accessId = registered.body.access[0].id;
    const approved = await api(
      "POST",
      `/v1/admin/services/${service.id}/access/approve`,
      adminToken,
      { ids: [accessId] }
    );
    expect(approved.status).toBe(200);
    // Permissions resolve per request: the same token now succeeds.
    expect((await emit(token, eventType)).status).toBe(202);

    // A later declaration that no longer asks keeps the approval.
    await declare(token, declarationFor(service.namespace));
    expect((await emit(token, eventType)).status).toBe(202);

    const revoked = await api(
      "POST",
      `/v1/admin/services/${service.id}/access/revoke`,
      adminToken,
      { ids: [accessId] }
    );
    expect(revoked.status).toBe(200);
    expect((await emit(token, eventType)).status).toBe(401);
    token = await tokenFor(service);
    expect((await emit(token, eventType)).status).toBe(403);
  });

  it("only lets a service emit its own event types", async () => {
    const owner = await addService();
    const other = await addService();
    const ownerToken = await tokenFor(owner);
    await declare(ownerToken, declarationFor(owner.namespace));

    const otherToken = await tokenFor(other);
    const registered = await declare(
      otherToken,
      declarationFor(other.namespace, {
        requestedAccess: { roles: ["webhook_publisher"] },
      })
    );
    await api(
      "POST",
      `/v1/admin/services/${other.id}/access/approve`,
      adminToken,
      {
        ids: registered.body.access.map((a: { id: string }) => a.id),
      }
    );

    expect(
      (await emit(otherToken, `${other.namespace}.item.created`)).status
    ).toBe(202);
    expect(
      (await emit(otherToken, `${owner.namespace}.item.created`)).status
    ).toBe(403);
  });

  it("refuses a request for a role that does not exist", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const res = await declare(
      token,
      declarationFor(service.namespace, {
        requestedAccess: { roles: ["no_such_role", "nobody/role"] },
      })
    );
    expect(res.status).toBe(422);
  });

  it("lets an approved audience introspect the service's tokens", async () => {
    const issuer = await addService();
    const resource = await addService();
    const issuerToken = await tokenFor(issuer);
    const registered = await declare(
      issuerToken,
      declarationFor(issuer.namespace, {
        requestedAccess: { audiences: [resource.slug] },
      })
    );

    const introspect = async (token: string) => {
      const { clientId, clientSecret } = resource.credentials;
      const response = await fetch(`${ROOT}/oauth/introspect`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `token=${encodeURIComponent(token)}`,
      });
      return ((await response.json()) as { active: boolean }).active;
    };

    expect(await introspect(issuerToken)).toBe(false);
    await api(
      "POST",
      `/v1/admin/services/${issuer.id}/access/approve`,
      adminToken,
      {
        ids: [registered.body.access[0].id],
      }
    );
    // The audience is stamped when the token is issued.
    expect(await introspect(await tokenFor(issuer))).toBe(true);
  });
});

describe("approving requested access", () => {
  const request = async (roles: string[]) => {
    const service = await addService();
    const registered = await declare(
      await tokenFor(service),
      declarationFor(service.namespace, { requestedAccess: { roles } })
    );
    expect(registered.status).toBe(200);
    return {
      service,
      ids: (registered.body.access as { id: string }[]).map((a) => a.id),
    };
  };

  const accountRoles = async (serviceId: string) => {
    const service = await prisma.service.findUniqueOrThrow({
      where: { id: serviceId },
      select: { client: { select: { serviceAccountUser: true } } },
    });
    const userId = service.client!.serviceAccountUser!.id;
    return {
      userId,
      roles: await prisma.userRole.findMany({
        where: { userId },
        select: { role: { select: { name: true } } },
      }),
    };
  };

  it("refuses a role granting what the approver does not hold", async () => {
    const approver = await getTestPrincipalToken({
      permissions: ["services.approve"],
    });
    const { service, ids } = await request(["webhook_publisher"]);

    const res = await api(
      "POST",
      `/v1/admin/services/${service.id}/access/approve`,
      approver,
      { ids }
    );
    expect(res.status).toBe(403);
    expect(res.body.error_description).toContain("webhooks.emit");

    const access = await prisma.serviceAccess.findMany({
      where: { serviceId: service.id },
    });
    expect(access.map((a) => a.status)).toEqual(["pending"]);
    expect((await accountRoles(service.id)).roles).toEqual([]);
  });

  it("approves a role whose permissions the approver holds", async () => {
    const approver = await getTestPrincipalToken({
      permissions: ["services.approve", "webhooks.emit"],
    });
    const { service, ids } = await request(["webhook_publisher"]);

    const res = await api(
      "POST",
      `/v1/admin/services/${service.id}/access/approve`,
      approver,
      { ids }
    );
    expect(res.status).toBe(200);
    expect((await accountRoles(service.id)).roles).toEqual([
      { role: { name: "webhook_publisher" } },
    ]);
  });

  it("does not check a role the account already holds", async () => {
    const approver = await getTestPrincipalToken({
      permissions: ["services.approve"],
    });
    const { service, ids } = await request(["webhook_publisher"]);
    const { userId } = await accountRoles(service.id);
    const role = await prisma.role.findFirstOrThrow({
      where: { name: "webhook_publisher", serviceId: CORE_SERVICE_ID },
    });
    await prisma.userRole.create({ data: { userId, roleId: role.id } });

    const res = await api(
      "POST",
      `/v1/admin/services/${service.id}/access/approve`,
      approver,
      { ids }
    );
    expect(res.status).toBe(200);
  });
});

describe("access to another service's role", () => {
  /**
   * An owner declaring `<ns>_editor` over `grants`, and a consumer whose
   * request for it an admin approved.
   */
  const approvedConsumer = async () => {
    const owner = await addService();
    const ownerToken = await tokenFor(owner);
    const ns = owner.namespace;
    const roleName = `${ns}_editor`;
    const declareOwner = (grants: string[]) =>
      declare(
        ownerToken,
        declarationFor(ns, {
          systemRoles: [
            {
              name: roleName,
              displayName: "Editor",
              permissions: grants.map((g) => `${ns}.items.${g}`),
            },
          ],
        })
      );
    expect((await declareOwner(["read"])).status).toBe(200);

    const consumer = await addService();
    const target = `${owner.slug}/${roleName}`;
    const registered = await declare(
      await tokenFor(consumer),
      declarationFor(consumer.namespace, {
        requestedAccess: { roles: [target] },
      })
    );
    expect(registered.status).toBe(200);
    const accessId = registered.body.access[0].id as string;
    const approved = await api(
      "POST",
      `/v1/admin/services/${consumer.id}/access/approve`,
      superApprover,
      { ids: [accessId] }
    );
    expect(approved.status).toBe(200);

    const account = await prisma.service.findUniqueOrThrow({
      where: { id: consumer.id },
      select: { client: { select: { serviceAccountUser: true } } },
    });
    const accountId = account.client!.serviceAccountUser!.id;
    return {
      ns,
      consumer,
      accessId,
      declareOwner,
      permissions: () => db.roles.getUserPermissions(accountId),
      accessRow: async () =>
        (
          await api("GET", `/v1/admin/services/${consumer.id}`, adminToken)
        ).body.access.find((a: { id: string }) => a.id === accessId),
    };
  };

  let superApprover: string;
  beforeAll(async () => {
    superApprover = await getTestPrincipalToken({
      permissions: ["services.approve", "admin"],
    });
  });

  it("holds back what the role gains after approval, as a pending request", async () => {
    const { ns, consumer, accessId, declareOwner, permissions, accessRow } =
      await approvedConsumer();
    expect(await permissions()).toEqual([`${ns}.items.read`]);

    expect((await declareOwner(["read", "write"])).status).toBe(200);
    expect(await permissions()).toEqual([`${ns}.items.read`]);
    expect(await accessRow()).toMatchObject({
      status: "pending",
      approvedPermissions: [`${ns}.items.read`],
      pendingPermissions: [`${ns}.items.write`],
    });

    const inbox = await api(
      "GET",
      `/v1/admin/services/access?filter[status]=pending&filter[serviceId]=${consumer.id}`,
      adminToken
    );
    expect(inbox.body.data.map((a: { id: string }) => a.id)).toEqual([
      accessId,
    ]);
  });

  it("grants the gain once approved, by an approver who holds it", async () => {
    const { ns, consumer, accessId, declareOwner, permissions, accessRow } =
      await approvedConsumer();
    await declareOwner(["read", "write"]);

    // Holds what was approved before, not what the role gained.
    const approverId = randomUUID();
    const partial = await getTestPrincipalToken({
      userId: approverId,
      permissions: ["services.approve"],
    });
    const read = await prisma.permission.findUniqueOrThrow({
      where: { name: `${ns}.items.read` },
    });
    const holdsRead = await prisma.role.create({
      data: {
        name: `holds-read-${rand()}`,
        displayName: "Holds read",
        rolePermissions: { create: [{ permissionId: read.id }] },
      },
    });
    await prisma.userRole.create({
      data: { userId: approverId, roleId: holdsRead.id },
    });
    const refused = await api(
      "POST",
      `/v1/admin/services/${consumer.id}/access/approve`,
      partial,
      { ids: [accessId] }
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error_description).toContain(`${ns}.items.write`);
    expect(refused.body.error_description).not.toContain(`${ns}.items.read`);

    const approved = await api(
      "POST",
      `/v1/admin/services/${consumer.id}/access/approve`,
      superApprover,
      { ids: [accessId] }
    );
    expect(approved.status).toBe(200);
    expect(await permissions()).toEqual([
      `${ns}.items.read`,
      `${ns}.items.write`,
    ]);
    expect(await accessRow()).toMatchObject({
      status: "approved",
      approvedPermissions: [`${ns}.items.read`, `${ns}.items.write`],
      pendingPermissions: [],
    });
  });

  it("shrinks with the role, and is approved again once a gain is dropped", async () => {
    const { ns, declareOwner, permissions, accessRow } =
      await approvedConsumer();
    await declareOwner(["read", "write"]);
    expect((await accessRow()).status).toBe("pending");

    await declareOwner([]);
    expect(await permissions()).toEqual([]);
    expect((await accessRow()).status).toBe("approved");

    await declareOwner(["read"]);
    expect(await permissions()).toEqual([`${ns}.items.read`]);
  });
});

describe("org-assignable permissions", () => {
  it("stores the flag a declaration gives, false when it gives none", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const ns = service.namespace;
    const declaration = declarationFor(ns, {
      permissions: [
        { name: `${ns}.items.read`, displayName: "Read", orgAssignable: true },
        { name: `${ns}.items.write`, displayName: "Write" },
      ],
    });
    expect((await declare(token, declaration)).status).toBe(200);

    const flags = await prisma.permission.findMany({
      where: { serviceId: service.id },
      select: { name: true, orgAssignable: true },
      orderBy: { name: "asc" },
    });
    expect(flags).toEqual([
      { name: `${ns}.items.read`, orgAssignable: true },
      { name: `${ns}.items.write`, orgAssignable: false },
    ]);

    // Changing only the flag is a change.
    const flipped = await declare(
      token,
      declarationFor(ns, {
        permissions: [
          { name: `${ns}.items.read`, displayName: "Read" },
          { name: `${ns}.items.write`, displayName: "Write" },
        ],
      })
    );
    expect(flipped.body.changed).toBe(true);
    expect(
      (
        await prisma.permission.findUniqueOrThrow({
          where: { name: `${ns}.items.read` },
        })
      ).orgAssignable
    ).toBe(false);
  });

  it("marks core's org-scoped permissions, and only those", async () => {
    const assignable = (
      await prisma.permission.findMany({
        where: { serviceId: CORE_SERVICE_ID, orgAssignable: true },
        select: { name: true },
      })
    ).map((p) => p.name);
    expect(assignable).toContain("file-service.objects.write");
    expect(assignable).toContain("webhooks.write");
    expect(assignable).toContain("audit-logs.read");
    for (const global of [
      "admin",
      "users.read",
      "roles.write",
      "organizations.read",
      "organizations.write",
      "services.approve",
      "settings.write",
      "clients.write",
      "file-service.admin",
      "webhooks.admin",
      "audit-logs.admin",
    ]) {
      expect(assignable).not.toContain(global);
    }
  });
});

describe("services admin API", () => {
  /** A service with two pending requests: a role and an audience. */
  const withPendingRequests = async () => {
    const service = await addService();
    const audience = await addService();
    const registered = await declare(
      await tokenFor(service),
      declarationFor(service.namespace, {
        requestedAccess: {
          roles: ["webhook_publisher"],
          audiences: [audience.slug],
        },
      })
    );
    expect(registered.status).toBe(200);
    return { service, access: registered.body.access as { id: string }[] };
  };

  it("counts each service's pending requests in the list", async () => {
    const { service, access } = await withPendingRequests();
    const findCount = async () => {
      const res = await api(
        "GET",
        `/v1/admin/services?filter[slug]=${service.slug}&filter[slug_op]=equals`,
        adminToken
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      return res.body.data[0].pendingAccessCount;
    };
    expect(await findCount()).toBe(2);

    await api(
      "POST",
      `/v1/admin/services/${service.id}/access/approve`,
      adminToken,
      { ids: [access[0].id] }
    );
    expect(await findCount()).toBe(1);
  });

  it("lists access requests across services, filtered and paginated", async () => {
    const first = await withPendingRequests();
    const second = await withPendingRequests();

    const pending = await api(
      "GET",
      "/v1/admin/services/access?filter[status]=pending&limit=200",
      adminToken
    );
    expect(pending.status).toBe(200);
    const ids = pending.body.data.map((a: { id: string }) => a.id);
    for (const a of [...first.access, ...second.access]) {
      expect(ids).toContain(a.id);
    }
    expect(
      pending.body.data.every((a: { status: string }) => a.status === "pending")
    ).toBe(true);
    const row = pending.body.data.find(
      (a: { id: string }) => a.id === first.access[0].id
    );
    expect(row.service).toEqual({
      id: first.service.id,
      slug: first.service.slug,
      name: expect.any(String),
    });
    expect(row.decidedByEmail).toBeNull();

    // One service's requests, a page at a time.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await api(
        "GET",
        `/v1/admin/services/access?filter[serviceId]=${first.service.id}&limit=1${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
        adminToken
      );
      expect(page.status).toBe(200);
      expect(page.body.data.length).toBeLessThanOrEqual(1);
      seen.push(...page.body.data.map((a: { id: string }) => a.id));
      cursor = page.body.hasMore ? page.body.nextCursor : null;
    } while (cursor);
    expect(seen.sort()).toEqual(first.access.map((a) => a.id).sort());

    await api(
      "POST",
      `/v1/admin/services/${first.service.id}/access/approve`,
      adminToken,
      { ids: [first.access[0].id] }
    );
    const approved = await api(
      "GET",
      `/v1/admin/services/access?filter[status]=approved&filter[serviceId]=${first.service.id}`,
      adminToken
    );
    expect(approved.body.data.map((a: { id: string }) => a.id)).toEqual([
      first.access[0].id,
    ]);
  });

  it("refuses the access list without services.read, or with a bad status", async () => {
    const outsider = await getTestPrincipalToken({
      permissions: ["roles.read"],
    });
    expect(
      (await api("GET", "/v1/admin/services/access", outsider)).status
    ).toBe(403);
    expect((await api("GET", "/v1/admin/services/access", null)).status).toBe(
      401
    );
    expect(
      (
        await api(
          "GET",
          "/v1/admin/services/access?filter[status]=maybe",
          adminToken
        )
      ).status
    ).toBe(400);
  });

  it("names who decided each access row", async () => {
    const { service, access } = await withPendingRequests();
    await api(
      "POST",
      `/v1/admin/services/${service.id}/access/approve`,
      adminToken,
      { ids: [access[0].id] }
    );
    const row = await prisma.serviceAccess.findUniqueOrThrow({
      where: { id: access[0].id },
      include: { decider: true },
    });
    expect(row.decider).not.toBeNull();

    const detail = await api(
      "GET",
      `/v1/admin/services/${service.id}`,
      adminToken
    );
    expect(detail.status).toBe(200);
    const decided = detail.body.access.find(
      (a: { id: string }) => a.id === access[0].id
    );
    expect(decided).toMatchObject({
      decidedBy: row.decider!.id,
      decidedByEmail: row.decider!.email,
      decidedByName: row.decider!.name,
    });
    const undecided = detail.body.access.find(
      (a: { id: string }) => a.id === access[1].id
    );
    expect(undecided).toMatchObject({
      decidedBy: null,
      decidedByEmail: null,
      decidedByName: null,
    });

    const listedRow = (
      await api(
        "GET",
        `/v1/admin/services/access?filter[serviceId]=${service.id}`,
        adminToken
      )
    ).body.data.find((a: { id: string }) => a.id === access[0].id);
    expect(listedRow.decidedByEmail).toBe(row.decider!.email);
  });

  it("states the secret overlap and retirement grace period", async () => {
    const service = await addService();
    const detail = await api(
      "GET",
      `/v1/admin/services/${service.id}`,
      adminToken
    );
    expect(detail.status).toBe(200);
    expect(detail.body.settings).toEqual({
      secretOverlapHours: env.SERVICE_SECRET_OVERLAP_HOURS,
      retirementGraceHours: env.REGISTRY_RETIREMENT_GRACE_HOURS,
    });
  });
});

describe("retirement", () => {
  it("retires what a declaration drops after the grace period, and restores it on re-declaring", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const full = declarationFor(service.namespace);
    await declare(token, full);

    const dropped = `${service.namespace}.items.write`;
    await declare(token, {
      ...full,
      permissions: full.permissions.filter((p) => p.name !== dropped),
    });
    const missing = await prisma.permission.findUniqueOrThrow({
      where: { name: dropped },
    });
    expect(missing.missingSince).not.toBeNull();
    expect(missing.retiredAt).toBeNull();

    await retireMissing(new Date(Date.now() + 23 * 60 * 60 * 1000));
    expect(
      (await prisma.permission.findUniqueOrThrow({ where: { name: dropped } }))
        .retiredAt
    ).toBeNull();

    await retireMissing(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(
      (await prisma.permission.findUniqueOrThrow({ where: { name: dropped } }))
        .retiredAt
    ).not.toBeNull();

    await declare(token, full);
    const back = await prisma.permission.findUniqueOrThrow({
      where: { name: dropped },
    });
    expect(back.retiredAt).toBeNull();
    expect(back.missingSince).toBeNull();
  });

  it("makes a retired bucket read-only", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const bucketName = `${service.namespace}-docs`;
    const withBucket = declarationFor(service.namespace, {
      buckets: [{ bucketName, policy: "private" }],
      requestedAccess: { roles: ["file_user"] },
    });
    const registered = await declare(token, withBucket);
    expect(registered.status).toBe(200);
    await api(
      "POST",
      `/v1/admin/services/${service.id}/access/approve`,
      adminToken,
      {
        ids: registered.body.access.map((a: { id: string }) => a.id),
      }
    );

    const file = {
      buffer: Buffer.from("hello"),
      filename: "a.txt",
      contentType: "text/plain",
    };
    await uploadTestObject(token, bucketName, "a.txt", file);

    await declare(token, { ...withBucket, buckets: [] });
    await retireMissing(new Date(Date.now() + 25 * 60 * 60 * 1000));

    const form = new FormData();
    form.append("file", file.buffer, {
      filename: "b.txt",
      contentType: "text/plain",
    });
    const upload = await axios.put(
      `${ROOT}/v1/files/buckets/${bucketName}/objects/b.txt`,
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": rand(),
          ...form.getHeaders(),
        },
        validateStatus: () => true,
      }
    );
    expect(upload.status).toBe(409);
    expect(upload.data.error ?? upload.data.code).toBe("bucket_retired");

    const download = await fetch(
      `${ROOT}/v1/files/buckets/${bucketName}/objects/a.txt`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("hello");
  });
});

describe("file_user", () => {
  it("reads its own bucket's settings, not another service's", async () => {
    const declareBucketOwner = async () => {
      const service = await addService();
      const token = await tokenFor(service);
      const registered = await declare(
        token,
        declarationFor(service.namespace, {
          buckets: [
            { bucketName: `${service.namespace}-docs`, policy: "private" },
          ],
          requestedAccess: { roles: ["file_user"] },
        })
      );
      await api(
        "POST",
        `/v1/admin/services/${service.id}/access/approve`,
        adminToken,
        {
          ids: registered.body.access.map((a: { id: string }) => a.id),
        }
      );
      return { service, token, bucket: `${service.namespace}-docs` };
    };
    const mine = await declareBucketOwner();
    const theirs = await declareBucketOwner();

    const own = await api(
      "GET",
      `/v1/files/buckets/${mine.bucket}`,
      mine.token
    );
    expect(own.status).toBe(200);
    expect(own.body.name).toBe(mine.bucket);

    expect(
      (await api("GET", `/v1/files/buckets/${theirs.bucket}`, mine.token))
        .status
    ).toBe(403);

    const listed = await api("GET", "/v1/files/buckets", mine.token);
    expect(listed.body.data.map((b: { name: string }) => b.name)).toEqual([
      mine.bucket,
    ]);
  });
});

describe("secrets", () => {
  it("keeps the previous secret working until it is revoked", async () => {
    const service = await addService();
    const regenerated = await api(
      "POST",
      `/v1/admin/services/${service.id}/regenerate-secret`,
      adminToken
    );
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.previousSecretExpiresAt).not.toBeNull();
    const fresh = {
      clientId: service.credentials.clientId,
      clientSecret: regenerated.body.clientSecret,
    };

    expect((await fetchToken(fresh)).status).toBe(200);
    expect((await fetchToken(service.credentials)).status).toBe(200);

    await api(
      "POST",
      `/v1/admin/services/${service.id}/revoke-previous-secret`,
      adminToken
    );
    expect((await fetchToken(service.credentials)).status).toBe(401);
    expect((await fetchToken(fresh)).status).toBe(200);
  });

  it("reports no overlap, and refuses the previous secret, once it expires", async () => {
    const service = await addService();
    const regenerated = await api(
      "POST",
      `/v1/admin/services/${service.id}/regenerate-secret`,
      adminToken
    );
    expect(regenerated.status).toBe(200);
    const live = await api(
      "GET",
      `/v1/admin/services/${service.id}`,
      adminToken
    );
    expect(live.body.previousSecretExpiresAt).toBe(
      regenerated.body.previousSecretExpiresAt
    );

    await prisma.oAuthClient.update({
      where: { clientId: service.credentials.clientId },
      data: { previousSecretExpiresAt: new Date(Date.now() - 1000) },
    });

    const expired = await api(
      "GET",
      `/v1/admin/services/${service.id}`,
      adminToken
    );
    expect(expired.status).toBe(200);
    expect(expired.body.previousSecretExpiresAt).toBeNull();
    expect((await fetchToken(service.credentials)).status).toBe(401);
    expect(
      (
        await fetchToken({
          clientId: service.credentials.clientId,
          clientSecret: regenerated.body.clientSecret,
        })
      ).status
    ).toBe(200);
  });

  it("stops a deactivated service", async () => {
    const service = await addService();
    const token = await tokenFor(service);
    const res = await api(
      "PATCH",
      `/v1/admin/services/${service.id}`,
      adminToken,
      {
        isActive: false,
      }
    );
    expect(res.status).toBe(200);
    expect(
      (await declare(token, declarationFor(service.namespace))).status
    ).toBe(401);
  });

  it("keeps a service's client out of /admin/clients", async () => {
    const service = await addService();
    const client = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: service.credentials.clientId },
    });
    const clientsAdmin = await getTestPrincipalToken({
      permissions: [
        "clients.read",
        "clients.write",
        "clients.delete",
        "clients.admin",
      ],
    });
    expect(
      (
        await api(
          "POST",
          `/v1/admin/clients/${client.id}/regenerate-secret`,
          clientsAdmin
        )
      ).status
    ).toBe(409);
  });
});

describe("core", () => {
  it("registers its own declaration on start", async () => {
    const core = await prisma.service.findUniqueOrThrow({
      where: { id: CORE_SERVICE_ID },
    });
    expect(core.declarationHash).toBe(
      declarationHash(declarationSchema.parse(CORE_DECLARATION))
    );
    expect(core.declarationVersion).toBe(CORE_VERSION);
    const admin = await prisma.role.findFirstOrThrow({
      where: { serviceId: CORE_SERVICE_ID, name: "admin" },
    });
    expect(admin.retiredAt).toBeNull();
  });

  it("is not managed through /admin/services", async () => {
    expect(
      (
        await api(
          "PATCH",
          `/v1/admin/services/${CORE_SERVICE_ID}`,
          adminToken,
          {
            isActive: false,
          }
        )
      ).status
    ).toBe(403);
  });

  it("keeps system roles read-only and lets admins duplicate them", async () => {
    const role = await prisma.role.findFirstOrThrow({
      where: { serviceId: CORE_SERVICE_ID, name: "webhook_publisher" },
    });
    expect(
      (
        await api("PATCH", `/v1/admin/roles/${role.id}`, adminToken, {
          displayName: "Renamed",
        })
      ).status
    ).toBe(403);
    expect(
      (
        await api("PUT", `/v1/admin/roles/${role.id}/permissions`, adminToken, {
          permissionIds: [],
        })
      ).status
    ).toBe(403);

    const copy = await api(
      "POST",
      `/v1/admin/roles/${role.id}/duplicate`,
      adminToken,
      {
        name: `publisher-copy-${rand()}`,
      }
    );
    expect(copy.status).toBe(201);
    expect(copy.body.isSystem).toBe(false);
    expect(copy.body.permissions.map((p: { name: string }) => p.name)).toEqual([
      "webhooks.emit",
    ]);
  });
});

describe("concurrent access decisions", () => {
  it("keeps both audiences when two are approved at once", async () => {
    // Each round races two approvals; without a lock on the client row one
    // would rewrite the audience the other just added.
    for (let round = 0; round < 5; round++) {
      const issuer = await addService();
      const [first, second] = [await addService(), await addService()];
      const registered = await declare(
        await tokenFor(issuer),
        declarationFor(issuer.namespace, {
          requestedAccess: { audiences: [first.slug, second.slug] },
        })
      );
      expect(registered.status).toBe(200);
      const ids = (registered.body.access as { id: string }[]).map((a) => a.id);
      expect(ids).toHaveLength(2);

      const results = await Promise.all(
        ids.map((id) =>
          api(
            "POST",
            `/v1/admin/services/${issuer.id}/access/approve`,
            adminToken,
            { ids: [id] }
          )
        )
      );
      expect(results.map((r) => r.status)).toEqual([200, 200]);

      const client = await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: issuer.credentials.clientId },
        select: { audience: true },
      });
      expect(client.audience).toEqual(
        expect.arrayContaining([first.slug, second.slug])
      );
    }
  });
});
