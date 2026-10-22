// @module-tag int
// @module-tag audit
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
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
    });

    describe("POST /v1/entries/batch", () => {
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
      it("should reject a tampered cursor with 400 invalid_cursor", async () => {
        const response = await axios.get(`${BASE_URL}/entries`, {
          params: { limit: 2, cursor: "bogus.tampered" },
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });
    });

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
  });

  describe("Audit input Postgres cannot take", () => {
    const ORG_1 = "00000000-0000-7002-8000-000000000001";
    const USER_1 = "00000000-0000-7001-8000-000000000001";

    // Input that once reached Postgres and failed there with a 500.

    const runId = generateUniqueId();
    let token: string;
    const cfg = () => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    const entry = {
      source: `test-input-${runId}`,
      organizationId: ORG_1,
      userId: USER_1,
      userEmail: `test-input-${runId}@example.com`,
      action: "CREATE",
      entityType: "InputEntity",
      entityId: `input-${runId}`,
    };

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const get = (path: string) => axios.get(`${BASE_URL}${path}`, cfg());

    it.each([
      ["a userId filter that is not a uuid", "/entries?filter[userId]=nope"],
      [
        "a userId filter that is not a uuid, on entity history",
        "/entries/entity/InputEntity/x?filter[userId]=nope",
      ],
      [
        "a createdAt bound outside the years 1-9999",
        "/entries?filter[createdAt_gte]=-271821-04-20T00:00:00Z",
      ],
      ["a NUL in filter[q]", "/entries?filter[q]=a%00b"],
      ["a NUL in a filter value", "/entries?filter[entityName]=%00"],
      ["a NUL in a metadata filter", "/entries?metadata[k_equals]=%00"],
      ["a NUL in the entity path", "/entries/entity/InputEntity/a%00b"],
      ["a metadata filter with no operator", "/entries?metadata[k]=x"],
      [
        "a repeated metadata filter",
        "/entries?metadata[k_equals]=x&metadata[k_equals]=y",
      ],
      [
        "a metadata filter key over 100 characters",
        `/entries?metadata[${"k".repeat(101)}_equals]=x`,
      ],
      [
        "a metadata filter value over 500 characters",
        `/entries?metadata[k_equals]=${"v".repeat(501)}`,
      ],
      [
        "more than 20 metadata filters",
        `/entries?${Array.from({ length: 21 }, (_, i) => `metadata[k${i}_equals]=x`).join("&")}`,
      ],
      ["a repeated filter[q]", "/entries?filter[q]=a&filter[q]=b"],
      [
        "a filter value over 500 characters",
        `/entries?filter[entityName]=${"n".repeat(501)}`,
      ],
      [
        "a repeated filter[organizationId]",
        `/entries?filter[organizationId]=${ORG_1}&filter[organizationId]=${ORG_1}`,
      ],
      [
        "a filter[organizationId] that is not an id",
        "/entries?filter[organizationId]=nope",
      ],
    ])("refuses %s with a 400", async (_label, path) => {
      const res = await get(path);
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("invalid_request");
    });

    it.each([
      ["entityId", { entityId: "a\u0000b" }],
      ["source", { source: "a\u0000" }],
      ["a metadata value", { metadata: { nested: ["x\u0000y"] } }],
      ["a changes key", { changes: { "a\u0000": { new: 1 } } }],
    ])("refuses a NUL in %s with a 400", async (_label, override) => {
      const res = await axios.post(
        `${BASE_URL}/entries`,
        { ...entry, ...override },
        cfg()
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("invalid_request");
    });

    it.each([
      ["metadata", { metadata: { big: "x".repeat(64 * 1024) } }],
      ["changes", { changes: { big: { new: "x".repeat(64 * 1024) } } }],
    ])(
      "refuses %s over 64 KiB as JSON with a 400",
      async (_label, override) => {
        const res = await axios.post(
          `${BASE_URL}/entries`,
          { ...entry, ...override },
          cfg()
        );
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("invalid_request");
      }
    );

    it("still reads metadata filters and filter[organizationId]=none", async () => {
      const ok = await get(
        `/entries?metadata[k_equals]=x&metadata[j_contains]=&filter[organizationId]=${ORG_1}`
      );
      expect(ok.status).toBe(HTTP_STATUS.OK);
    });

    it("refuses a NUL in a batch entry, writing nothing", async () => {
      const res = await axios.post(
        `${BASE_URL}/entries/batch`,
        { entries: [entry, { ...entry, entityName: "\u0000" }] },
        cfg()
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const written = await prisma.auditLogEntry.count({
        where: { source: entry.source },
      });
      expect(written).toBe(0);
    });

    it("accepts an IPv4-mapped IPv6 address, as Express reports one", async () => {
      const res = await axios.post(
        `${BASE_URL}/entries`,
        { ...entry, ipAddress: "::ffff:203.0.113.7" },
        cfg()
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      expect(res.data.ipAddress).toBe("::ffff:203.0.113.7");
    });
  });
});
