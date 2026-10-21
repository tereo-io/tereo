import { ensureTestUser, getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import crypto from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  cleanupTestEntities,
  generateUniqueId,
} from "./utils/test-helpers.js";

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

  describe("POST /v1/entries", () => {
    it("should create an audit log entry", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          userEmail: "test@example.com",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
          entityName: `Test Order ${uniqueId}`,
          metadata: { testKey: "testValue" },
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.id).toBeDefined();
      expect(response.data.source).toBe("test-service");
      expect(response.data.action).toBe("CREATE");
      expect(response.data.entityType).toBe("Order");
      expect(response.data.entityId).toBe(`order-${uniqueId}`);
      expect(response.data.userId).toBe("00000000-0000-7001-8000-000000000001");
      expect(response.data.userEmail).toBe("test@example.com");
    });

    it("should create an entry with changes", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "UPDATE",
          entityType: "Product",
          entityId: `product-${uniqueId}`,
          changes: {
            name: { old: "Old Name", new: "New Name" },
            price: { old: 10.99, new: 12.99 },
          },
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.changes).toEqual({
        name: { old: "Old Name", new: "New Name" },
        price: { old: 10.99, new: 12.99 },
      });
    });

    it("should create an entry with ipAddress and correlationId", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
          ipAddress: "192.168.1.100",
          correlationId: `corr-${uniqueId}`,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.ipAddress).toBe("192.168.1.100");
      expect(response.data.correlationId).toBe(`corr-${uniqueId}`);
    });

    it("should return 401 without auth token", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
        },
        { validateStatus: () => true }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 403 with read-only permissions", async () => {
      const readOnlyToken = await getTestPrincipalToken({
        organizationId: "00000000-0000-7002-8000-000000000001",
        permissions: ["audit-logs.read"],
      });

      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
        },
        {
          headers: { Authorization: `Bearer ${readOnlyToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("should return 400 for a user that does not exist", async () => {
      const response = await createEntry({ userId: crypto.randomUUID() }).catch(
        (e) => e.response
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("unknown_user");
    });

    // The variant nibble (first of the fourth group) is outside 8-b: not an
    // RFC 4122 uuid, but an id Postgres takes, so it is looked up, not refused.
    it("should look up a user id whose variant is outside RFC 4122", async () => {
      const response = await createEntry({
        userId: "12345678-1234-1234-1234-123456789abc",
      }).catch((e) => e.response);
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("unknown_user");
    });

    it("should return 400 for an organization that does not exist", async () => {
      const response = await createEntry({
        organizationId: crypto.randomUUID(),
      }).catch((e) => e.response);
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("unknown_organization");
    });

    it("should return 400 for invalid body", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        { source: "test-service" },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("caps entityId at the 500 characters entity history can look up", async () => {
      const longest = `order-${generateUniqueId()}`.padEnd(500, "x");
      const accepted = await createEntry({ entityId: longest });
      expect(accepted.status).toBe(HTTP_STATUS.CREATED);

      const history = await axios.get(
        `${BASE_URL}/entries/entity/Order/${longest}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(history.data.data.map((e: { id: string }) => e.id)).toEqual([
        accepted.data.id,
      ]);

      const rejected = await createEntry({ entityId: `${longest}x` }).catch(
        (err) => err.response
      );
      expect(rejected.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("POST /v1/entries/batch", () => {
    it("should create multiple entries in batch", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: `order-${uniqueId}-1`,
            },
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "UPDATE",
              entityType: "Order",
              entityId: `order-${uniqueId}-2`,
            },
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "DELETE",
              entityType: "Order",
              entityId: `order-${uniqueId}-3`,
            },
          ],
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.created).toBe(3);
    });

    it("should create batch entries with ipAddress and correlationId", async () => {
      const uniqueId = generateUniqueId();
      const correlationId = `batch-corr-${uniqueId}`;

      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: `order-${uniqueId}-1`,
              ipAddress: "10.0.0.1",
              correlationId,
            },
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "UPDATE",
              entityType: "Order",
              entityId: `order-${uniqueId}-2`,
              ipAddress: "10.0.0.2",
              correlationId,
            },
          ],
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.created).toBe(2);

      // Verify they're retrievable with correlationId filter
      const listResponse = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[correlationId]": correlationId },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(listResponse.status).toBe(HTTP_STATUS.OK);
      expect(listResponse.data.data).toHaveLength(2);
      expect(listResponse.data.data[0].correlationId).toBe(correlationId);
    });

    it("should return 401 without auth token", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [
            {
              source: "test-service",
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: "order-1",
            },
          ],
        },
        { validateStatus: () => true }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 400 for empty entries array", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        { entries: [] },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 400 for invalid entry in batch", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [
            {
              source: "test-service",
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: "order-1",
            },
            {
              // Missing required fields
              source: "test-service",
            },
          ],
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("GET /v1/entries", () => {
    it("should list entries with cursor pagination", async () => {
      const uniqueId = generateUniqueId();

      for (let i = 0; i < 3; i++) {
        await createEntry({
          entityType: "Product",
          entityId: `product-${uniqueId}-${i}`,
        });
      }

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: { limit: 2, "filter[entityType]": "Product" },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data).toHaveLength(2);
      expect(response.data.hasMore).toBe(true);
      expect(response.data.nextCursor).toBeTruthy();
      expect(response.data.limit).toBe(2);
    });

    it("should advance to the next page via nextCursor", async () => {
      const uniqueId = generateUniqueId();
      const source = `test-cursor-${uniqueId}`;

      for (let i = 0; i < 3; i++) {
        await createEntry({
          source,
          entityId: `order-${uniqueId}-${i}`,
        });
      }

      const page1 = await axios.get(`${BASE_URL}/entries`, {
        params: { limit: 2, "filter[source]": source },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(page1.status).toBe(HTTP_STATUS.OK);
      expect(page1.data.data).toHaveLength(2);
      expect(page1.data.hasMore).toBe(true);
      expect(page1.data.nextCursor).toBeTruthy();

      const page2 = await axios.get(`${BASE_URL}/entries`, {
        params: {
          limit: 2,
          "filter[source]": source,
          cursor: page1.data.nextCursor,
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(page2.status).toBe(HTTP_STATUS.OK);
      expect(page2.data.data).toHaveLength(1);
      expect(page2.data.hasMore).toBe(false);
      expect(page2.data.nextCursor).toBeNull();

      // Make sure cursor advances — no overlap between pages
      const page1Ids = page1.data.data.map((e: { id: string }) => e.id);
      const page2Ids = page2.data.data.map((e: { id: string }) => e.id);
      for (const id of page2Ids) expect(page1Ids).not.toContain(id);
    });

    it("should reject a tampered cursor with 400 invalid_cursor", async () => {
      const response = await axios.get(`${BASE_URL}/entries`, {
        params: { limit: 2, cursor: "bogus.tampered" },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should sort by createdAt ascending", async () => {
      const uniqueId = generateUniqueId();
      const source = `test-sort-${uniqueId}`;

      for (let i = 0; i < 3; i++) {
        await createEntry({
          source,
          entityId: `order-${uniqueId}-${i}`,
          entityName: `Order ${i}`,
        });
      }

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[source]": source,
          sort: "createdAt",
          sortDir: "asc",
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      const dates = response.data.data.map((e: { createdAt: string }) =>
        new Date(e.createdAt).getTime()
      );
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1]);
      }
    });

    it("should filter by source", async () => {
      const uniqueId = generateUniqueId();
      const source = `test-source-${uniqueId}`;

      await createEntry({ source, entityId: `order-${uniqueId}` });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[source]": source },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBeGreaterThanOrEqual(1);
      expect(
        response.data.data.every((e: { source: string }) => e.source === source)
      ).toBe(true);
    });

    it("should filter by action", async () => {
      const uniqueId = generateUniqueId();

      await createEntry({
        action: "DELETE",
        entityType: "DeletedEntity",
        entityId: `deleted-${uniqueId}`,
      });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[action]": "DELETE",
          "filter[entityType]": "DeletedEntity",
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(
        response.data.data.every(
          (e: { action: string }) => e.action === "DELETE"
        )
      ).toBe(true);
    });

    it("should filter by action with in operator", async () => {
      const uniqueId = generateUniqueId();
      const source = `test-in-${uniqueId}`;

      await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [
            {
              source,
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: `order-${uniqueId}-1`,
            },
            {
              source,
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "UPDATE",
              entityType: "Order",
              entityId: `order-${uniqueId}-2`,
            },
            {
              source,
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "DELETE",
              entityType: "Order",
              entityId: `order-${uniqueId}-3`,
            },
          ],
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[source]": source,
          "filter[action]": "CREATE,UPDATE",
          "filter[action_op]": "in",
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data).toHaveLength(2);
      expect(
        response.data.data.every(
          (e: { action: string }) =>
            e.action === "CREATE" || e.action === "UPDATE"
        )
      ).toBe(true);
    });

    it("should filter by userId", async () => {
      const uniqueId = generateUniqueId();
      const userId = await ensureTestUser(crypto.randomUUID());

      await createEntry({ userId, entityId: `order-${uniqueId}` });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[userId]": userId },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBeGreaterThanOrEqual(1);
      expect(
        response.data.data.every((e: { userId: string }) => e.userId === userId)
      ).toBe(true);
    });

    it("should filter by entityType and entityId", async () => {
      const uniqueId = generateUniqueId();
      const entityId = `product-${uniqueId}`;

      await createEntry({ entityType: "Product", entityId });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[entityType]": "Product",
          "filter[entityId]": entityId,
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBe(1);
      expect(response.data.data[0].entityId).toBe(entityId);
    });

    it("should filter by entityName with contains", async () => {
      const uniqueId = generateUniqueId();
      const entityName = `Special Widget ${uniqueId}`;

      await createEntry({
        entityType: "Product",
        entityId: `product-${uniqueId}`,
        entityName,
      });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[entityName]": `Widget ${uniqueId}`,
          "filter[entityName_op]": "contains",
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBeGreaterThanOrEqual(1);
      expect(response.data.data[0].entityName).toBe(entityName);
    });

    it("should filter by ipAddress", async () => {
      const uniqueId = generateUniqueId();
      const ipAddress = "203.0.113.42";

      await createEntry({
        entityId: `order-${uniqueId}`,
        ipAddress,
      });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[ipAddress]": ipAddress },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBeGreaterThanOrEqual(1);
      expect(response.data.data[0].ipAddress).toBe(ipAddress);
    });

    it("should filter by correlationId", async () => {
      const uniqueId = generateUniqueId();
      const correlationId = `corr-${uniqueId}`;

      await createEntry({
        entityId: `order-${uniqueId}`,
        correlationId,
      });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[correlationId]": correlationId },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBe(1);
      expect(response.data.data[0].correlationId).toBe(correlationId);
    });

    it("should filter by createdAt with gte and lte", async () => {
      const uniqueId = generateUniqueId();
      const source = `test-date-${uniqueId}`;
      const now = new Date();

      await createEntry({ source, entityId: `order-${uniqueId}` });

      const from = new Date(now.getTime() - 60000).toISOString();

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[source]": source,
          "filter[createdAt]": from,
          "filter[createdAt_op]": "gte",
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBeGreaterThanOrEqual(1);
    });

    it("should return 401 without auth token", async () => {
      const response = await axios.get(`${BASE_URL}/entries`, {
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

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

    it("should return 401 without auth token", async () => {
      const response = await axios.get(
        `${BASE_URL}/entries/entity/Order/order-1`,
        { validateStatus: () => true }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

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

  describe("Idempotency", () => {
    const entryBody = (entityId: string) => ({
      source: "test-service",
      organizationId,
      userId: "00000000-0000-7001-8000-000000000001",
      action: "CREATE",
      entityType: "Order",
      entityId,
    });

    const post = (path: string, body: Record<string, unknown>) =>
      axios.post(`${BASE_URL}/entries${path}`, body, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

    it("replays the stored entry for the same key and body", async () => {
      const uniqueId = generateUniqueId();
      const body = {
        ...entryBody(`order-${uniqueId}`),
        idempotencyKey: `idem-${uniqueId}`,
      };

      const first = await post("", body);
      expect(first.status).toBe(HTTP_STATUS.CREATED);

      // Key order doesn't matter: the body is compared as canonical JSON.
      const reordered = Object.fromEntries(Object.entries(body).reverse());
      const second = await post("", reordered);
      expect(second.status).toBe(HTTP_STATUS.CREATED);
      expect(second.data).toEqual(first.data);
    });

    it("refuses the same key with a different body", async () => {
      const uniqueId = generateUniqueId();
      const idempotencyKey = `idem-${uniqueId}`;

      const first = await post("", {
        ...entryBody(`order-${uniqueId}`),
        idempotencyKey,
      });
      expect(first.status).toBe(HTTP_STATUS.CREATED);

      const second = await post("", {
        ...entryBody(`order-${uniqueId}-different`),
        idempotencyKey,
      });
      expect(second.status).toBe(422);
      expect(second.data.error).toBe("idempotency_key_conflict");
    });

    it("replays a batch for the same key and body, and refuses a different one", async () => {
      const uniqueId = generateUniqueId();
      const idempotencyKey = `idem-batch-${uniqueId}`;
      const body = {
        entries: [entryBody(`order-${uniqueId}-1`)],
        idempotencyKey,
      };

      const first = await post("/batch", body);
      expect(first.status).toBe(HTTP_STATUS.CREATED);
      expect(first.data.created).toBe(1);

      const replay = await post("/batch", body);
      expect(replay.status).toBe(HTTP_STATUS.CREATED);
      expect(replay.data).toEqual(first.data);

      const different = await post("/batch", {
        entries: [
          entryBody(`order-${uniqueId}-2`),
          entryBody(`order-${uniqueId}-3`),
        ],
        idempotencyKey,
      });
      expect(different.status).toBe(422);
      expect(different.data.error).toBe("idempotency_key_conflict");

      const history = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[entityId]": `order-${uniqueId}-1` },
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(history.data.data).toHaveLength(1);
    });

    it("keeps one key's single and batch writes apart", async () => {
      const uniqueId = generateUniqueId();
      const idempotencyKey = `idem-both-${uniqueId}`;

      const single = await post("", {
        ...entryBody(`order-${uniqueId}-a`),
        idempotencyKey,
      });
      expect(single.status).toBe(HTTP_STATUS.CREATED);
      expect(single.data.id).toBeDefined();

      const batch = await post("/batch", {
        entries: [entryBody(`order-${uniqueId}-b`)],
        idempotencyKey,
      });
      expect(batch.status).toBe(HTTP_STATUS.CREATED);
      expect(batch.data).toEqual({ created: 1 });

      const singleAgain = await post("", {
        ...entryBody(`order-${uniqueId}-a`),
        idempotencyKey,
      });
      expect(singleAgain.data).toEqual(single.data);
    });

    it("should create independently without idempotencyKey", async () => {
      const uniqueId = generateUniqueId();

      const first = await createEntry({ entityId: `order-${uniqueId}-1` });
      const second = await createEntry({ entityId: `order-${uniqueId}-2` });

      expect(first.data.id).not.toBe(second.data.id);
    });
  });

  describe("Auth enforcement", () => {
    it("should return 403 for insufficient permissions on read", async () => {
      const noPermsToken = await getTestPrincipalToken({
        organizationId: "00000000-0000-7002-8000-000000000001",
        permissions: ["other.read"],
      });

      const response = await axios.get(`${BASE_URL}/entries`, {
        headers: { Authorization: `Bearer ${noPermsToken}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

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

    it("should return 403 for insufficient permissions on write", async () => {
      const noPermsToken = await getTestPrincipalToken({
        organizationId: "00000000-0000-7002-8000-000000000001",
        permissions: ["other.read"],
      });

      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
        },
        {
          headers: { Authorization: `Bearer ${noPermsToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
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

  // ── Batch boundary validation ──────────────────────────────────────────

  describe("Batch boundary validation", () => {
    it("should reject batch exceeding 1000 entries", async () => {
      const entries = Array.from({ length: 1001 }, (_, i) => ({
        source: "test-service",
        organizationId,
        userId: "00000000-0000-7001-8000-000000000001",
        action: "CREATE" as const,
        entityType: "Order",
        entityId: `order-batch-limit-${i}`,
      }));

      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        { entries },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should accept batch of exactly 1000 entries", async () => {
      const uniqueId = generateUniqueId();
      const entries = Array.from({ length: 1000 }, (_, i) => ({
        source: "test-service",
        organizationId,
        userId: "00000000-0000-7001-8000-000000000001",
        action: "CREATE" as const,
        entityType: "BatchBoundary",
        entityId: `order-${uniqueId}-${i}`,
      }));

      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        { entries },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.created).toBe(1000);
    });
  });

  // ── Pagination limits ─────────────────────────────────────────────────

  describe("Pagination limits", () => {
    it("rejects a limit over maxLimit of 200", async () => {
      const get = (limit: number) =>
        axios.get(`${BASE_URL}/entries`, {
          params: { limit },
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        });

      const over = await get(201);
      expect(over.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(over.data.error).toBe("invalid_request");

      const atMax = await get(200);
      expect(atMax.status).toBe(HTTP_STATUS.OK);
      expect(atMax.data.limit).toBe(200);
    });

    it("should return hasMore: false when all results fit", async () => {
      const uniqueId = generateUniqueId();
      const source = `test-nomore-${uniqueId}`;

      await createEntry({ source, entityId: `order-${uniqueId}-1` });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[source]": source, limit: 50 },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data).toHaveLength(1);
      expect(response.data.hasMore).toBe(false);
    });
  });

  // ── Filter operators ──────────────────────────────────────────────────

  describe("Filter operators", () => {
    it("should filter by createdAt with lte operator", async () => {
      const uniqueId = generateUniqueId();
      const source = `test-lte-${uniqueId}`;

      await createEntry({ source, entityId: `order-${uniqueId}` });

      const future = new Date(Date.now() + 60000).toISOString();

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[source]": source,
          "filter[createdAt]": future,
          "filter[createdAt_op]": "lte",
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBeGreaterThanOrEqual(1);
    });

    it("should filter by source with in operator", async () => {
      const uniqueId = generateUniqueId();
      const source1 = `test-in-a-${uniqueId}`;
      const source2 = `test-in-b-${uniqueId}`;

      await createEntry({ source: source1, entityId: `order-${uniqueId}-1` });
      await createEntry({ source: source2, entityId: `order-${uniqueId}-2` });
      await createEntry({
        source: `test-in-c-${uniqueId}`,
        entityId: `order-${uniqueId}-3`,
      });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[source]": `${source1},${source2}`,
          "filter[source_op]": "in",
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data).toHaveLength(2);
      const sources = response.data.data.map(
        (e: { source: string }) => e.source
      );
      expect(sources).toContain(source1);
      expect(sources).toContain(source2);
    });

    it("should filter by entityName with equals operator", async () => {
      const uniqueId = generateUniqueId();
      const entityName = `Exact Match ${uniqueId}`;

      await createEntry({
        entityType: "Product",
        entityId: `product-${uniqueId}`,
        entityName,
      });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[entityName]": entityName,
          "filter[entityName_op]": "equals",
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBe(1);
      expect(response.data.data[0].entityName).toBe(entityName);
    });
  });

  // ── Validation edge cases ─────────────────────────────────────────────

  describe("Validation edge cases", () => {
    it("should return 400 for invalid action enum value", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "DESTROY",
          entityType: "Order",
          entityId: "order-1",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should accept entry with null organizationId", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId: null,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.organizationId).toBeNull();
    });

    it("should accept entry with omitted organizationId", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.organizationId).toBeNull();
    });
  });

  // ── Metadata round-trip ───────────────────────────────────────────────

  describe("Metadata round-trip", () => {
    it("should preserve complex nested metadata", async () => {
      const uniqueId = generateUniqueId();
      const metadata = {
        requestId: `req-${uniqueId}`,
        nested: { deep: { value: 42 } },
        tags: ["important", "automated"],
        count: 99,
        flag: true,
        empty: null,
      };

      const createResponse = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
          metadata,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(createResponse.status).toBe(HTTP_STATUS.CREATED);

      const getResponse = await axios.get(
        `${BASE_URL}/entries/${createResponse.data.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(getResponse.status).toBe(HTTP_STATUS.OK);
      expect(getResponse.data.metadata).toEqual(metadata);
    });
  });

  // ── IPv6 address handling ─────────────────────────────────────────────

  describe("IPv6 address handling", () => {
    it("should store and retrieve IPv6 addresses", async () => {
      const uniqueId = generateUniqueId();
      const ipAddress = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";

      const createResponse = await createEntry({
        entityId: `order-${uniqueId}`,
        ipAddress,
      });

      expect(createResponse.data.ipAddress).toBe(ipAddress);

      // Verify via filter
      const listResponse = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[ipAddress]": ipAddress },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(listResponse.status).toBe(HTTP_STATUS.OK);
      expect(listResponse.data.data.length).toBeGreaterThanOrEqual(1);
      expect(listResponse.data.data[0].ipAddress).toBe(ipAddress);
    });
  });

  // ── Entity history pagination ───────────────────────────────────────

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

  // ── Idempotency edge cases ──────────────────────────────────────────

  describe("Idempotency edge cases", () => {
    it("should allow retry with same idempotencyKey after the first request's key is released", async () => {
      const uniqueId = generateUniqueId();
      const idempotencyKey = `retry-${uniqueId}`;

      // First request succeeds normally
      const first = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
          idempotencyKey,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(first.status).toBe(HTTP_STATUS.CREATED);

      // Second request with same key returns cached result
      const second = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
          idempotencyKey,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(second.status).toBe(HTTP_STATUS.CREATED);
      expect(second.data.id).toBe(first.data.id);
    });

    it("should handle concurrent requests with same idempotencyKey", async () => {
      const uniqueId = generateUniqueId();
      const idempotencyKey = `concurrent-${uniqueId}`;

      const makeRequest = () =>
        axios.post(
          `${BASE_URL}/entries`,
          {
            source: "test-service",
            organizationId,
            userId: "00000000-0000-7001-8000-000000000001",
            action: "CREATE",
            entityType: "Order",
            entityId: `order-${uniqueId}`,
            idempotencyKey,
          },
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

      // Fire two requests concurrently
      const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);

      // One should succeed with 201, the other either returns cached 201 or 409
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toSatisfy(
        (s: number[]) =>
          // Both 201 (one cached, one created) or one 201 + one 409
          (s[0] === HTTP_STATUS.CREATED && s[1] === HTTP_STATUS.CREATED) ||
          (s[0] === HTTP_STATUS.CREATED && s[1] === HTTP_STATUS.CONFLICT)
      );
    });

    it("should not leave idempotencyKey as pending on batch with invalid entry (validation failure)", async () => {
      const uniqueId = generateUniqueId();
      const idempotencyKey = `batch-fail-${uniqueId}`;

      // Send an invalid batch (missing required fields in one entry)
      const badBatch = await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [{ source: "test-service" }],
          idempotencyKey,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      // Validation happens before idempotency claim, so key is not consumed
      expect(badBatch.status).toBe(HTTP_STATUS.BAD_REQUEST);

      // Now a valid request with the same key should succeed (not 409)
      const goodBatch = await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: `order-${uniqueId}`,
            },
          ],
          idempotencyKey,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(goodBatch.status).toBe(HTTP_STATUS.CREATED);
      expect(goodBatch.data.created).toBe(1);
    });
  });

  // ── Correlation ID edge cases ───────────────────────────────────────

  describe("Correlation ID edge cases", () => {
    it("should normalize empty string correlationId to null", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
          correlationId: "",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.correlationId).toBeNull();
    });

    it("should accept entry without correlationId", async () => {
      const uniqueId = generateUniqueId();
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.correlationId).toBeNull();
    });
  });

  // ── Identity field min-length validation ──────────────────────────────

  describe("Identity field min-length validation", () => {
    it("should return 400 for empty string source", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 400 for empty string userId", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 400 for empty string entityType", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "",
          entityId: "order-1",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 400 for empty string entityId", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  // ── IP address validation ──────────────────────────────────────────

  describe("IP address validation", () => {
    it("should accept valid IPv4 address", async () => {
      const uniqueId = generateUniqueId();
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        ipAddress: "192.168.1.1",
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.ipAddress).toBe("192.168.1.1");
    });

    it("should accept valid IPv6 address", async () => {
      const uniqueId = generateUniqueId();
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        ipAddress: "::1",
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.ipAddress).toBe("::1");
    });

    it("should return 400 for invalid IP address format", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
          ipAddress: "not-an-ip",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should accept null ipAddress", async () => {
      const uniqueId = generateUniqueId();
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        ipAddress: null,
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.ipAddress).toBeNull();
    });
  });

  // ── Batch per-entry idempotencyKey rejection ──────────────────────────

  describe("Batch per-entry idempotencyKey", () => {
    it("should reject per-entry idempotencyKey in batch creates", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: `order-${uniqueId}`,
              idempotencyKey: "per-entry-key",
            },
          ],
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      // Per-entry idempotencyKey is not part of the batch entry schema
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should accept batch-level idempotencyKey", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: `order-${uniqueId}`,
            },
          ],
          idempotencyKey: `batch-key-${uniqueId}`,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.created).toBe(1);
    });
  });

  // ── Max-length boundary strings ──────────────────────────────────────

  describe("Max-length boundary strings", () => {
    it("should accept source at exactly 100 characters", async () => {
      const uniqueId = generateUniqueId();
      const source = "a".repeat(100);

      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source,
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.source).toBe(source);
    });

    it("should reject source exceeding 100 characters", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "a".repeat(101),
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should accept entityName at exactly 500 characters", async () => {
      const uniqueId = generateUniqueId();
      const entityName = "b".repeat(500);

      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        entityName,
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.entityName).toBe(entityName);
    });

    it("should reject entityName exceeding 500 characters", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
          entityName: "b".repeat(501),
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  // ── Unicode in entityName and metadata ─────────────────────────────

  describe("Unicode support", () => {
    it("should handle unicode in entityName", async () => {
      const uniqueId = generateUniqueId();
      const entityName = `商品 ${uniqueId} — café résumé 🏷️`;

      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        entityName,
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.entityName).toBe(entityName);
    });

    it("should handle unicode in metadata keys and values", async () => {
      const uniqueId = generateUniqueId();
      const metadata = {
        商品名: "テスト商品",
        description: "Ñoño café résumé",
      };

      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        metadata,
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.metadata).toEqual(metadata);
    });
  });

  // ── entityType 'in' filter ──────────────────────────────────────────

  describe("entityType 'in' filter", () => {
    it("should filter by entityType with in operator", async () => {
      const uniqueId = generateUniqueId();
      const source = `test-entity-in-${uniqueId}`;

      await createEntry({
        source,
        entityType: "Order",
        entityId: `order-${uniqueId}`,
      });
      await createEntry({
        source,
        entityType: "Product",
        entityId: `product-${uniqueId}`,
      });
      await createEntry({
        source,
        entityType: "Shipment",
        entityId: `shipment-${uniqueId}`,
      });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[source]": source,
          "filter[entityType]": "Order,Product",
          "filter[entityType_op]": "in",
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data).toHaveLength(2);
      const entityTypes = response.data.data.map(
        (e: { entityType: string }) => e.entityType
      );
      expect(entityTypes).toContain("Order");
      expect(entityTypes).toContain("Product");
      expect(entityTypes).not.toContain("Shipment");
    });
  });

  // ── Permission hierarchy ────────────────────────────────────────────────

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

    it("should allow delete permission to write entries", async () => {
      const deleteToken = await getTestPrincipalToken({
        organizationId: "00000000-0000-7002-8000-000000000001",
        permissions: ["audit-logs.delete"],
      });
      const uniqueId = generateUniqueId();

      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
        },
        {
          headers: { Authorization: `Bearer ${deleteToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });
  });

  // ── Correlation ID filter ──────────────────────────────────────────────

  describe("Correlation ID filter", () => {
    it("should filter entries by correlationId with equals operator", async () => {
      const uniqueId = generateUniqueId();
      const source = `test-corr-filter-${uniqueId}`;
      const correlationId = `corr-${uniqueId}`;

      // Create entry with correlationId
      await createEntry({
        source,
        entityId: `order-${uniqueId}-1`,
        correlationId,
      });

      // Create entry without correlationId
      await createEntry({
        source,
        entityId: `order-${uniqueId}-2`,
      });

      // Create entry with different correlationId
      await createEntry({
        source,
        entityId: `order-${uniqueId}-3`,
        correlationId: `other-${uniqueId}`,
      });

      const response = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[source]": source,
          "filter[correlationId]": correlationId,
        },
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data).toHaveLength(1);
      expect(response.data.data[0].correlationId).toBe(correlationId);
    });
  });

  // ── Concurrent batch idempotency ───────────────────────────────────────

  describe("Concurrent batch idempotency", () => {
    it("should handle concurrent requests with same idempotencyKey on batch", async () => {
      const uniqueId = generateUniqueId();
      const idempotencyKey = `concurrent-batch-${uniqueId}`;

      const makeRequest = () =>
        axios.post(
          `${BASE_URL}/entries/batch`,
          {
            entries: [
              {
                source: "test-service",
                organizationId,
                userId: "00000000-0000-7001-8000-000000000001",
                action: "CREATE",
                entityType: "Order",
                entityId: `order-${uniqueId}`,
              },
            ],
            idempotencyKey,
          },
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

      const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toSatisfy(
        (s: number[]) =>
          // Both 201 (one cached, one created) or one 201 + one 409
          (s[0] === HTTP_STATUS.CREATED && s[1] === HTTP_STATUS.CREATED) ||
          (s[0] === HTTP_STATUS.CREATED && s[1] === HTTP_STATUS.CONFLICT)
      );
    });
  });

  // ── Idempotency key boundary tests ─────────────────────────────────────

  describe("Idempotency key boundaries", () => {
    it("should accept idempotency key at minimum length (1 character)", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
          idempotencyKey: "x",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("should accept idempotency key at maximum length (255 characters)", async () => {
      const uniqueId = generateUniqueId();
      const idempotencyKey = "k".repeat(255);
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
          idempotencyKey,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("should reject idempotency key exceeding 255 characters", async () => {
      const idempotencyKey = "k".repeat(256);
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
          idempotencyKey,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject empty string idempotency key", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
          idempotencyKey: "",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  // ── Empty correlationId normalization ──────────────────────────────────

  describe("Empty correlationId normalization", () => {
    it("should normalize empty string correlationId to null", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${uniqueId}`,
          correlationId: "",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.correlationId).toBeNull();
    });

    it("should store non-empty correlationId as-is", async () => {
      const uniqueId = generateUniqueId();
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        correlationId: `corr-${uniqueId}`,
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.correlationId).toBe(`corr-${uniqueId}`);
    });
  });

  // ── IPv4 validation strictness ─────────────────────────────────────────

  describe("IPv4 validation strictness", () => {
    it("should reject IPv4 with octets > 255", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: "order-1",
          ipAddress: "999.999.999.999",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should accept IPv4 at octet boundary (255.255.255.255)", async () => {
      const uniqueId = generateUniqueId();
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        ipAddress: "255.255.255.255",
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.ipAddress).toBe("255.255.255.255");
    });

    it("should accept IPv4 with zero octets (0.0.0.0)", async () => {
      const uniqueId = generateUniqueId();
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        ipAddress: "0.0.0.0",
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.ipAddress).toBe("0.0.0.0");
    });
  });

  // ── Invalid userEmail format ──────────────────────────────────────────

  describe("Invalid userEmail format", () => {
    it("should reject invalid email format", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${generateUniqueId()}`,
          userEmail: "not-an-email",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should accept valid email format", async () => {
      const uniqueId = generateUniqueId();
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        userEmail: "user@example.com",
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.userEmail).toBe("user@example.com");
    });

    it("should accept null userEmail", async () => {
      const uniqueId = generateUniqueId();
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        userEmail: null,
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.userEmail).toBeNull();
    });
  });

  // ── Batch with invalid IP on one entry ────────────────────────────────

  describe("Batch with invalid IP on one entry", () => {
    it("should reject entire batch when one entry has invalid ipAddress", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries/batch`,
        {
          entries: [
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: `order-${generateUniqueId()}`,
              ipAddress: "192.168.1.1",
            },
            {
              source: "test-service",
              organizationId,
              userId: "00000000-0000-7001-8000-000000000001",
              action: "CREATE",
              entityType: "Order",
              entityId: `order-${generateUniqueId()}`,
              ipAddress: "not-an-ip",
            },
          ],
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  // ── Invalid sort field ────────────────────────────────────────────────

  describe("Invalid sort field", () => {
    it("should reject unsupported sort field", async () => {
      const response = await axios.get(
        `${BASE_URL}/entries?sort=entityType&sortDir=asc`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should accept valid sort field createdAt", async () => {
      const response = await axios.get(
        `${BASE_URL}/entries?sort=createdAt&sortDir=asc`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
    });
  });

  // ── Default sort direction ────────────────────────────────────────────

  describe("Default sort direction", () => {
    it("should default to desc sort direction when not specified", async () => {
      // Create two entries with a small delay to ensure ordering
      const id1 = generateUniqueId();
      const id2 = generateUniqueId();
      await createEntry({ entityId: `order-${id1}`, entityName: "First" });
      await createEntry({ entityId: `order-${id2}`, entityName: "Second" });

      const response = await axios.get(`${BASE_URL}/entries?sort=createdAt`, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBeGreaterThanOrEqual(2);
      // Most recent should come first (desc)
      const timestamps = response.data.data.map((e: { createdAt: string }) =>
        new Date(e.createdAt).getTime()
      );
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
      }
    });
  });

  // ── correlationId boundary lengths ────────────────────────────────────

  describe("correlationId boundary lengths", () => {
    it("should accept correlationId at exactly 255 characters", async () => {
      const uniqueId = generateUniqueId();
      const longCorrelationId = "x".repeat(255);
      const response = await createEntry({
        entityId: `order-${uniqueId}`,
        correlationId: longCorrelationId,
      });

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.correlationId).toBe(longCorrelationId);
    });

    it("should reject correlationId exceeding 255 characters", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId,
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${generateUniqueId()}`,
          correlationId: "x".repeat(256),
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  // ── organizationId UUID validation ─────────────────────────────────────────

  describe("organizationId UUID validation", () => {
    it("should reject organizationId that is not a UUID", async () => {
      const response = await axios.post(
        `${BASE_URL}/entries`,
        {
          source: "test-service",
          organizationId: "not-a-uuid",
          userId: "00000000-0000-7001-8000-000000000001",
          action: "CREATE",
          entityType: "Order",
          entityId: `order-${generateUniqueId()}`,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  // ── Multi-filter queries ──────────────────────────────────────────────

  describe("Multi-filter queries", () => {
    it("should support combining source + action + createdAt filters", async () => {
      const uniqueId = generateUniqueId();
      const now = new Date();

      await createEntry({
        source: `multi-${uniqueId}`,
        action: "UPDATE",
        entityId: `order-${uniqueId}`,
      });

      const response = await axios.get(
        `${BASE_URL}/entries?filter[source]=multi-${uniqueId}&filter[action]=UPDATE&filter[createdAt_gte]=${new Date(now.getTime() - 60000).toISOString()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBe(1);
      expect(response.data.data[0].source).toBe(`multi-${uniqueId}`);
      expect(response.data.data[0].action).toBe("UPDATE");
    });
  });

  // ── Entity param validation ───────────────────────────────────────────

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
    });

    it("should reject entityId exceeding 500 chars in URL", async () => {
      const longId = "x".repeat(501);
      const response = await axios.get(
        `${BASE_URL}/entries/entity/Order/${longId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });
});
