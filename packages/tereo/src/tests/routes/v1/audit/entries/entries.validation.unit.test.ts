// @module-tag unit
// @module-tag audit
import { describe, it, expect } from "vitest";
import {
  createBatchSchema,
  createEntrySchema,
  listQuerySchema,
  listSearchQuerySchema,
} from "../../../../../routes/v1/audit/entries/schemas.js";

const entry = {
  source: "test-service",
  organizationId: "00000000-0000-7002-8000-000000000001",
  userId: "00000000-0000-7001-8000-000000000001",
  action: "CREATE",
  entityType: "Order",
  entityId: "order-1",
};

describe("/v1/audit/entries", () => {
  describe("createEntrySchema", () => {
    it.each([
      ["a body with only a source", { source: "test-service" }],
      ["an action outside the enum", { ...entry, action: "DESTROY" }],
      ["an empty source", { ...entry, source: "" }],
      ["an empty userId", { ...entry, userId: "" }],
      ["an empty entityType", { ...entry, entityType: "" }],
      ["an empty entityId", { ...entry, entityId: "" }],
      ["an ipAddress that is not an IP", { ...entry, ipAddress: "not-an-ip" }],
      [
        "an IPv4 ipAddress with octets over 255",
        { ...entry, ipAddress: "999.999.999.999" },
      ],
      [
        "a userEmail that is not an email",
        { ...entry, userEmail: "not-an-email" },
      ],
      [
        "an organizationId that is not a uuid",
        { ...entry, organizationId: "not-a-uuid" },
      ],
      ["a source over 100 characters", { ...entry, source: "a".repeat(101) }],
      [
        "an entityName over 500 characters",
        { ...entry, entityName: "b".repeat(501) },
      ],
      [
        "an idempotencyKey over 255 characters",
        { ...entry, idempotencyKey: "k".repeat(256) },
      ],
      ["an empty idempotencyKey", { ...entry, idempotencyKey: "" }],
      [
        "a correlationId over 255 characters",
        { ...entry, correlationId: "x".repeat(256) },
      ],
    ])("rejects %s", (_label, body) => {
      expect(createEntrySchema.safeParse(body).success).toBe(false);
    });

    it.each([
      ["an IPv4 ipAddress", { ipAddress: "192.168.1.1" }],
      ["an IPv6 ipAddress", { ipAddress: "::1" }],
      ["a null ipAddress", { ipAddress: null }],
      [
        "the IPv4 octet boundary 255.255.255.255",
        { ipAddress: "255.255.255.255" },
      ],
      ["the IPv4 zero address 0.0.0.0", { ipAddress: "0.0.0.0" }],
      ["a valid userEmail", { userEmail: "user@example.com" }],
      ["a null userEmail", { userEmail: null }],
      ["a 1-character idempotencyKey", { idempotencyKey: "x" }],
      ["a 255-character idempotencyKey", { idempotencyKey: "k".repeat(255) }],
    ])("accepts %s", (_label, override) => {
      const result = createEntrySchema.safeParse({ ...entry, ...override });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(override);
    });
  });

  describe("createBatchSchema", () => {
    it.each([
      ["an empty entries array", { entries: [] }],
      [
        "an entry missing required fields",
        { entries: [entry, { source: "test-service" }] },
      ],
      [
        "a per-entry idempotencyKey",
        { entries: [{ ...entry, idempotencyKey: "per-entry-key" }] },
      ],
      [
        "one entry with an invalid ipAddress",
        {
          entries: [
            { ...entry, ipAddress: "192.168.1.1" },
            { ...entry, ipAddress: "not-an-ip" },
          ],
        },
      ],
      [
        "more than 1000 entries",
        { entries: Array.from({ length: 1001 }, () => entry) },
      ],
    ])("rejects a batch with %s", (_label, body) => {
      expect(createBatchSchema.safeParse(body).success).toBe(false);
    });

    it("accepts a batch-level idempotencyKey", () => {
      const result = createBatchSchema.safeParse({
        entries: [entry],
        idempotencyKey: "batch-key",
      });
      expect(result.success).toBe(true);
      expect(result.data?.idempotencyKey).toBe("batch-key");
    });
  });

  describe("listQuerySchema and listSearchQuerySchema", () => {
    it.each([
      ["an unsupported sort field", { sort: "entityType", sortDir: "asc" }],
      [
        "a writerUserId that is not a uuid",
        { "filter[writerUserId]": "nobody" },
      ],
      ["a blank filter[q]", { "filter[q]": "   " }],
      ["a limit over the maxLimit of 200", { limit: "201" }],
    ])("rejects a list query with %s", (_label, query) => {
      expect(listQuerySchema.safeParse(query).success).toBe(false);
    });

    it("rejects a repeated filter[q]", () => {
      const query = { "filter[q]": ["a", "b"] };
      expect(listSearchQuerySchema.safeParse(query).success).toBe(false);
    });

    it("accepts sorting by createdAt", () => {
      const result = listQuerySchema.safeParse({
        sort: "createdAt",
        sortDir: "asc",
      });
      expect(result.success).toBe(true);
      expect(result.data?.sort).toBe("createdAt");
    });

    it("accepts a limit at the maxLimit of 200", () => {
      const result = listQuerySchema.safeParse({ limit: "200" });
      expect(result.success).toBe(true);
      expect(result.data?.limit).toBe(200);
    });
  });
});
