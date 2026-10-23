// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getRedisClient } from "../../../../../utils/redis.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  getTestUserId,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  generateUniqueId,
} from "../../../../support/webhooks.js";

describe("POST /v1/webhooks/events and /v1/webhooks/events/batch", () => {
  describe("Event Emission", () => {
    let testToken: string;

    const auth = () => ({
      headers: { Authorization: `Bearer ${testToken}` },
      validateStatus: () => true,
    });

    const event = (
      eventType: string,
      extra: { idempotencyKey?: string } = {}
    ) => ({
      organizationId: getTestOrgId(),
      eventType,
      entityType: "TestEntity",
      entityId: `test-entity-${generateUniqueId()}`,
      data: { key: "value" },
      ...extra,
    });

    /** Deliveries plus emit audit entries written for an event type. */
    const writesFor = async (eventType: string) => {
      const deliveries = await prisma.webhookDelivery.count({
        where: { eventType },
      });
      const audits = await prisma.auditLogEntry.count({
        where: {
          entityType: "WebhookEvent",
          metadata: { path: ["eventType"], equals: eventType },
        },
      });
      return deliveries + audits;
    };

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("POST /events", () => {
      it("should emit an event and return 202 with delivery count", async () => {
        const et = await createTestEventType(testToken);
        const ep = await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        const response = await axios.post(
          `${BASE_URL}/events`,
          {
            organizationId: getTestOrgId(),
            eventType: et.eventType,
            entityType: "TestEntity",
            entityId: `test-entity-${generateUniqueId()}`,
            data: { key: "value", nested: { foo: "bar" } },
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.deliveriesCreated).toBe(1);

        const audit = await prisma.auditLogEntry.findFirstOrThrow({
          where: {
            entityType: "WebhookEvent",
            metadata: { path: ["eventType"], equals: et.eventType },
          },
        });
        expect(audit.userId).toBe(getTestUserId());
        expect(audit.organizationId).toBe(getTestOrgId());
        expect(audit.metadata).toMatchObject({ deliveriesCreated: 1 });
        // Not the event's data, which the audit log's readers may not read.
        expect(JSON.stringify(audit.metadata)).not.toContain("nested");

        // Verify delivery record was created in database
        const deliveries = await prisma.webhookDelivery.findMany({
          where: { webhookEndpointId: ep.id },
        });

        expect(deliveries.length).toBeGreaterThanOrEqual(1);
        expect(deliveries[0].eventType).toBe(et.eventType);
        expect(deliveries[0].status).toBe("PENDING");
      });

      it("should create deliveries for multiple endpoints", async () => {
        const et = await createTestEventType(testToken);
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        const response = await axios.post(
          `${BASE_URL}/events`,
          {
            organizationId: getTestOrgId(),
            eventType: et.eventType,
            entityType: "TestEntity",
            entityId: `test-entity-${generateUniqueId()}`,
            data: { key: "value" },
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.deliveriesCreated).toBe(2);
      });

      it("should return 202 with 0 deliveries when no active endpoints exist", async () => {
        const et = await createTestEventType(testToken);
        // Don't create any endpoints for this event type

        const response = await axios.post(
          `${BASE_URL}/events`,
          {
            organizationId: getTestOrgId(),
            eventType: et.eventType,
            entityType: "TestEntity",
            entityId: `test-entity-${generateUniqueId()}`,
            data: { key: "value" },
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.deliveriesCreated).toBe(0);
      });

      it("should return 0 deliveries when event has no matching endpoints", async () => {
        const et = await createTestEventType(testToken);
        // Don't create any endpoints for this event type

        const entityId = `test-entity-${generateUniqueId()}`;

        const response = await axios.post(
          `${BASE_URL}/events`,
          {
            organizationId: getTestOrgId(),
            eventType: et.eventType,
            entityType: "TestEntity",
            entityId,
            data: { key: "audit-test" },
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.deliveriesCreated).toBe(0);
      });

      describe("Idempotency", () => {
        it("should return cached result for duplicate idempotencyKey", async () => {
          const et = await createTestEventType(testToken);
          await createTestWebhookEndpoint(testToken, {
            eventTypes: [et.eventType],
          });

          const idempotencyKey = `idem-${generateUniqueId()}`;
          const eventPayload = {
            organizationId: getTestOrgId(),
            eventType: et.eventType,
            entityType: "TestEntity",
            entityId: `test-entity-${generateUniqueId()}`,
            data: { key: "value" },
            idempotencyKey,
          };

          // First call
          const response1 = await axios.post(
            `${BASE_URL}/events`,
            eventPayload,
            {
              headers: {
                Authorization: `Bearer ${testToken}`,
                "Content-Type": "application/json",
              },
              validateStatus: () => true,
            }
          );

          expect(response1.status).toBe(HTTP_STATUS.ACCEPTED);
          expect(response1.data.deliveriesCreated).toBe(1);

          // Second call with same idempotencyKey
          const response2 = await axios.post(
            `${BASE_URL}/events`,
            eventPayload,
            {
              headers: {
                Authorization: `Bearer ${testToken}`,
                "Content-Type": "application/json",
              },
              validateStatus: () => true,
            }
          );

          expect(response2.status).toBe(HTTP_STATUS.ACCEPTED);
          expect(response2.data.deliveriesCreated).toBe(1);

          // Verify only 1 delivery was created (not 2)
          const deliveries = await prisma.webhookDelivery.findMany({
            where: { eventType: et.eventType },
          });
          expect(deliveries.length).toBe(1);
        });

        it("returns 422 idempotency_key_conflict for the same key with a different body", async () => {
          const et = await createTestEventType(testToken);
          await createTestWebhookEndpoint(testToken, {
            eventTypes: [et.eventType],
          });
          const eventPayload = {
            organizationId: getTestOrgId(),
            eventType: et.eventType,
            entityType: "TestEntity",
            entityId: `test-entity-${generateUniqueId()}`,
            data: { key: "value" },
            idempotencyKey: `idem-${generateUniqueId()}`,
          };
          const post = (body: unknown) =>
            axios.post(`${BASE_URL}/events`, body, {
              headers: { Authorization: `Bearer ${testToken}` },
              validateStatus: () => true,
            });

          expect((await post(eventPayload)).status).toBe(HTTP_STATUS.ACCEPTED);
          const changed = await post({
            ...eventPayload,
            data: { key: "other" },
          });
          expect(changed.status).toBe(422);
          expect(changed.data.error).toBe("idempotency_key_conflict");

          // Key order does not make a body different.
          const { data, entityId, ...rest } = eventPayload;
          const reordered = await post({ data, entityId, ...rest });
          expect(reordered.status).toBe(HTTP_STATUS.ACCEPTED);

          expect(
            await prisma.webhookDelivery.count({
              where: { eventType: et.eventType },
            })
          ).toBe(1);
        });

        it("should create separate deliveries for different idempotencyKeys", async () => {
          const et = await createTestEventType(testToken);
          await createTestWebhookEndpoint(testToken, {
            eventTypes: [et.eventType],
          });

          const basePayload = {
            organizationId: getTestOrgId(),
            eventType: et.eventType,
            entityType: "TestEntity",
            entityId: `test-entity-${generateUniqueId()}`,
            data: { key: "value" },
          };

          const response1 = await axios.post(
            `${BASE_URL}/events`,
            { ...basePayload, idempotencyKey: `key-a-${generateUniqueId()}` },
            {
              headers: {
                Authorization: `Bearer ${testToken}`,
                "Content-Type": "application/json",
              },
              validateStatus: () => true,
            }
          );

          const response2 = await axios.post(
            `${BASE_URL}/events`,
            { ...basePayload, idempotencyKey: `key-b-${generateUniqueId()}` },
            {
              headers: {
                Authorization: `Bearer ${testToken}`,
                "Content-Type": "application/json",
              },
              validateStatus: () => true,
            }
          );

          expect(response1.status).toBe(HTTP_STATUS.ACCEPTED);
          expect(response2.status).toBe(HTTP_STATUS.ACCEPTED);
          expect(response1.data.deliveriesCreated).toBe(1);
          expect(response2.data.deliveriesCreated).toBe(1);
        });

        it("should always create new deliveries without idempotencyKey", async () => {
          const et = await createTestEventType(testToken);
          await createTestWebhookEndpoint(testToken, {
            eventTypes: [et.eventType],
          });

          const basePayload = {
            organizationId: getTestOrgId(),
            eventType: et.eventType,
            entityType: "TestEntity",
            entityId: `test-entity-${generateUniqueId()}`,
            data: { key: "value" },
          };

          await axios.post(`${BASE_URL}/events`, basePayload, {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          });

          await axios.post(`${BASE_URL}/events`, basePayload, {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          });

          const deliveries = await prisma.webhookDelivery.findMany({
            where: { eventType: et.eventType },
          });
          expect(deliveries.length).toBe(2);
        });
      });
    });

    describe("POST /events/batch", () => {
      it("should process multiple events and return per-event results", async () => {
        const et1 = await createTestEventType(testToken);
        const et2 = await createTestEventType(testToken);
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et1.eventType],
        });
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et2.eventType],
        });

        const response = await axios.post(
          `${BASE_URL}/events/batch`,
          {
            events: [
              {
                organizationId: getTestOrgId(),
                eventType: et1.eventType,
                entityType: "TestEntity",
                entityId: `test-entity-${generateUniqueId()}`,
                data: { key: "batch1" },
              },
              {
                organizationId: getTestOrgId(),
                eventType: et2.eventType,
                entityType: "TestEntity",
                entityId: `test-entity-${generateUniqueId()}`,
                data: { key: "batch2" },
              },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.results).toHaveLength(2);
        expect(response.data.results[0].deliveriesCreated).toBe(1);
        expect(response.data.results[1].deliveriesCreated).toBe(1);
      });

      it("should handle mixed results (some events have endpoints, some don't)", async () => {
        const et1 = await createTestEventType(testToken);
        const et2 = await createTestEventType(testToken);
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et1.eventType],
        });
        // No endpoint for et2

        const response = await axios.post(
          `${BASE_URL}/events/batch`,
          {
            events: [
              {
                organizationId: getTestOrgId(),
                eventType: et1.eventType,
                entityType: "TestEntity",
                entityId: `test-entity-${generateUniqueId()}`,
                data: { key: "has-endpoint" },
              },
              {
                organizationId: getTestOrgId(),
                eventType: et2.eventType,
                entityType: "TestEntity",
                entityId: `test-entity-${generateUniqueId()}`,
                data: { key: "no-endpoint" },
              },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.results).toHaveLength(2);
        expect(response.data.results[0].deliveriesCreated).toBe(1);
        expect(response.data.results[1].deliveriesCreated).toBe(0);
      });
    });

    describe("POST /events/batch is all-or-nothing", () => {
      const idempotencyCacheKey = (eventType: string, key: string) =>
        `webhook-service:idempotency:${getTestUserId()}:${getTestOrgId()}:${eventType}:${key}`;

      it("queues every event of a valid batch", async () => {
        const et = await createTestEventType(testToken);
        const noEndpoint = await createTestEventType(testToken);
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        const response = await axios.post(
          `${BASE_URL}/events/batch`,
          {
            events: [
              event(et.eventType),
              event(noEndpoint.eventType),
              event(et.eventType),
            ],
          },
          auth()
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(
          response.data.results.map(
            (r: { deliveriesCreated: number }) => r.deliveriesCreated
          )
        ).toEqual([2, 0, 2]);
        expect(
          await prisma.webhookDelivery.count({
            where: { eventType: et.eventType },
          })
        ).toBe(4);
        expect(await writesFor(noEndpoint.eventType)).toBe(1);
        // One audit entry per event, under the caller.
        const audits = await prisma.auditLogEntry.findMany({
          where: {
            entityType: "WebhookEvent",
            metadata: { path: ["eventType"], equals: et.eventType },
          },
        });
        expect(audits.map((a) => a.userId)).toEqual([
          getTestUserId(),
          getTestUserId(),
        ]);
      });

      it("fails the whole batch with 409 while one key is in progress, releasing its own claims", async () => {
        const et = await createTestEventType(testToken);
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });
        const busyKey = `idem-${generateUniqueId()}`;
        const ownKey = `idem-${generateUniqueId()}`;
        const redis = getRedisClient();
        await redis.set(
          idempotencyCacheKey(et.eventType, busyKey),
          "__processing__",
          "EX",
          60
        );

        try {
          const response = await axios.post(
            `${BASE_URL}/events/batch`,
            {
              events: [
                event(et.eventType, { idempotencyKey: ownKey }),
                event(et.eventType, { idempotencyKey: busyKey }),
              ],
            },
            auth()
          );

          expect(response.status).toBe(HTTP_STATUS.CONFLICT);
          expect(response.data.error).toBe("idempotency_request_in_progress");
          expect(await writesFor(et.eventType)).toBe(0);
          expect(
            await redis.exists(idempotencyCacheKey(et.eventType, ownKey))
          ).toBe(0);
        } finally {
          await redis.del(idempotencyCacheKey(et.eventType, busyKey));
        }
      });

      it("returns cached results for keys already processed and queues the rest", async () => {
        const et = await createTestEventType(testToken);
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });
        const first = event(et.eventType, {
          idempotencyKey: `idem-${generateUniqueId()}`,
        });

        const single = await axios.post(`${BASE_URL}/events`, first, auth());
        expect(single.status).toBe(HTTP_STATUS.ACCEPTED);

        const response = await axios.post(
          `${BASE_URL}/events/batch`,
          { events: [first, event(et.eventType)] },
          auth()
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.results).toHaveLength(2);
        expect(response.data.results[0]).toEqual({
          eventType: et.eventType,
          entityId: first.entityId,
          deliveriesCreated: 1,
        });
        expect(response.data.results[1].deliveriesCreated).toBe(1);
        expect(
          await prisma.webhookDelivery.count({
            where: { eventType: et.eventType },
          })
        ).toBe(2);
      });

      it("fails the whole batch with 422 when a key was used with a different event", async () => {
        const et = await createTestEventType(testToken);
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });
        const first = event(et.eventType, {
          idempotencyKey: `idem-${generateUniqueId()}`,
        });
        expect(
          (await axios.post(`${BASE_URL}/events`, first, auth())).status
        ).toBe(HTTP_STATUS.ACCEPTED);

        const response = await axios.post(
          `${BASE_URL}/events/batch`,
          {
            events: [
              event(et.eventType),
              { ...first, entityId: `${first.entityId}-changed` },
            ],
          },
          auth()
        );

        expect(response.status).toBe(422);
        expect(response.data.error).toBe("idempotency_key_conflict");
        // The first emit's delivery and audit entry.
        expect(await writesFor(et.eventType)).toBe(2);
      });

      it("returns 422 for a different event while the key's first request is processing", async () => {
        const et = await createTestEventType(testToken);
        const key = `idem-${generateUniqueId()}`;
        const redis = getRedisClient();
        await redis.set(
          idempotencyCacheKey(et.eventType, key),
          `__processing__:${"0".repeat(64)}`,
          "EX",
          60
        );
        try {
          const response = await axios.post(
            `${BASE_URL}/events`,
            event(et.eventType, { idempotencyKey: key }),
            auth()
          );
          expect(response.status).toBe(422);
          expect(response.data.error).toBe("idempotency_key_conflict");
        } finally {
          await redis.del(idempotencyCacheKey(et.eventType, key));
        }
      });

      it("replays a result stored before body hashes were", async () => {
        const et = await createTestEventType(testToken);
        const key = `idem-${generateUniqueId()}`;
        const redis = getRedisClient();
        const legacy = {
          eventType: et.eventType,
          entityId: "legacy",
          deliveriesCreated: 3,
        };
        await redis.set(
          idempotencyCacheKey(et.eventType, key),
          JSON.stringify(legacy),
          "EX",
          60
        );
        try {
          const response = await axios.post(
            `${BASE_URL}/events`,
            event(et.eventType, { idempotencyKey: key }),
            auth()
          );
          expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
          expect(response.data.deliveriesCreated).toBe(3);
          expect(await writesFor(et.eventType)).toBe(0);
        } finally {
          await redis.del(idempotencyCacheKey(et.eventType, key));
        }
      });
    });
  });
});
