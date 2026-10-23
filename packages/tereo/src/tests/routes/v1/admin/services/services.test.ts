// @module-tag int
// @module-tag provisioning
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { SYSTEM_USER_ID } from "../../../../../definitions/index.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../support/coreUrl.js";
import { describe, it, expect, beforeAll } from "vitest";
import { fetchJson } from "../../../../support/http.js";
import { randomBytes } from "crypto";
import {
  provisionService,
  provisionServices,
  addService,
  newSlug,
  provisionDeclared,
} from "../../../../support/provisioning.js";

const ROOT = CORE_URL;

let adminToken: string;

const rand = () => `x${randomBytes(5).toString("hex")}`;

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${ROOT}${path}`, token, body);

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

describe("POST /v1/admin/services, GET /v1/admin/services and GET /v1/admin/services/access", () => {
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
      const service = await addService(adminToken);
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
      expect(res.body.error).toBe("invalid_request");
      expect(res.body.error_description).toContain("slug");
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
      const bad = await api(
        "GET",
        "/v1/admin/services/access?filter[status]=maybe",
        adminToken
      );
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_request");
      expect(bad.body.error_description).toContain("filter[status]");
    });
  });
});
