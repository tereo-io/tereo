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
  });
});
