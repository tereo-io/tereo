// @module-tag int
// @module-tag audit
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../support/coreUrl.js";
import crypto from "crypto";
import axios from "axios";
import {
  provisionService,
  removeServices,
  type ProvisionedService,
} from "../../../../support/provisioning.js";
import {
  cleanup as cleanupIntegrations,
  createIntegration,
  grant,
  integrationToken,
} from "../../../../support/integrations.js";
import {
  ensureTestUser,
  getTestPrincipalToken,
  ensureTestOrganization,
} from "../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  cleanupTestEntities,
  generateUniqueId,
} from "../../../../support/audit.js";

describe("GET /v1/audit/entries and /v1/audit/entries/facets", () => {
  describe("Audit Log Entries", () => {
    let token: string;
    const organizationId = getTestOrgId();

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterEach(async () => {
      await cleanupTestEntities();
    });

    // ── Helper to create an entry with organizationId matching the test org ──────

    async function createEntry(overrides: Record<string, unknown> = {}) {
      return axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${generateUniqueId()}`,
          ...overrides,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    }

    describe("Tenant scoping", () => {
      it("should scope list results by organizationId from token", async () => {
        const uniqueId = generateUniqueId();
        const source = `test-scope-${uniqueId}`;

        // Create entry for org-1
        await createEntry({ source, entityId: `order-${uniqueId}-1` });

        // Create entry for org-2 (via write route, which doesn't require resolveOrganizationId)
        const org2Token = await getTestAccessToken(
          "00000000-0000-7001-8000-000000000002",
          "00000000-0000-7002-8000-000000000002"
        );
        await axios.post(
          `${BASE_URL}/entries`,
          {
            source,
            organizationId: "00000000-0000-7002-8000-000000000002",
            userId: "00000000-0000-7001-8000-000000000002",
            action: "CREATE",
            entityType: "Order",
            entityId: `order-${uniqueId}-2`,
          },
          { headers: { Authorization: `Bearer ${org2Token}` } }
        );

        // org-1 should only see their entry
        const org1Response = await axios.get(`${BASE_URL}/entries`, {
          params: { "filter[source]": source },
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        });

        expect(org1Response.status).toBe(HTTP_STATUS.OK);
        expect(org1Response.data.data).toHaveLength(1);
        expect(org1Response.data.data[0].organizationId).toBe(organizationId);

        // org-2 should only see their entry
        const org2Response = await axios.get(`${BASE_URL}/entries`, {
          params: { "filter[source]": source },
          headers: { Authorization: `Bearer ${org2Token}` },
          validateStatus: () => true,
        });

        expect(org2Response.status).toBe(HTTP_STATUS.OK);
        expect(org2Response.data.data).toHaveLength(1);
        expect(org2Response.data.data[0].organizationId).toBe(
          "00000000-0000-7002-8000-000000000002"
        );
      });
    });

    describe("Auth enforcement", () => {
      it("checks the read permission before the organization filter", async () => {
        const noPermsToken = await getTestPrincipalToken({
          organizationId: "00000000-0000-7002-8000-000000000001",
          permissions: ["other.read"],
        });
        const paths = [
          "",
          "/facets",
          `/${crypto.randomUUID()}`,
          "/entity/Order/order-1",
        ];
        for (const path of paths) {
          const response = await axios.get(`${BASE_URL}/entries${path}`, {
            params: { "filter[organizationId]": "not-an-org" },
            headers: { Authorization: `Bearer ${noPermsToken}` },
            validateStatus: () => true,
          });
          expect(response.status, path).toBe(HTTP_STATUS.FORBIDDEN);
          expect(response.data.error_description, path).toContain(
            "audit-logs.read"
          );
        }
      });

      it("should allow access with admin permission", async () => {
        const adminToken = await getTestPrincipalToken({
          organizationId: "00000000-0000-7002-8000-000000000001",
          permissions: ["audit-logs.admin"],
        });

        const response = await axios.get(`${BASE_URL}/entries`, {
          params: { limit: 1 },
          headers: { Authorization: `Bearer ${adminToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
      });
    });

    describe("Permission hierarchy", () => {
      it("should allow write permission to read entries", async () => {
        const writeToken = await getTestPrincipalToken({
          organizationId: "00000000-0000-7002-8000-000000000001",
          permissions: ["audit-logs.write"],
        });

        // First create an entry (write includes write)
        const uniqueId = generateUniqueId();
        await createEntry({ entityId: `order-${uniqueId}` });

        // write permission should also grant read access
        const response = await axios.get(`${BASE_URL}/entries`, {
          params: { limit: 1 },
          headers: { Authorization: `Bearer ${writeToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
      });

      it("should allow delete permission to read entries", async () => {
        const deleteToken = await getTestPrincipalToken({
          organizationId: "00000000-0000-7002-8000-000000000001",
          permissions: ["audit-logs.delete"],
        });

        const response = await axios.get(`${BASE_URL}/entries`, {
          params: { limit: 1 },
          headers: { Authorization: `Bearer ${deleteToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
      });
    });
  });

  describe("Audit organization scope", () => {
    const ORG_1 = "00000000-0000-7002-8000-000000000001";
    const ORG_2 = "00000000-0000-7002-8000-000000000002";
    const USER_1 = "00000000-0000-7001-8000-000000000001";
    const USER_2 = "00000000-0000-7001-8000-000000000002";

    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    const runId = generateUniqueId();
    const source = `test-scope-${runId}`;
    const entityType = `ScopeEntity${runId}`;
    const entityId = `scope-${runId}`;
    const ids: { org1: string; org2: string; systemWide: string } = {
      org1: "",
      org2: "",
      systemWide: "",
    };

    let org1Admin: string;
    let org1Reader: string;
    let rootAdmin: string;

    beforeAll(async () => {
      org1Admin = await getTestAccessToken(USER_1, ORG_1);
      const org2Admin = await getTestAccessToken(USER_2, ORG_2);
      org1Reader = await getTestPrincipalToken({
        organizationId: ORG_1,
        permissions: ["audit-logs.read"],
      });
      rootAdmin = await getTestPrincipalToken({
        organizationId: null,
        permissions: ["admin"],
      });

      const write = async (
        token: string,
        organizationId: string | null,
        userId: string
      ) => {
        const res = await axios.post(
          `${BASE_URL}/entries`,
          {
            source,
            organizationId,
            userId,
            userEmail: `test-scope-${runId}@example.com`,
            action: "UPDATE",
            entityType,
            entityId,
          },
          auth(token)
        );
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        return res.data.id as string;
      };

      ids.org1 = await write(org1Admin, ORG_1, USER_1);
      ids.org2 = await write(org2Admin, ORG_2, USER_2);
      ids.systemWide = await write(org1Admin, null, USER_1);
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const listIds = async (token: string, organizationFilter?: string) => {
      const res = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[source]": source,
          ...(organizationFilter && {
            "filter[organizationId]": organizationFilter,
          }),
        },
        ...auth(token),
      });
      return {
        status: res.status,
        ids:
          res.status === 200
            ? res.data.data.map((e: { id: string }) => e.id)
            : [],
      };
    };

    describe("GET /entries", () => {
      it("scopes to the token's organization without a filter", async () => {
        const result = await listIds(org1Admin);
        expect(result.status).toBe(HTTP_STATUS.OK);
        expect(result.ids).toEqual([ids.org1]);
      });

      it("lets audit-logs.admin read another organization", async () => {
        const result = await listIds(org1Admin, ORG_2);
        expect(result.status).toBe(HTTP_STATUS.OK);
        expect(result.ids).toEqual([ids.org2]);
      });

      it('lets audit-logs.admin read system-wide entries with "none"', async () => {
        const result = await listIds(org1Admin, "none");
        expect(result.status).toBe(HTTP_STATUS.OK);
        expect(result.ids).toEqual([ids.systemWide]);
      });

      it("lets a root admin token read across organizations and system-wide", async () => {
        const all = await listIds(rootAdmin);
        expect(all.status).toBe(HTTP_STATUS.OK);
        expect(all.ids.sort()).toEqual(
          [ids.org1, ids.org2, ids.systemWide].sort()
        );

        const systemWide = await listIds(rootAdmin, "none");
        expect(systemWide.ids).toEqual([ids.systemWide]);
      });

      it("refuses a non-admin naming another organization", async () => {
        const result = await listIds(org1Reader, ORG_2);
        expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it('refuses a non-admin asking for "none"', async () => {
        const result = await listIds(org1Reader, "none");
        expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it("lets a non-admin name their own organization", async () => {
        const result = await listIds(org1Reader, ORG_1);
        expect(result.status).toBe(HTTP_STATUS.OK);
        expect(result.ids).toEqual([ids.org1]);
      });

      it("refuses a non-admin token without an organization", async () => {
        const noOrgReader = await getTestPrincipalToken({
          organizationId: null,
          permissions: ["audit-logs.read"],
        });
        expect((await listIds(noOrgReader)).status).toBe(HTTP_STATUS.FORBIDDEN);
        expect((await listIds(noOrgReader, "none")).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
      });

      it("names the user, writer and organization", async () => {
        const res = await axios.get(`${BASE_URL}/entries`, {
          params: { "filter[source]": source },
          ...auth(org1Admin),
        });
        expect(res.status).toBe(HTTP_STATUS.OK);
        const [entry] = res.data.data;
        expect(entry.user).toEqual({
          id: USER_1,
          email: `test-user-${USER_1}@example.com`,
          name: `Test User ${USER_1}`,
        });
        expect(entry.writer).toMatchObject({ id: USER_1 });
        expect(entry.organization).toEqual({
          id: ORG_1,
          name: expect.any(String),
          slug: expect.any(String),
        });

        const systemWide = await axios.get(`${BASE_URL}/entries`, {
          params: {
            "filter[source]": source,
            "filter[organizationId]": "none",
          },
          ...auth(org1Admin),
        });
        expect(systemWide.data.data[0].organization).toBeNull();
      });
    });

    describe("GET /entries/facets", () => {
      const facets = (token: string, organizationFilter?: string) =>
        axios.get(`${BASE_URL}/entries/facets`, {
          params: organizationFilter
            ? { "filter[organizationId]": organizationFilter }
            : {},
          ...auth(token),
        });

      it("lists distinct sources and entity types in the caller's organization", async () => {
        const res = await facets(org1Reader);
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.sources).toContain(source);
        expect(res.data.entityTypes).toContain(entityType);
        expect(new Set(res.data.sources).size).toBe(res.data.sources.length);
        expect([...res.data.sources].sort()).toEqual(res.data.sources);
      });

      it("follows the organization filter for audit-logs.admin", async () => {
        const org2Only = `test-scope-only-${runId}`;
        const org2Admin = await getTestAccessToken(USER_2, ORG_2);
        await axios.post(
          `${BASE_URL}/entries`,
          {
            source: org2Only,
            organizationId: ORG_2,
            userId: USER_2,
            userEmail: `test-scope-${runId}@example.com`,
            action: "CREATE",
            entityType,
            entityId,
          },
          auth(org2Admin)
        );

        const own = await facets(org1Admin);
        expect(own.data.sources).not.toContain(org2Only);

        const other = await facets(org1Admin, ORG_2);
        expect(other.data.sources).toContain(org2Only);

        const systemWide = await facets(org1Admin, "none");
        expect(systemWide.data.sources).toContain(source);
        expect(systemWide.data.sources).not.toContain(org2Only);
      });

      it("refuses a non-admin naming another organization", async () => {
        const res = await facets(org1Reader, ORG_2);
        expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      });
    });
  });

  describe("Audit reads scoped to the calling service", () => {
    // A service reads the audit entries it wrote, under its own slug, across every
    // organization, with only audit-logs.read (audit_reader) or audit-logs.write
    // (audit_writer), and writes entries only under its own slug.

    const api = axios.create({ validateStatus: () => true });
    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
    });

    const clientToken = async (service: ProvisionedService) => {
      const { clientId, clientSecret } = service.credentials;
      const response = await fetch(`${CORE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { access_token: string }).access_token;
    };

    const accountOf = async (service: ProvisionedService) => {
      const row = await prisma.service.findUniqueOrThrow({
        where: { id: service.id },
        include: { client: { include: { serviceAccountUser: true } } },
      });
      return row.client!.serviceAccountUser!.id;
    };

    const runId = generateUniqueId();
    const entityType = `SvcScope${runId}`;
    const entityId = `svc-scope-${runId}`;
    const userEmail = `test-svc-scope-${runId}@example.com`;
    const slugs: string[] = [];

    let reader: ProvisionedService;
    let writer: ProvisionedService;
    let readerToken: string;
    let writerToken: string;
    let org1: string;
    let org2: string;
    let userId: string;
    const ids: Record<string, string> = {};

    const insert = async (
      key: string,
      source: string,
      writerUserId: string,
      organizationId: string | null,
      metadata: Record<string, unknown>
    ) => {
      const entry = await prisma.auditLogEntry.create({
        data: {
          source,
          organizationId,
          userId,
          userEmail,
          action: "CREATE",
          entityType,
          entityId,
          entityName: `needle-${runId}`,
          metadata: metadata as object,
          writerUserId,
        },
      });
      ids[key] = entry.id;
    };

    const list = async (token: string, params: Record<string, string> = {}) => {
      const response = await api.get(`${BASE_URL}/entries`, {
        ...auth(token),
        params: { "filter[entityType]": entityType, ...params },
      });
      return {
        status: response.status,
        ids: ((response.data?.data ?? []) as { id: string }[])
          .map((e) => e.id)
          .sort(),
      };
    };

    const idsOf = (...keys: string[]) => keys.map((k) => ids[k]).sort();

    beforeAll(async () => {
      reader = await provisionService({ access: { roles: ["audit_reader"] } });
      writer = await provisionService({ access: { roles: ["audit_writer"] } });
      slugs.push(reader.slug, writer.slug);
      readerToken = await clientToken(reader);
      writerToken = await clientToken(writer);
      org1 = await ensureTestOrganization(`svc-scope-1-${runId}`);
      org2 = await ensureTestOrganization(`svc-scope-2-${runId}`);
      userId = await ensureTestUser(
        `00000000-0000-7001-8000-${runId.slice(0, 12).padStart(12, "0")}`
      );

      const readerAccount = await accountOf(reader);
      const writerAccount = await accountOf(writer);
      await insert("own1", reader.slug, readerAccount, org1, { ownKey: "x" });
      await insert("own2", reader.slug, readerAccount, org2, { ownKey: "x" });
      await insert("ownSystem", reader.slug, readerAccount, null, {
        ownKey: "x",
      });
      // Same source, written by someone else: not the service's own.
      await insert("forged", reader.slug, userId, org1, { forgedKey: "x" });
      await insert("other", writer.slug, writerAccount, org1, {
        otherKey: "x",
      });
    });

    afterAll(async () => {
      await prisma.auditLogEntry.deleteMany({ where: { userEmail } });
      await removeServices(slugs);
      await cleanupIntegrations();
    });

    it("lists its own entries across every organization and system-wide", async () => {
      const result = await list(readerToken);
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual(idsOf("own1", "own2", "ownSystem"));
    });

    it("narrows to one organization, or to system-wide entries", async () => {
      expect(
        (await list(readerToken, { "filter[organizationId]": org1 })).ids
      ).toEqual(idsOf("own1"));
      expect(
        (await list(readerToken, { "filter[organizationId]": "none" })).ids
      ).toEqual(idsOf("ownSystem"));
    });

    it("intersects filter[source] with its own: another source is an empty page", async () => {
      const other = await list(readerToken, { "filter[source]": writer.slug });
      expect(other.status).toBe(HTTP_STATUS.OK);
      expect(other.ids).toEqual([]);
      expect(
        (await list(readerToken, { "filter[source]": reader.slug })).ids
      ).toEqual(idsOf("own1", "own2", "ownSystem"));
    });

    it("scopes a text search", async () => {
      const result = await list(readerToken, {
        "filter[q]": `needle-${runId}`,
      });
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual(idsOf("own1", "own2", "ownSystem"));
    });

    it("scopes facets", async () => {
      const response = await api.get(`${BASE_URL}/entries/facets`, {
        ...auth(readerToken),
      });
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.sources).toEqual([reader.slug]);
      expect(response.data.metadataKeys).toContain("ownKey");
      expect(response.data.metadataKeys).not.toContain("otherKey");
      expect(response.data.metadataKeys).not.toContain("forgedKey");
    });

    it("lets an audit_writer service read its own entries", async () => {
      const result = await list(writerToken);
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual(idsOf("other"));
    });

    it("refuses a service with neither role", async () => {
      const bare = await provisionService();
      slugs.push(bare.slug);
      const result = await list(await clientToken(bare));
      expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("still refuses an integration without an organization", async () => {
      const adminToken = await getTestPrincipalToken({
        permissions: ["integrations.read", "integrations.write"],
      });
      const integration = await createIntegration(adminToken);
      await grant(integration, ["audit-logs.read"]);
      const result = await list(await integrationToken(integration));
      expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });
});
