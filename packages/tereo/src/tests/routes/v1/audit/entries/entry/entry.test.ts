// @module-tag int
// @module-tag audit
import { cleanup as cleanupIntegrations } from "../../../../../support/integrations.js";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import axios from "axios";
import {
  provisionService,
  removeServices,
  type ProvisionedService,
} from "../../../../../support/provisioning.js";
import {
  ensureTestUser,
  getTestPrincipalToken,
  ensureTestOrganization,
} from "../../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  cleanupTestEntities,
  generateUniqueId,
} from "../../../../../support/audit.js";

describe("GET /v1/audit/entries/:id", () => {
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

    describe("GET /v1/entries/:id", () => {
      it("should return a single entry by id", async () => {
        const uniqueId = generateUniqueId();

        const createResponse = await createEntry({
          entityId: `order-${uniqueId}`,
          entityName: `Order ${uniqueId}`,
        });

        const entryId = createResponse.data.id;

        const response = await axios.get(`${BASE_URL}/entries/${entryId}`, {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.id).toBe(entryId);
        expect(response.data.source).toBe("test-service");
        expect(response.data.entityName).toBe(`Order ${uniqueId}`);
      });

      it("should return 404 for non-existent entry", async () => {
        const response = await axios.get(
          `${BASE_URL}/entries/00000000-0000-0000-0000-000000000000`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("should return 404 for an entry id whose variant is outside RFC 4122", async () => {
        const response = await axios.get(
          `${BASE_URL}/entries/12345678-1234-1234-1234-123456789abc`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("should return 400 for invalid UUID format", async () => {
        const response = await axios.get(`${BASE_URL}/entries/not-a-uuid`, {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("should return 401 without auth token", async () => {
        const response = await axios.get(
          `${BASE_URL}/entries/00000000-0000-0000-0000-000000000000`,
          { validateStatus: () => true }
        );

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      });
    });

    describe("DELETE /v1/entries/:id", () => {
      // The by-id delete endpoint was intentionally removed: an audit log must be
      // tamper-evident, so individual entries are never removable via the API.
      // Lifecycle is partition-based retention only.
      it("should not exist (audit entries are immutable)", async () => {
        const createResponse = await createEntry();
        const entryId = createResponse.data.id;

        const deleteResponse = await axios.delete(
          `${BASE_URL}/entries/${entryId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(deleteResponse.status).toBe(HTTP_STATUS.NOT_FOUND);

        // Entry is still there.
        const getResponse = await axios.get(`${BASE_URL}/entries/${entryId}`, {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        });
        expect(getResponse.status).toBe(HTTP_STATUS.OK);
      });
    });

    describe("Tenant scoping", () => {
      it("should scope get-by-id by organizationId from token", async () => {
        const uniqueId = generateUniqueId();

        // Create entry for org-2
        const org2Token = await getTestAccessToken(
          "00000000-0000-7001-8000-000000000002",
          "00000000-0000-7002-8000-000000000002"
        );
        const createResponse = await axios.post(
          `${BASE_URL}/entries`,
          {
            source: "test-service",
            organizationId: "00000000-0000-7002-8000-000000000002",
            userId: "00000000-0000-7001-8000-000000000002",
            action: "CREATE",
            entityType: "Order",
            entityId: `order-${uniqueId}`,
          },
          { headers: { Authorization: `Bearer ${org2Token}` } }
        );

        const entryId = createResponse.data.id;

        // org-1 should NOT see org-2's entry
        const response = await axios.get(`${BASE_URL}/entries/${entryId}`, {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("should scope delete by organizationId from token", async () => {
        const uniqueId = generateUniqueId();

        // Create entry for org-2
        const org2Token = await getTestAccessToken(
          "00000000-0000-7001-8000-000000000002",
          "00000000-0000-7002-8000-000000000002"
        );
        const createResponse = await axios.post(
          `${BASE_URL}/entries`,
          {
            source: "test-service",
            organizationId: "00000000-0000-7002-8000-000000000002",
            userId: "00000000-0000-7001-8000-000000000002",
            action: "CREATE",
            entityType: "Order",
            entityId: `order-${uniqueId}`,
          },
          { headers: { Authorization: `Bearer ${org2Token}` } }
        );

        const entryId = createResponse.data.id;

        // org-1 should NOT be able to delete org-2's entry
        const response = await axios.delete(`${BASE_URL}/entries/${entryId}`, {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
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

    beforeAll(async () => {
      org1Admin = await getTestAccessToken(USER_1, ORG_1);
      const org2Admin = await getTestAccessToken(USER_2, ORG_2);
      org1Reader = await getTestPrincipalToken({
        organizationId: ORG_1,
        permissions: ["audit-logs.read"],
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

    describe("GET /entries/:id", () => {
      it("returns 404 for another organization's entry without a filter", async () => {
        const res = await axios.get(
          `${BASE_URL}/entries/${ids.org2}`,
          auth(org1Admin)
        );
        expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("lets audit-logs.admin read it with the filter", async () => {
        const res = await axios.get(`${BASE_URL}/entries/${ids.org2}`, {
          params: { "filter[organizationId]": ORG_2 },
          ...auth(org1Admin),
        });
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.organization).toMatchObject({ id: ORG_2 });
        expect(res.data.user).toMatchObject({ id: USER_2 });
      });

      it('lets audit-logs.admin read a system-wide entry with "none"', async () => {
        const res = await axios.get(`${BASE_URL}/entries/${ids.systemWide}`, {
          params: { "filter[organizationId]": "none" },
          ...auth(org1Admin),
        });
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.organizationId).toBeNull();
      });

      it("refuses a non-admin naming another organization", async () => {
        const res = await axios.get(`${BASE_URL}/entries/${ids.org2}`, {
          params: { "filter[organizationId]": ORG_2 },
          ...auth(org1Reader),
        });
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

    beforeAll(async () => {
      reader = await provisionService({ access: { roles: ["audit_reader"] } });
      writer = await provisionService({ access: { roles: ["audit_writer"] } });
      slugs.push(reader.slug, writer.slug);
      readerToken = await clientToken(reader);
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

    it("reads its own entry by id, and 404s another's", async () => {
      const own = await api.get(`${BASE_URL}/entries/${ids.own2}`, {
        ...auth(readerToken),
      });
      expect(own.status).toBe(HTTP_STATUS.OK);
      expect(own.data.id).toBe(ids.own2);
      for (const key of ["other", "forged"]) {
        const response = await api.get(`${BASE_URL}/entries/${ids[key]}`, {
          ...auth(readerToken),
        });
        expect(response.status, key).toBe(HTTP_STATUS.NOT_FOUND);
      }
    });
  });
});
