// @module-tag int
// @module-tag audit
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  cleanupTestEntities,
  generateUniqueId,
} from "../../../../support/audit.js";

describe("/v1/audit/entries", () => {
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

    describe("Batch boundary validation", () => {
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
    });

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
    });
  });

  describe("Audit query options", () => {
    const ORG_1 = "00000000-0000-7002-8000-000000000001";
    const USER_1 = "00000000-0000-7001-8000-000000000001";
    const DAY_MS = 24 * 60 * 60 * 1000;

    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    interface Entry {
      id: string;
    }

    const runId = generateUniqueId();
    const source = `test-query-${runId}`;
    // Unique per run, so a search never matches another file's entries.
    const term = `Zq${runId}`;

    let org1Admin: string;

    beforeAll(async () => {
      org1Admin = await getTestAccessToken(USER_1, ORG_1);
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

    describe("filter[q]", () => {
      it("refuses a window longer than 31 days", async () => {
        const result = await list({
          "filter[q]": term,
          "filter[createdAt_gte]": new Date(
            Date.now() - 40 * DAY_MS
          ).toISOString(),
        });
        expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(result.error).toBe("search_window_too_large");

        const unbounded = await list({ "filter[createdAt_gte]": "2000-01-01" });
        expect(unbounded.status).toBe(HTTP_STATUS.OK);
      });

      it("tolerates a client clock a little ahead when computing 31 days ago", async () => {
        const result = await list({
          "filter[q]": term,
          "filter[createdAt_gte]": new Date(
            Date.now() - 31 * DAY_MS - 2 * 60 * 1000
          ).toISOString(),
        });
        expect(result.status).toBe(HTTP_STATUS.OK);
      });

      it("refuses a long window given in _op form, whatever the order", async () => {
        const old = new Date(Date.now() - 40 * DAY_MS).toISOString();
        const now = new Date(Date.now() + DAY_MS).toISOString();
        const lteFirst = await list({
          "filter[q]": term,
          "filter[createdAt_lte]": now,
          "filter[createdAt]": old,
          "filter[createdAt_op]": "gte",
        });
        expect(lteFirst.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(lteFirst.error).toBe("search_window_too_large");

        const gteFirst = await list({
          "filter[q]": term,
          "filter[createdAt]": old,
          "filter[createdAt_op]": "gte",
          "filter[createdAt_lte]": now,
        });
        expect(gteFirst.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(gteFirst.error).toBe("search_window_too_large");

        const repeated = await axios.get(
          `${BASE_URL}/entries?filter[q]=${term}` +
            `&filter[createdAt]=${old}&filter[createdAt]=${now}` +
            `&filter[createdAt_op]=gte&filter[createdAt_op]=lte`,
          auth(org1Admin)
        );
        expect(repeated.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(repeated.data.error).toBe("search_window_too_large");
      });
    });
  });
});
