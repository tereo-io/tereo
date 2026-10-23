// @module-tag int
// @module-tag provisioning
// @module-tag race
import { clientCredentialsToken } from "../../../../../support/clientToken.js";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { CORE_SERVICE_ID } from "../../../../../../definitions/index.js";
import { waitForLockWait } from "../../../../../support/dbLocks.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import { describe, expect, it, beforeAll } from "vitest";
import db from "../../../../../../utils/db/index.js";
import { randomBytes } from "crypto";
import {
  provisionServices,
  newSlug,
} from "../../../../../support/provisioning.js";

const rand = () => `x${randomBytes(5).toString("hex")}`;

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${CORE_URL}${path}`, token, body);

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

const accountUserId = async (serviceId: string) => {
  const row = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    select: { client: { select: { serviceAccountUser: true } } },
  });
  return row.client!.serviceAccountUser!.id;
};

/** Resolves once some backend waits on a lock in a query matching `like`. */
let adminToken: string;

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

describe("/v1/admin/services/:id", () => {
  describe("approving access while provisioning changes the role", () => {
    it("records every permission the role grants once both commit", async () => {
      const admin = await superAdmin();
      const ownerSlug = `reg-${rand()}`;
      const consumerSlug = `reg-${rand()}`;
      const ns = ownerSlug;
      const roleName = `${ns}_editor`;
      const provisionBoth = (grants: string[], version: string) =>
        provisionServices([
          {
            slug: ownerSlug,
            version,
            declaration: {
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
            },
          },
          {
            slug: consumerSlug,
            access: { roles: [`${ownerSlug}/${roleName}`] },
          },
        ]);
      const [, consumer] = await provisionBoth(["read"], "1.0.0");
      const [access] = await prisma.serviceAccess.findMany({
        where: { serviceId: consumer.id },
      });
      const accessId = access.id;
      const revoked = await api(
        "POST",
        `/v1/admin/services/${consumer.id}/access/revoke`,
        admin,
        { ids: [accessId] }
      );
      expect(revoked.status).toBe(200);

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

      // The owner's release adds `write` to the role: it waits for the
      // approval to commit.
      const ownerRelease = provisionBoth(["read", "write"], "1.1.0");
      await Promise.race([
        ownerRelease,
        waitForLockWait("%pg_advisory_xact_lock%"),
      ]);

      release();
      await holder;
      expect((await approval).status).toBe(200);
      await ownerRelease;

      const row = await prisma.serviceAccess.findUniqueOrThrow({
        where: { id: accessId },
      });
      expect(row.status).toBe("approved");
      const names = await prisma.permission.findMany({
        where: { id: { in: row.approvedPermissionIds } },
        select: { name: true },
        orderBy: { name: "asc" },
      });
      expect(names.map((p) => p.name)).toEqual([
        `${ns}.items.read`,
        `${ns}.items.write`,
      ]);
      expect(
        (
          await db.roles.getUserPermissions(await accountUserId(consumer.id))
        ).sort()
      ).toEqual([`${ns}.items.read`, `${ns}.items.write`]);
    });
  });

  describe("revoking access to a retired core role", () => {
    it("removes the role, so declaring it again does not hand it back", async () => {
      const admin = await superAdmin();
      const [service] = await provisionServices([
        { access: { roles: ["notification_sender"] } },
      ]);
      const [access] = await prisma.serviceAccess.findMany({
        where: { serviceId: service.id },
      });
      const accessId = access.id;
      expect(access.status).toBe("approved");
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
          const { status } = await clientCredentialsToken({
            clientId: service.credentials.clientId,
            clientSecret: secret,
          });
          expect(status).toBe(200);
        }
      }
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
        expect(client.audience).toEqual(
          expect.arrayContaining([first, second])
        );
      }
    });
  });
});
