import { uploadTestObject } from "../files/utils/test-helpers.js";
import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { CORE_VERSION } from "../../utils/version.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { fetchJson } from "../utils/http.js";
import { randomBytes } from "crypto";
import FormData from "form-data";
import env from "../../env.js";
import axios from "axios";
import {
  provisionService,
  provisionServices,
  type ProvisionSpec,
} from "../provisioning/utils/test-helpers.js";
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

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${ROOT}${path}`, token, body);

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

const tokenFor = async (service: { credentials: Credentials }) => {
  const { status, token } = await fetchToken(service.credentials);
  expect(status).toBe(200);
  return token!;
};

const newSlug = () => `reg-${rand()}`;

type Declaration = NonNullable<ProvisionSpec["declaration"]>;

/** A small valid declaration under the namespace. */
const declarationFor = (
  ns: string,
  extra: Partial<Declaration> = {}
): Declaration => ({
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

/** A service provisioned with `declarationFor` its namespace, its slug. */
const provisionDeclared = (
  extra: Partial<Declaration> = {},
  spec: Omit<ProvisionSpec, "declaration"> = {}
) => {
  const slug = spec.slug ?? newSlug();
  return provisionService({
    ...spec,
    slug,
    declaration: declarationFor(spec.namespace ?? slug, extra),
  });
};

const accessOf = async (serviceId: string) =>
  prisma.serviceAccess.findMany({
    where: { serviceId },
    orderBy: [{ kind: "asc" }, { target: "asc" }],
  });

const decide = (
  serviceId: string,
  verb: "approve" | "revoke",
  ids: string[],
  token = adminToken
) =>
  api("POST", `/v1/admin/services/${serviceId}/access/${verb}`, token, {
    ids,
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
        ownerId: SYSTEM_USER_ID,
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
      const service = await provisionDeclared(
        { buckets: [{ bucketName, policy: "private" }] },
        { namespace }
      );

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

describe("a provisioned service's declaration", () => {
  it("is applied under the service", async () => {
    const service = await provisionDeclared();
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
  });

  it("stores an event type's read permission, its own or core's", async () => {
    const slug = newSlug();
    const ns = slug;
    const service = await provisionDeclared(
      {
        eventTypes: [
          {
            eventType: `${ns}.item.created`,
            readPermission: `${ns}.items.read`,
          },
          { eventType: `${ns}.user.linked`, readPermission: "users.read" },
          { eventType: `${ns}.item.pinged` },
        ],
      },
      { slug }
    );
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
});

describe("provisioned access", () => {
  it("works once applied; revoking takes it away, approving gives it back", async () => {
    const service = await provisionDeclared(
      {},
      { access: { roles: ["webhook_publisher"] } }
    );
    let token = await tokenFor(service);
    const eventType = `${service.namespace}.item.created`;

    const access = await accessOf(service.id);
    expect(access).toEqual([
      expect.objectContaining({
        kind: "role",
        target: "webhook_publisher",
        status: "approved",
        decidedBy: SYSTEM_USER_ID,
      }),
    ]);
    expect((await emit(token, eventType)).status).toBe(202);

    const revoked = await decide(service.id, "revoke", [access[0].id]);
    expect(revoked.status).toBe(200);
    expect((await emit(token, eventType)).status).toBe(401);
    token = await tokenFor(service);
    expect((await emit(token, eventType)).status).toBe(403);

    const approved = await decide(service.id, "approve", [access[0].id]);
    expect(approved.status).toBe(200);
    // Permissions resolve per request: the same token now succeeds.
    expect((await emit(token, eventType)).status).toBe(202);
  });

  it("only lets a service emit its own event types", async () => {
    const owner = await provisionDeclared();
    const other = await provisionDeclared(
      {},
      { access: { roles: ["webhook_publisher"] } }
    );
    const otherToken = await tokenFor(other);

    expect(
      (await emit(otherToken, `${other.namespace}.item.created`)).status
    ).toBe(202);
    expect(
      (await emit(otherToken, `${owner.namespace}.item.created`)).status
    ).toBe(403);
  });

  it.each(["admin", "core/admin"])(
    "refuses to approve a %s row that slipped onto file",
    async (target) => {
      const service = await addService();
      await tokenFor(service);
      const row = await prisma.serviceAccess.create({
        data: {
          serviceId: service.id,
          kind: "role",
          target,
          status: "revoked",
        },
      });
      const res = await decide(service.id, "approve", [row.id]);
      expect(res.status).toBe(422);
      expect(
        (
          await prisma.serviceAccess.findUniqueOrThrow({
            where: { id: row.id },
          })
        ).status
      ).toBe("revoked");
    }
  );

  it("lets an approved audience introspect the service's tokens", async () => {
    const resourceSlug = newSlug();
    const [resource, issuer] = await provisionServices([
      { slug: resourceSlug },
      { access: { audiences: [resourceSlug] } },
    ]);

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

    expect(await introspect(await tokenFor(issuer))).toBe(true);
    const [row] = await accessOf(issuer.id);
    await decide(issuer.id, "revoke", [row.id]);
    // The audience is stamped when the token is issued.
    expect(await introspect(await tokenFor(issuer))).toBe(false);
  });
});

describe("approving revoked access again", () => {
  /** A provisioned service whose access to `roles` an admin revoked. */
  const revokedAccess = async (roles: string[]) => {
    const service = await provisionService({ access: { roles } });
    const ids = (await accessOf(service.id)).map((a) => a.id);
    expect((await decide(service.id, "revoke", ids)).status).toBe(200);
    return { service, ids };
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
    const { service, ids } = await revokedAccess(["webhook_publisher"]);

    const res = await decide(service.id, "approve", ids, approver);
    expect(res.status).toBe(403);
    expect(res.body.error_description).toContain("webhooks.emit");

    const access = await accessOf(service.id);
    expect(access.map((a) => a.status)).toEqual(["revoked"]);
    expect((await accountRoles(service.id)).roles).toEqual([]);
  });

  it("approves a role whose permissions the approver holds", async () => {
    const approver = await getTestPrincipalToken({
      permissions: ["services.approve", "webhooks.emit"],
    });
    const { service, ids } = await revokedAccess(["webhook_publisher"]);

    const res = await decide(service.id, "approve", ids, approver);
    expect(res.status).toBe(200);
    expect((await accountRoles(service.id)).roles).toEqual([
      { role: { name: "webhook_publisher" } },
    ]);
  });

  it("does not check a role the account already holds", async () => {
    const approver = await getTestPrincipalToken({
      permissions: ["services.approve"],
    });
    const { service, ids } = await revokedAccess(["webhook_publisher"]);
    const { userId } = await accountRoles(service.id);
    const role = await prisma.role.findFirstOrThrow({
      where: { name: "webhook_publisher", serviceId: CORE_SERVICE_ID },
    });
    await prisma.userRole.create({ data: { userId, roleId: role.id } });

    const res = await decide(service.id, "approve", ids, approver);
    expect(res.status).toBe(200);
  });
});

describe("org-assignable permissions", () => {
  it("stores the flag a declaration gives, false when it gives none", async () => {
    const slug = newSlug();
    const ns = slug;
    await provisionDeclared(
      {
        permissions: [
          {
            name: `${ns}.items.read`,
            displayName: "Read",
            orgAssignable: true,
          },
          { name: `${ns}.items.write`, displayName: "Write" },
        ],
      },
      { slug }
    );
    const service = await prisma.service.findUniqueOrThrow({ where: { slug } });

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
    await provisionDeclared(
      {
        permissions: [
          { name: `${ns}.items.read`, displayName: "Read" },
          { name: `${ns}.items.write`, displayName: "Write" },
        ],
      },
      { slug }
    );
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
  /** A provisioned service with two approved access rows: a role and an audience. */
  const withAccess = async () => {
    const audienceSlug = newSlug();
    const [, service] = await provisionServices([
      { slug: audienceSlug },
      {
        access: { roles: ["webhook_publisher"], audiences: [audienceSlug] },
      },
    ]);
    const access = await accessOf(service.id);
    expect(access).toHaveLength(2);
    return { service, access };
  };

  it("lists services without a count of requests", async () => {
    const service = await provisionService();
    const res = await api(
      "GET",
      `/v1/admin/services?filter[slug]=${service.slug}&filter[slug_op]=equals`,
      adminToken
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).not.toHaveProperty("pendingAccessCount");
  });

  it("lists access by service and status, a page at a time", async () => {
    const first = await withAccess();
    const second = await withAccess();

    const approvedOf = (serviceId: string) =>
      api(
        "GET",
        `/v1/admin/services/access?filter[status]=approved&filter[serviceId]=${serviceId}`,
        adminToken
      );
    for (const { service, access } of [first, second]) {
      const approved = await approvedOf(service.id);
      expect(approved.status).toBe(200);
      expect(
        approved.body.data.map((a: { id: string }) => a.id).sort()
      ).toEqual(access.map((a) => a.id).sort());
    }
    const row = (await approvedOf(first.service.id)).body.data.find(
      (a: { id: string }) => a.id === first.access[0].id
    );
    expect(row.service).toEqual({
      id: first.service.id,
      slug: first.service.slug,
      name: expect.any(String),
    });
    expect(row).not.toHaveProperty("pendingPermissions");

    // One service's access, a page at a time.
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

    await decide(first.service.id, "revoke", [first.access[0].id]);
    const revoked = await api(
      "GET",
      `/v1/admin/services/access?filter[status]=revoked&filter[serviceId]=${first.service.id}`,
      adminToken
    );
    expect(revoked.body.data.map((a: { id: string }) => a.id)).toEqual([
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
    for (const status of ["maybe", "pending"]) {
      expect(
        (
          await api(
            "GET",
            `/v1/admin/services/access?filter[status]=${status}`,
            adminToken
          )
        ).status,
        status
      ).toBe(400);
    }
  });

  it("names who decided each access row", async () => {
    const { service, access } = await withAccess();
    await decide(service.id, "revoke", [access[0].id]);
    const row = await prisma.serviceAccess.findUniqueOrThrow({
      where: { id: access[0].id },
      include: { decider: true },
    });
    expect(row.decider).not.toBeNull();
    expect(row.decidedBy).not.toBe(SYSTEM_USER_ID);

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
    // Approved by provisioning, as core.
    const provisioned = detail.body.access.find(
      (a: { id: string }) => a.id === access[1].id
    );
    expect(provisioned).toMatchObject({ decidedBy: SYSTEM_USER_ID });

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
  it("retires what a declaration drops after the grace period, and restores it on declaring it again", async () => {
    const slug = newSlug();
    const full = declarationFor(slug);
    await provisionService({ slug, declaration: full });

    const dropped = `${slug}.items.write`;
    await provisionService({
      slug,
      declaration: {
        ...full,
        permissions: full.permissions!.filter((p) => p.name !== dropped),
      },
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

    await provisionService({ slug, declaration: full });
    const back = await prisma.permission.findUniqueOrThrow({
      where: { name: dropped },
    });
    expect(back.retiredAt).toBeNull();
    expect(back.missingSince).toBeNull();
  });

  it("makes a retired bucket read-only", async () => {
    const slug = newSlug();
    const bucketName = `${slug}-docs`;
    const access = { roles: ["file_user"] };
    const service = await provisionDeclared(
      { buckets: [{ bucketName, policy: "private" }] },
      { slug, access }
    );
    const token = await tokenFor(service);

    const file = {
      buffer: Buffer.from("hello"),
      filename: "a.txt",
      contentType: "text/plain",
    };
    await uploadTestObject(token, bucketName, "a.txt", file);

    await provisionDeclared({ buckets: [] }, { slug, access });
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
    const bucketOwner = async () => {
      const slug = newSlug();
      const service = await provisionDeclared(
        { buckets: [{ bucketName: `${slug}-docs`, policy: "private" }] },
        { slug, access: { roles: ["file_user"] } }
      );
      return { token: await tokenFor(service), bucket: `${slug}-docs` };
    };
    const mine = await bucketOwner();
    const theirs = await bucketOwner();

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

  it("retires the secrets a regeneration pushes out and a revoke ends", async () => {
    const service = await addService();
    const row = () =>
      prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: service.credentials.clientId },
      });
    const first = (await row()).clientSecret;
    for (let i = 0; i < 2; i++) {
      const res = await api(
        "POST",
        `/v1/admin/services/${service.id}/regenerate-secret`,
        adminToken
      );
      expect(res.status).toBe(200);
    }
    const rotated = await row();
    expect(rotated.retiredSecretHashes).toEqual([first]);

    const revoked = await api(
      "POST",
      `/v1/admin/services/${service.id}/revoke-previous-secret`,
      adminToken
    );
    expect(revoked.status).toBe(200);
    expect(JSON.stringify(revoked.body)).not.toContain(first!);
    const after = await row();
    expect(after.previousSecretHash).toBeNull();
    expect(after.retiredSecretHashes).toEqual([
      first,
      rotated.previousSecretHash,
    ]);
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
    expect((await api("GET", "/v1/files/buckets", token)).status).toBe(401);
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
      const [first, second] = [newSlug(), newSlug()];
      const [issuer] = await provisionServices([
        { access: { audiences: [first, second] } },
        { slug: first },
        { slug: second },
      ]);
      const ids = (await accessOf(issuer.id)).map((a) => a.id);
      expect(ids).toHaveLength(2);
      expect((await decide(issuer.id, "revoke", ids)).status).toBe(200);

      const results = await Promise.all(
        ids.map((id) => decide(issuer.id, "approve", [id]))
      );
      expect(results.map((r) => r.status)).toEqual([200, 200]);

      const client = await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: issuer.credentials.clientId },
        select: { audience: true },
      });
      expect(client.audience).toEqual(expect.arrayContaining([first, second]));
    }
  });
});
