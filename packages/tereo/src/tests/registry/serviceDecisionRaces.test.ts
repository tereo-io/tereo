import { getTestPrincipalToken } from "../utils/principals.js";
import { CORE_SERVICE_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { describe, expect, it } from "vitest";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";

const rand = () => `x${randomBytes(5).toString("hex")}`;

const api = async (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => {
  const response = await fetch(`${CORE_URL}${path}`, {
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

const superAdmin = () => getTestPrincipalToken({ permissions: ["admin"] });

const addService = async (adminToken: string): Promise<AddedService> => {
  const id = rand();
  const res = await api("POST", "/v1/admin/services", adminToken, {
    name: `Svc ${id}`,
    slug: `svc-${id}-service`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

const fetchToken = async ({ clientId, clientSecret }: Credentials) => {
  const response = await fetch(`${CORE_URL}/oauth/token`, {
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

const accountUserId = async (serviceId: string) => {
  const row = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    select: { client: { select: { serviceAccountUser: true } } },
  });
  return row.client!.serviceAccountUser!.id;
};

/** Resolves once some backend waits on a lock in a query matching `like`. */
const waitForLockWait = async (like: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${like}`;
    if (Number(rows[0].n) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No backend waited on a lock for ${like}`);
};

describe("approving access while the role's owner registers", () => {
  it("leaves every permission the role grants approved or pending", async () => {
    const admin = await superAdmin();
    const owner = await addService(admin);
    const ownerToken = await tokenFor(owner);
    const ns = owner.namespace;
    const roleName = `${ns}_editor`;
    const declareOwner = (grants: string[], version: string) =>
      declare(ownerToken, {
        version,
        permissions: [
          { name: `${ns}.items.read`, displayName: "Read" },
          { name: `${ns}.items.write`, displayName: "Write" },
        ],
        systemRoles: [
          {
            name: roleName,
            displayName: "Editor",
            permissions: grants.map((g) => `${ns}.items.${g}`),
          },
        ],
      });
    expect((await declareOwner(["read"], "1.0.0")).status).toBe(200);

    const consumer = await addService(admin);
    const registered = await declare(await tokenFor(consumer), {
      version: "1.0.0",
      requestedAccess: { roles: [`${owner.slug}/${roleName}`] },
    });
    expect(registered.status).toBe(200);
    const accessId = registered.body.access[0].id as string;

    // Holding the access row stops the approval just before it records the
    // role's permissions.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "core"."service_access" WHERE id = ${accessId}::uuid FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 30_000 }
    );
    await isLocked;

    const approval = api(
      "POST",
      `/v1/admin/services/${consumer.id}/access/approve`,
      admin,
      { ids: [accessId] }
    );
    await waitForLockWait("%service_access%");

    // The owner's release adds `write` to the role: it either finishes or
    // waits for the approval to commit.
    const ownerRelease = declareOwner(["read", "write"], "1.1.0");
    await Promise.race([
      ownerRelease,
      waitForLockWait("%pg_advisory_xact_lock%"),
    ]);

    release();
    await holder;
    expect((await approval).status).toBe(200);
    expect((await ownerRelease).status).toBe(200);

    const row = await prisma.serviceAccess.findUniqueOrThrow({
      where: { id: accessId },
    });
    const names = await prisma.permission.findMany({
      where: { id: { in: row.approvedPermissionIds } },
      select: { name: true },
    });
    const detail = await api("GET", `/v1/admin/services/${consumer.id}`, admin);
    const view = detail.body.access.find(
      (a: { id: string }) => a.id === accessId
    );
    expect(
      [...view.approvedPermissions, ...view.pendingPermissions].sort()
    ).toEqual([`${ns}.items.read`, `${ns}.items.write`]);
    expect(names.map((p) => p.name)).toEqual([`${ns}.items.read`]);
    expect(row.status).toBe("pending");
  });
});

describe("revoking access to a retired core role", () => {
  it("removes the role, so declaring it again does not hand it back", async () => {
    const admin = await superAdmin();
    const service = await addService(admin);
    const registered = await declare(await tokenFor(service), {
      version: "1.0.0",
      requestedAccess: { roles: ["notification_sender"] },
    });
    expect(registered.status).toBe(200);
    const accessId = registered.body.access[0].id as string;
    const approved = await api(
      "POST",
      `/v1/admin/services/${service.id}/access/approve`,
      admin,
      { ids: [accessId] }
    );
    expect(approved.status).toBe(200);
    const userId = await accountUserId(service.id);
    expect(await db.roles.getUserPermissions(userId)).toContain(
      "notifications.send"
    );

    const role = await prisma.role.findFirstOrThrow({
      where: { serviceId: CORE_SERVICE_ID, name: "notification_sender" },
    });
    try {
      await prisma.role.update({
        where: { id: role.id },
        data: { missingSince: new Date(), retiredAt: new Date() },
      });
      const revoked = await api(
        "POST",
        `/v1/admin/services/${service.id}/access/revoke`,
        admin,
        { ids: [accessId] }
      );
      expect(revoked.status).toBe(200);
    } finally {
      // What core's next declaration of the role does.
      await prisma.role.update({
        where: { id: role.id },
        data: { missingSince: null, retiredAt: null },
      });
    }

    const row = await prisma.serviceAccess.findUniqueOrThrow({
      where: { id: accessId },
    });
    expect(row.status).toBe("revoked");
    expect(await db.roles.getUserPermissions(userId)).not.toContain(
      "notifications.send"
    );
  });
});

describe("regenerating a service's secret twice at once", () => {
  it("leaves both new secrets working", async () => {
    const admin = await superAdmin();
    for (let round = 0; round < 5; round++) {
      const service = await addService(admin);
      const path = `/v1/admin/services/${service.id}/regenerate-secret`;
      const [a, b] = await Promise.all([
        api("POST", path, admin),
        api("POST", path, admin),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      for (const secret of [a.body.clientSecret, b.body.clientSecret]) {
        const { status } = await fetchToken({
          clientId: service.credentials.clientId,
          clientSecret: secret,
        });
        expect(status).toBe(200);
      }
    }
  });
});
