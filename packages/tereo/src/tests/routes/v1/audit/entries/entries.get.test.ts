// @module-tag int
// @module-tag audit
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import crypto from "crypto";
import axios from "axios";
import {
  ensureTestUser,
  getTestPrincipalToken,
} from "../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  getTestUserId,
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
          response.data.data.every(
            (e: { source: string }) => e.source === source
          )
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
          response.data.data.every(
            (e: { userId: string }) => e.userId === userId
          )
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
    });

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
  });

  describe("audit contains filters", () => {
    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    const runId = generateUniqueId();
    const source = `test-wild-${runId}`;
    let token: string;

    const write = async (
      entityId: string,
      entityName: string,
      metadata: Record<string, unknown>
    ) => {
      const res = await axios.post(
        `${BASE_URL}/entries`,
        {
          source,
          organizationId: getTestOrgId(),
          userId: getTestUserId(),
          userEmail: `test-wild-${runId}@example.com`,
          action: "UPDATE",
          entityType: "Wild",
          entityId,
          entityName,
          metadata,
        },
        auth(token)
      );
      expect(res.status).toBe(201);
    };

    const list = async (params: Record<string, string>) => {
      const res = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[source]": source, ...params },
        ...auth(token),
      });
      expect(res.status).toBe(200);
      return (res.data.data as { entityId: string }[])
        .map((e) => e.entityId)
        .sort();
    };

    beforeAll(async () => {
      token = await getTestAccessToken();
      await write("underscore", `n_${runId}`, { k: `a_b${runId}` });
      await write("lookalike", `nx${runId}`, { k: `axb${runId}` });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("treats LIKE wildcards in an entityName contains filter literally", async () => {
      expect(
        await list({
          "filter[entityName]": `n_${runId}`,
          "filter[entityName_op]": "contains",
        })
      ).toEqual(["underscore"]);
    });

    it("treats LIKE wildcards in a metadata contains filter literally", async () => {
      expect(await list({ "metadata[k_contains]": `a_b${runId}` })).toEqual([
        "underscore",
      ]);
    });

    it("answers the same with filter[q] as without it", async () => {
      const params = {
        "filter[entityName]": `n_${runId}`,
        "filter[entityName_op]": "contains",
      };
      expect(await list(params)).toEqual(
        await list({ ...params, "filter[q]": runId })
      );
    });
  });

  describe("filter[q] on values that JSON escapes", () => {
    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    const runId = generateUniqueId();
    const source = `test-jsonq-${runId}`;
    let token: string;

    const list = async (q: string) => {
      const res = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[source]": source, "filter[q]": q },
        ...auth(token),
      });
      expect(res.status).toBe(200);
      return (res.data.data as { entityId: string }[]).map((e) => e.entityId);
    };

    beforeAll(async () => {
      token = await getTestAccessToken();
      const res = await axios.post(
        `${BASE_URL}/entries`,
        {
          source,
          organizationId: getTestOrgId(),
          userId: getTestUserId(),
          userEmail: `test-jsonq-${runId}@example.com`,
          action: "UPDATE",
          entityType: "JsonQ",
          entityId: "holder",
          changes: {
            comment: { old: null, new: `line one\nline two ${runId}` },
          },
          metadata: {
            path: `C:\\exports\\${runId}`,
            note: `said "approved ${runId}"`,
          },
        },
        auth(token)
      );
      expect(res.status).toBe(201);
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("finds a metadata value containing a backslash", async () => {
      expect(await list(`C:\\exports\\${runId}`)).toEqual(["holder"]);
    });

    it("finds a metadata value containing a double quote", async () => {
      expect(await list(`"approved ${runId}"`)).toEqual(["holder"]);
    });

    it("finds a changes value containing a newline", async () => {
      expect(await list(`line one\nline two ${runId}`)).toEqual(["holder"]);
    });

    it("still escapes LIKE wildcards in the JSON-escaped form", async () => {
      // Unescaped, `__` would match the stored `\\` between the two parts.
      expect(await list(`C:\\exports__${runId}`)).toEqual([]);
    });
  });

  describe("Audit query options", () => {
    const ORG_1 = "00000000-0000-7002-8000-000000000001";
    const ORG_2 = "00000000-0000-7002-8000-000000000002";
    const USER_1 = "00000000-0000-7001-8000-000000000001";
    const USER_2 = "00000000-0000-7001-8000-000000000002";
    const DAY_MS = 24 * 60 * 60 * 1000;

    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    interface Entry {
      id: string;
      writerUserId: string;
      userEmail: string | null;
    }

    const runId = generateUniqueId();
    const source = `test-query-${runId}`;
    const entityType = `QueryEntity${runId}`;
    const entityId = `query-${runId}`;
    const emailA = `test-query-${runId}-alice@example.com`;
    const emailB = `test-query-${runId}-bob@example.com`;
    // Unique per run, so a search never matches another file's entries.
    const term = `Zq${runId}`;
    const keyA = `qa_${runId}`;
    const keyB = `qb_${runId}`;
    const keyOrg2 = `qo2_${runId}`;
    const keySystem = `qsys_${runId}`;

    let org1Admin: string;
    let org1Reader: string;
    let otherWriterId: string;
    const ids = {
      byAdmin: "",
      byOtherWriter: "",
      inName: "",
      inChanges: "",
      inMetadata: "",
      org2: "",
      systemWide: "",
    };

    const write = async (token: string, body: Record<string, unknown>) => {
      const res = await axios.post(
        `${BASE_URL}/entries`,
        {
          source,
          organizationId: ORG_1,
          userId: USER_1,
          userEmail: emailA,
          action: "UPDATE",
          entityType,
          entityId,
          ...body,
        },
        auth(token)
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data as Entry;
    };

    beforeAll(async () => {
      org1Admin = await getTestAccessToken(USER_1, ORG_1);
      org1Reader = await getTestPrincipalToken({
        organizationId: ORG_1,
        permissions: ["audit-logs.read"],
      });
      const otherWriter = await getTestPrincipalToken({
        organizationId: ORG_1,
        permissions: ["audit-logs.write"],
      });
      const org2Admin = await getTestAccessToken(USER_2, ORG_2);

      ids.byAdmin = (await write(org1Admin, {})).id;
      const byOther = await write(otherWriter, { userEmail: emailB });
      ids.byOtherWriter = byOther.id;
      otherWriterId = byOther.writerUserId;

      ids.inName = (
        await write(org1Admin, {
          entityName: `Invoice ${term.toLowerCase()} draft`,
          metadata: { [keyA]: "north" },
        })
      ).id;
      ids.inChanges = (
        await write(org1Admin, {
          changes: { status: { old: "open", new: `closed by ${term}` } },
          metadata: { [keyA]: "south", [keyB]: 7 },
        })
      ).id;
      ids.inMetadata = (
        await write(org1Admin, {
          metadata: { note: `see ${term.toUpperCase()}` },
        })
      ).id;
      ids.org2 = (
        await write(org2Admin, {
          organizationId: ORG_2,
          userId: USER_2,
          entityName: term,
          metadata: { [keyOrg2]: "x" },
        })
      ).id;
      ids.systemWide = (
        await write(org1Admin, {
          organizationId: null,
          entityName: term,
          metadata: { [keySystem]: "x" },
        })
      ).id;
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const list = async (
      params: Record<string, string>,
      token: string = org1Admin
    ) => {
      const res = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[source]": source, ...params },
        ...auth(token),
      });
      return {
        status: res.status,
        error: res.data?.error as string | undefined,
        ids: res.status === 200 ? res.data.data.map((e: Entry) => e.id) : [],
        body: res.data,
      };
    };

    const history = async (params: Record<string, string>) => {
      const res = await axios.get(
        `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
        { params, ...auth(org1Admin) }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      return res.data.data.map((e: Entry) => e.id) as string[];
    };

    describe("writer and email filters", () => {
      it("filters the list by writerUserId", async () => {
        const result = await list({ "filter[writerUserId]": otherWriterId });
        expect(result.status).toBe(HTTP_STATUS.OK);
        expect(result.ids).toEqual([ids.byOtherWriter]);

        const own = await list({ "filter[writerUserId]": USER_1 });
        expect(own.ids).not.toContain(ids.byOtherWriter);
        expect(own.ids).toContain(ids.byAdmin);
      });

      it("filters the list by userEmail, exactly or by substring", async () => {
        const exact = await list({ "filter[userEmail]": emailB });
        expect(exact.ids).toEqual([ids.byOtherWriter]);

        const partial = await list({
          "filter[userEmail]": `${runId}-BOB`,
          "filter[userEmail_op]": "contains",
        });
        expect(partial.ids).toEqual([ids.byOtherWriter]);
      });

      it("filters entity history by writerUserId and userEmail", async () => {
        expect(
          await history({ "filter[writerUserId]": otherWriterId })
        ).toEqual([ids.byOtherWriter]);
        expect(await history({ "filter[userEmail]": emailB })).toEqual([
          ids.byOtherWriter,
        ]);
        const alice = await history({
          "filter[userEmail]": "alice",
          "filter[userEmail_op]": "contains",
        });
        expect(alice).not.toContain(ids.byOtherWriter);
        expect(alice).toContain(ids.byAdmin);
      });
    });

    describe("filter[q]", () => {
      it("matches entity names, changes and metadata, ignoring case", async () => {
        const result = await list({ "filter[q]": term });
        expect(result.status).toBe(HTTP_STATUS.OK);
        expect(result.ids.sort()).toEqual(
          [ids.inName, ids.inChanges, ids.inMetadata].sort()
        );
      });

      it("returns nothing when no entry matches", async () => {
        const result = await list({ "filter[q]": `${term}-absent` });
        expect(result.status).toBe(HTTP_STATUS.OK);
        expect(result.ids).toEqual([]);
        expect(result.body.hasMore).toBe(false);
      });

      it("treats LIKE wildcards literally", async () => {
        const result = await list({ "filter[q]": "%" });
        expect(result.status).toBe(HTTP_STATUS.OK);
        expect(result.ids).toEqual([]);
      });

      it("combines with the other filters", async () => {
        const inChangesOnly = await list({
          "filter[q]": term,
          [`metadata[${keyA}_equals]`]: "south",
        });
        expect(inChangesOnly.ids).toEqual([ids.inChanges]);

        const contains = await list({
          "filter[q]": term,
          [`metadata[${keyA}_contains]`]: "or",
        });
        expect(contains.ids).toEqual([ids.inName]);

        const byEmail = await list({
          "filter[q]": term,
          "filter[userEmail]": emailB,
        });
        expect(byEmail.ids).toEqual([]);
      });

      it("pages through matches with the cursor", async () => {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 3; page++) {
          const result = await list({
            "filter[q]": term,
            limit: "1",
            ...(cursor && { cursor }),
          });
          expect(result.status).toBe(HTTP_STATUS.OK);
          seen.push(...result.ids);
          expect(result.body.hasMore).toBe(page < 2);
          cursor = result.body.nextCursor ?? undefined;
        }
        expect(seen.sort()).toEqual(
          [ids.inName, ids.inChanges, ids.inMetadata].sort()
        );
      });

      it("keeps to the caller's organization", async () => {
        const own = await list({ "filter[q]": term }, org1Reader);
        expect(own.ids).not.toContain(ids.org2);
        expect(own.ids).not.toContain(ids.systemWide);

        const org2 = await list({
          "filter[q]": term,
          "filter[organizationId]": ORG_2,
        });
        expect(org2.ids).toEqual([ids.org2]);

        const systemWide = await list({
          "filter[q]": term,
          "filter[organizationId]": "none",
        });
        expect(systemWide.ids).toEqual([ids.systemWide]);

        const refused = await list(
          { "filter[q]": term, "filter[organizationId]": ORG_2 },
          org1Reader
        );
        expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it("searches only the requested createdAt window", async () => {
        const yesterday = new Date(Date.now() - DAY_MS).toISOString();
        const result = await list({
          "filter[q]": term,
          "filter[createdAt_lte]": yesterday,
        });
        expect(result.status).toBe(HTTP_STATUS.OK);
        expect(result.ids).toEqual([]);
      });

      it("applies both bounds of a range whatever their form or order", async () => {
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const yesterday = new Date(Date.now() - DAY_MS).toISOString();
        const matches = [ids.inName, ids.inChanges, ids.inMetadata].sort();

        const current = await list({
          "filter[q]": term,
          "filter[createdAt_lte]": new Date(Date.now() + DAY_MS).toISOString(),
          "filter[createdAt]": hourAgo,
          "filter[createdAt_op]": "gte",
        });
        expect(current.status).toBe(HTTP_STATUS.OK);
        expect(current.ids.sort()).toEqual(matches);

        // The lte bound must survive the later _op key, not be replaced by it.
        const past = await list({
          "filter[createdAt_lte]": yesterday,
          "filter[createdAt]": "2000-01-01",
          "filter[createdAt_op]": "gte",
        });
        expect(past.status).toBe(HTTP_STATUS.OK);
        expect(past.ids).toEqual([]);

        const pastReversed = await list({
          "filter[createdAt]": "2000-01-01",
          "filter[createdAt_op]": "gte",
          "filter[createdAt_lte]": yesterday,
        });
        expect(pastReversed.status).toBe(HTTP_STATUS.OK);
        expect(pastReversed.ids).toEqual([]);
      });
    });

    describe("GET /entries/facets metadataKeys", () => {
      const facets = (token: string, organizationFilter?: string) =>
        axios.get(`${BASE_URL}/entries/facets`, {
          params: organizationFilter
            ? { "filter[organizationId]": organizationFilter }
            : {},
          ...auth(token),
        });

      it("lists the top-level metadata keys in the caller's organization", async () => {
        const res = await facets(org1Reader);
        expect(res.status).toBe(HTTP_STATUS.OK);
        const keys = res.data.metadataKeys as string[];
        expect(keys).toEqual(expect.arrayContaining([keyA, keyB, "note"]));
        expect(keys).not.toContain(keyOrg2);
        expect(keys).not.toContain(keySystem);
        expect(new Set(keys).size).toBe(keys.length);
        expect([...keys].sort()).toEqual(keys);
      });

      it("draws only from the requested createdAt window", async () => {
        const window = (params: Record<string, string>) =>
          axios.get(`${BASE_URL}/entries/facets`, {
            params,
            ...auth(org1Reader),
          });

        const recent = await window({
          "filter[createdAt_gte]": new Date(Date.now() - DAY_MS).toISOString(),
        });
        expect(recent.status).toBe(HTTP_STATUS.OK);
        expect(recent.data.sources).toContain(source);
        expect(recent.data.entityTypes).toContain(entityType);
        expect(recent.data.metadataKeys).toContain(keyA);

        const before = await window({
          "filter[createdAt_lte]": new Date(Date.now() - DAY_MS).toISOString(),
        });
        expect(before.status).toBe(HTTP_STATUS.OK);
        expect(before.data.sources).not.toContain(source);
        expect(before.data.entityTypes).not.toContain(entityType);
        expect(before.data.metadataKeys).not.toContain(keyA);

        const bad = await window({ "filter[createdAt_gte]": "not-a-date" });
        expect(bad.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("follows the organization filter for audit-logs.admin", async () => {
        const org2 = await facets(org1Admin, ORG_2);
        expect(org2.data.metadataKeys).toContain(keyOrg2);
        expect(org2.data.metadataKeys).not.toContain(keyA);

        const systemWide = await facets(org1Admin, "none");
        expect(systemWide.data.metadataKeys).toContain(keySystem);
        expect(systemWide.data.metadataKeys).not.toContain(keyA);
      });
    });
  });

  describe("Audit userEmail case", () => {
    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    const runId = generateUniqueId();
    const source = `test-email-case-${runId}`;
    const entityType = `EmailCaseEntity${runId}`;
    const entityId = `email-case-${runId}`;
    // Unique per run, so a search never matches another file's entries.
    const term = `Ec${runId}`;
    let token: string;

    const entry = (userEmail: string) => ({
      source,
      organizationId: getTestOrgId(),
      userId: getTestUserId(),
      userEmail,
      action: "UPDATE",
      entityType,
      entityId,
      entityName: term,
    });

    const list = async (params: Record<string, string>) => {
      const res = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[source]": source, ...params },
        ...auth(token),
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      return (res.data.data as { id: string }[]).map((e) => e.id);
    };

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("filtering", () => {
      const ids = { legacy: "", underscore: "", lookalike: "" };

      beforeAll(async () => {
        // A row written before emails were lower-cased.
        ids.legacy = (
          await prisma.auditLogEntry.create({
            data: {
              ...entry(`Test-Legacy-${runId}@Example.COM`),
              action: "UPDATE",
              writerUserId: getTestUserId(),
            },
          })
        ).id;
        const write = async (email: string) => {
          const res = await axios.post(
            `${BASE_URL}/entries`,
            entry(email),
            auth(token)
          );
          expect(res.status).toBe(HTTP_STATUS.CREATED);
          return res.data.id as string;
        };
        ids.underscore = await write(`test-a_b-${runId}@example.com`);
        ids.lookalike = await write(`test-axb-${runId}@example.com`);
      });

      it("matches a mixed-case row in any case, without filter[q] and with it", async () => {
        for (const email of [
          `test-legacy-${runId}@example.com`,
          `TEST-LEGACY-${runId}@EXAMPLE.COM`,
        ]) {
          expect(await list({ "filter[userEmail]": email })).toEqual([
            ids.legacy,
          ]);
          expect(
            await list({ "filter[userEmail]": email, "filter[q]": term })
          ).toEqual([ids.legacy]);
        }
      });

      it("treats LIKE wildcards in an exact match literally", async () => {
        const email = `test-a_b-${runId}@example.com`;
        expect(await list({ "filter[userEmail]": email })).toEqual([
          ids.underscore,
        ]);
        expect(
          await list({ "filter[userEmail]": email, "filter[q]": term })
        ).toEqual([ids.underscore]);
      });

      it("matches a substring in any case", async () => {
        expect(
          await list({
            "filter[userEmail]": `LEGACY-${runId}`,
            "filter[userEmail_op]": "contains",
          })
        ).toEqual([ids.legacy]);
      });
    });
  });

  describe("Audit pagination across entries written in the same millisecond", () => {
    const ORG_1 = "00000000-0000-7002-8000-000000000001";
    const USER_1 = "00000000-0000-7001-8000-000000000001";

    const runId = generateUniqueId();
    const entityType = `TieEntity${runId}`;
    let token: string;
    let ids: string[];

    beforeAll(async () => {
      token = await getTestAccessToken();
      const createdAt = new Date();
      const rows = await Promise.all(
        [0, 1, 2, 3].map(() =>
          prisma.auditLogEntry.create({
            data: {
              source: `test-tie-${runId}`,
              organizationId: ORG_1,
              userId: USER_1,
              userEmail: `test-tie-${runId}@example.com`,
              action: "UPDATE",
              entityType,
              entityId: `tie-${runId}`,
              entityName: `tie-name-${runId}`,
              writerUserId: USER_1,
              createdAt,
            },
          })
        )
      );
      ids = rows.map((r) => r.id).sort();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const pageThrough = async (query: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const res: { status: number; data: Record<string, unknown> } =
          await axios.get(
            `${BASE_URL}/entries?${query}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              validateStatus: () => true,
            }
          );
        expect(res.status).toBe(HTTP_STATUS.OK);
        seen.push(...(res.data.data as { id: string }[]).map((e) => e.id));
        if (!res.data.hasMore) break;
        cursor = res.data.nextCursor as string;
      }
      return seen;
    };

    it.each(["desc", "asc"])(
      "lists every tied entry once, by id, sorted %s",
      async (dir) => {
        expect(
          await pageThrough(`filter[entityType]=${entityType}&sortDir=${dir}`)
        ).toEqual(ids);
      }
    );

    it.each(["desc", "asc"])(
      "searches every tied entry once, by id, sorted %s",
      async (dir) => {
        expect(
          await pageThrough(`filter[q]=tie-name-${runId}&sortDir=${dir}`)
        ).toEqual(ids);
      }
    );
  });
});
