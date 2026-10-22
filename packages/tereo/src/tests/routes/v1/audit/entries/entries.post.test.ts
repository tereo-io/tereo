// @module-tag int
// @module-tag audit
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import crypto from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  getTestUserId,
  cleanupTestEntities,
  generateUniqueId,
} from "../../../../support/audit.js";

describe("POST /v1/audit/entries and /v1/audit/entries/batch", () => {
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
        expect(response.data.userId).toBe(
          "00000000-0000-7001-8000-000000000001"
        );
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

      it("should return 400 for a user that does not exist", async () => {
        const response = await createEntry({
          userId: crypto.randomUUID(),
        }).catch((e) => e.response);
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

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("lower-cases userEmail on a single write", async () => {
      const res = await axios.post(
        `${BASE_URL}/entries`,
        entry(`Test-Single-${runId}@Example.COM`),
        auth(token)
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      expect(res.data.userEmail).toBe(`test-single-${runId}@example.com`);
    });

    it("lower-cases userEmail on a batch write", async () => {
      const res = await axios.post(
        `${BASE_URL}/entries/batch`,
        { entries: [entry(`TEST-Batch-${runId}@Example.com`)] },
        auth(token)
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      const row = await prisma.auditLogEntry.findFirstOrThrow({
        where: { source, userEmail: { startsWith: "test-batch-" } },
      });
      expect(row.userEmail).toBe(`test-batch-${runId}@example.com`);
    });
  });
});
