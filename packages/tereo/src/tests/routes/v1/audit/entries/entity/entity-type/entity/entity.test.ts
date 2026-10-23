// @module-tag int
// @module-tag audit
import { cleanup as cleanupIntegrations } from "../../../../../../../support/integrations.js";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { tokenFor } from "../../../../../../../support/clientToken.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  provisionService,
  removeServices,
  type ProvisionedService,
} from "../../../../../../../support/provisioning.js";
import {
  ensureTestUser,
  getTestPrincipalToken,
  ensureTestOrganization,
} from "../../../../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  cleanupTestEntities,
  generateUniqueId,
} from "../../../../../../../support/audit.js";

describe("GET /v1/audit/entries/entity/:entityType/:entityId", () => {
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

    describe("GET /v1/entries/entity/:entityType/:entityId", () => {
      it("should return entity change history", async () => {
        const uniqueId = generateUniqueId();
        const entityType = "Product";
        const entityId = `product-${uniqueId}`;

        await createEntry({ entityType, entityId, action: "CREATE" });
        await createEntry({
          entityType,
          entityId,
          action: "UPDATE",
          changes: { name: { old: "V1", new: "V2" } },
        });

        const response = await axios.get(
          `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data).toHaveLength(2);
        expect(response.data.hasMore).toBe(false);
        expect(response.data.nextCursor).toBeNull();
        // Most recent first
        expect(response.data.data[0].action).toBe("UPDATE");
        expect(response.data.data[1].action).toBe("CREATE");
      });

      it("filters history by source and action", async () => {
        const entityType = "Product";
        const entityId = `product-${generateUniqueId()}`;
        await createEntry({ entityType, entityId, action: "CREATE" });
        await createEntry({ entityType, entityId, action: "UPDATE" });
        await createEntry({
          entityType,
          entityId,
          action: "UPDATE",
          source: "other-service",
        });

        const history = async (query: string) => {
          const response = await axios.get(
            `${BASE_URL}/entries/entity/${entityType}/${entityId}?${query}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          return response.data.data as { source: string; action: string }[];
        };

        const own = await history("filter[source]=test-service");
        expect(own).toHaveLength(2);
        expect(own.every((e) => e.source === "test-service")).toBe(true);

        const updates = await history(
          "filter[source]=test-service&filter[action]=UPDATE"
        );
        expect(updates.map((e) => e.action)).toEqual(["UPDATE"]);
      });

      it("should return empty array for non-existent entity", async () => {
        const response = await axios.get(
          `${BASE_URL}/entries/entity/NonExistent/no-such-id-${generateUniqueId()}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data).toEqual([]);
        expect(response.data.hasMore).toBe(false);
        expect(response.data.nextCursor).toBeNull();
      });
    });

    describe("Tenant scoping", () => {
      it("should scope entity history by organizationId from token", async () => {
        const uniqueId = generateUniqueId();
        const entityType = "SharedEntity";
        const entityId = `shared-${uniqueId}`;

        // Create entry for org-1
        await createEntry({ entityType, entityId });

        // Create entry for org-2 with same entityType/entityId
        const org2Token = await getTestAccessToken(
          "00000000-0000-7001-8000-000000000002",
          "00000000-0000-7002-8000-000000000002"
        );
        await axios.post(
          `${BASE_URL}/entries`,
          {
            source: "test-service",
            organizationId: "00000000-0000-7002-8000-000000000002",
            userId: "00000000-0000-7001-8000-000000000002",
            action: "UPDATE",
            entityType,
            entityId,
          },
          { headers: { Authorization: `Bearer ${org2Token}` } }
        );

        // org-1 should only see their entry
        const response = await axios.get(
          `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data).toHaveLength(1);
        expect(response.data.data[0].organizationId).toBe(organizationId);
      });
    });

    describe("Entity history pagination", () => {
      it("should paginate entity history via cursor", async () => {
        const uniqueId = generateUniqueId();
        const entityType = "PaginatedEntity";
        const entityId = `paginated-${uniqueId}`;

        // Create 5 entries for the same entity
        for (let i = 0; i < 5; i++) {
          await createEntry({
            entityType,
            entityId,
            action: "UPDATE",
            entityName: `Entry ${i}`,
          });
        }

        // Fetch first page (limit=2)
        const page1 = await axios.get(
          `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
          {
            params: { limit: 2 },
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(page1.status).toBe(HTTP_STATUS.OK);
        expect(page1.data.data).toHaveLength(2);
        expect(page1.data.hasMore).toBe(true);
        expect(page1.data.nextCursor).toBeTruthy();

        // Fetch second page using cursor from page 1
        const page2 = await axios.get(
          `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
          {
            params: { limit: 2, cursor: page1.data.nextCursor },
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(page2.status).toBe(HTTP_STATUS.OK);
        expect(page2.data.data).toHaveLength(2);
        expect(page2.data.hasMore).toBe(true);
        expect(page2.data.nextCursor).toBeTruthy();

        // Fetch third page — last partial page
        const page3 = await axios.get(
          `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
          {
            params: { limit: 2, cursor: page2.data.nextCursor },
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(page3.status).toBe(HTTP_STATUS.OK);
        expect(page3.data.data).toHaveLength(1);
        expect(page3.data.hasMore).toBe(false);
        expect(page3.data.nextCursor).toBeNull();
      });

      it("should sort entity history ascending when requested", async () => {
        const uniqueId = generateUniqueId();
        const entityType = "SortEntity";
        const entityId = `sort-${uniqueId}`;

        for (let i = 0; i < 3; i++) {
          await createEntry({ entityType, entityId, action: "UPDATE" });
        }

        const response = await axios.get(
          `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
          {
            params: { sort: "createdAt", sortDir: "asc" },
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        const dates = response.data.data.map((e: { createdAt: string }) =>
          new Date(e.createdAt).getTime()
        );
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1]);
        }
      });
    });

    describe("Entity param validation", () => {
      it("should reject entityType exceeding 100 chars in URL", async () => {
        const longType = "x".repeat(101);
        const response = await axios.get(
          `${BASE_URL}/entries/entity/${longType}/some-id`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(response.data.error).toBe("invalid_request");
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

    describe("GET /entries/entity/:entityType/:entityId", () => {
      const history = (token: string, organizationFilter?: string) =>
        axios.get(`${BASE_URL}/entries/entity/${entityType}/${entityId}`, {
          params: organizationFilter
            ? { "filter[organizationId]": organizationFilter }
            : {},
          ...auth(token),
        });

      it("scopes to the token's organization without a filter", async () => {
        const res = await history(org1Admin);
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.data.map((e: { id: string }) => e.id)).toEqual([
          ids.org1,
        ]);
        expect(res.data.data[0].user).toMatchObject({ id: USER_1 });
      });

      it("lets audit-logs.admin read another organization and system-wide", async () => {
        const org2 = await history(org1Admin, ORG_2);
        expect(org2.data.data.map((e: { id: string }) => e.id)).toEqual([
          ids.org2,
        ]);

        const systemWide = await history(org1Admin, "none");
        expect(systemWide.data.data.map((e: { id: string }) => e.id)).toEqual([
          ids.systemWide,
        ]);
      });

      it("refuses a non-admin naming another organization", async () => {
        const res = await history(org1Reader, ORG_2);
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

    const idsOf = (...keys: string[]) => keys.map((k) => ids[k]).sort();

    beforeAll(async () => {
      reader = await provisionService({ access: { roles: ["audit_reader"] } });
      writer = await provisionService({ access: { roles: ["audit_writer"] } });
      slugs.push(reader.slug, writer.slug);
      readerToken = await tokenFor(reader);
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

    it("scopes an entity's history", async () => {
      const response = await api.get(
        `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
        auth(readerToken)
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(
        (response.data.data as { id: string }[]).map((e) => e.id).sort()
      ).toEqual(idsOf("own1", "own2", "ownSystem"));
    });
  });
});
