// @module-tag int
// @module-tag audit
// @module-tag race
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

    describe("Idempotency edge cases", () => {
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
    });

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
  });
});
