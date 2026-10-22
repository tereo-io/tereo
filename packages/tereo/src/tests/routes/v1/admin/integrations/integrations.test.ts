// @module-tag int
// @module-tag auth
// @module-tag provisioning
import { removeServices } from "../../../../support/provisioning.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../support/coreUrl.js";
import { fetchJson } from "../../../../support/http.js";
import { randomBytes } from "crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../support/principals.js";

const createdSlugs: string[] = [];

let adminToken: string;

let readerToken: string;

let orgId: string;

const rand = () => randomBytes(5).toString("hex");

const api = (
  method: string,
  path: string,
  body?: unknown,
  token = adminToken
) => fetchJson(method, `${CORE_URL}${path}`, token, body);

interface Created {
  id: string;
  slug: string;
  credentials: { clientId: string; clientSecret: string };
}

const createIntegration = async (
  body: { organizationId?: string } = {}
): Promise<Created> => {
  const slug = `int-${rand()}`;
  createdSlugs.push(slug);
  const res = await api("POST", "/v1/admin/integrations", {
    name: `Integration ${slug}`,
    slug,
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body as Created;
};

const tokenResponse = (clientId: string, clientSecret: string) =>
  fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

const tokenOf = async ({ credentials }: Created) => {
  const response = await tokenResponse(
    credentials.clientId,
    credentials.clientSecret
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
};

const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as {
    jti: string;
    org_id?: string;
    aud?: string | string[];
  };

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: [
      "integrations.read",
      "integrations.write",
      "services.read",
      "services.write",
      "services.approve",
      "webhooks.read",
    ],
  });
  readerToken = await getTestPrincipalToken({
    permissions: ["services.read"],
  });
  orgId = await ensureTestOrganization("integrations-org");
});

afterAll(async () => {
  await removeServices(createdSlugs);
});

describe("POST /v1/admin/integrations and GET /v1/admin/integrations", () => {
  describe("creating integrations", () => {
    it("creates an org-bound integration whose tokens carry its organization", async () => {
      const created = await createIntegration({ organizationId: orgId });
      expect(created.credentials.clientSecret).toBeTruthy();
      expect(created).toMatchObject({
        slug: created.slug,
        organizationId: orgId,
        isActive: true,
        provisioned: false,
        roles: [],
        audience: [],
      });

      const claims = claimsOf(await tokenOf(created));
      expect(claims.org_id).toBe(orgId);

      const row = await prisma.service.findUniqueOrThrow({
        where: { id: created.id },
        include: { client: { include: { serviceAccountUser: true } } },
      });
      expect(row.kind).toBe("integration");
      expect(row.namespace).toBeNull();
      expect(row.client!.organizationId).toBe(orgId);
      const member = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: orgId,
            userId: row.client!.serviceAccountUser!.id,
          },
        },
      });
      expect(member).not.toBeNull();
    });

    it("creates a platform integration whose tokens carry no organization", async () => {
      const created = await createIntegration();
      expect(created).toMatchObject({ organizationId: null });
      expect(claimsOf(await tokenOf(created)).org_id).toBeUndefined();
    });

    it("shows the secret only once", async () => {
      const created = await createIntegration();
      const res = await api("GET", `/v1/admin/integrations/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.body.credentials).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(
        created.credentials.clientSecret
      );
      expect(res.body.clientId).toBe(created.credentials.clientId);
    });

    it("refuses an organization that does not exist", async () => {
      const res = await api("POST", "/v1/admin/integrations", {
        name: "Nowhere",
        slug: `int-${rand()}`,
        organizationId: "00000000-0000-7000-8000-00000000dead",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("unknown_organization");
    });

    it("requires integrations.read and integrations.write", async () => {
      expect(
        (await api("GET", "/v1/admin/integrations", undefined, readerToken))
          .status
      ).toBe(403);
      expect(
        (
          await api(
            "POST",
            "/v1/admin/integrations",
            { name: "x", slug: `int-${rand()}` },
            readerToken
          )
        ).status
      ).toBe(403);
    });

    it("lists integrations, and services list none of them", async () => {
      const created = await createIntegration();
      const list = await api(
        "GET",
        `/v1/admin/integrations?filter[slug]=${created.slug}&filter[slug_op]=equals`
      );
      expect(list.status).toBe(200);
      expect(list.body.data.map((i: { id: string }) => i.id)).toEqual([
        created.id,
      ]);

      const services = await api(
        "GET",
        `/v1/admin/services?filter[slug]=${created.slug}&filter[slug_op]=equals`
      );
      expect(services.status).toBe(200);
      expect(services.body.data).toEqual([]);
      expect(
        (await api("GET", `/v1/admin/services/${created.id}`)).status
      ).toBe(404);
      expect(
        (await api("PATCH", `/v1/admin/services/${created.id}`, { name: "x" }))
          .status
      ).toBe(404);
    });
  });

  describe("constraints", () => {
    it("refuses a service without a namespace, and a service bound to an organization", async () => {
      await expect(
        prisma.$executeRaw`
        INSERT INTO "core"."services" ("id", "slug", "name", "kind", "created_by", "updated_at")
        VALUES (gen_random_uuid(), ${`int-raw-${rand()}`}, 'raw', 'service', '00000000-0000-7000-8000-000000000001', now())`
      ).rejects.toThrow(/services_namespace_kind_check/);
      const slug = `int-raw-${rand()}`;
      await expect(
        prisma.$executeRaw`
        INSERT INTO "core"."services" ("id", "slug", "name", "namespace", "kind", "organization_id", "created_by", "updated_at")
        VALUES (gen_random_uuid(), ${slug}, 'raw', ${slug}, 'service', ${orgId}::uuid, '00000000-0000-7000-8000-000000000001', now())`
      ).rejects.toThrow(/services_organization_kind_check/);
    });
  });
});
