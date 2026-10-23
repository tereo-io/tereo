// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
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
      it("should return 400 for unregistered event type", async () => {
        const response = await axios.post(
          `${BASE_URL}/events`,
          {
            organizationId: getTestOrgId(),
            eventType: "unregistered.event.type",
            entityType: "TestEntity",
            entityId: "test-entity-1",
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

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("returns 400 reserved_event_type for webhook.test", async () => {
        const response = await axios.post(
          `${BASE_URL}/events`,
          event("webhook.test"),
          auth()
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(response.data.error).toBe("reserved_event_type");
      });
    });

    describe("POST /events/batch is all-or-nothing", () => {
      it("returns 400 reserved_event_type for webhook.test and queues nothing", async () => {
        const et = await createTestEventType(testToken);
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        const response = await axios.post(
          `${BASE_URL}/events/batch`,
          { events: [event(et.eventType), event("webhook.test")] },
          auth()
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(response.data.error).toBe("reserved_event_type");
        expect(await writesFor(et.eventType)).toBe(0);
      });

      it("queues nothing when one event's type is unregistered", async () => {
        const et = await createTestEventType(testToken);
        const noEndpoint = await createTestEventType(testToken);
        await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        const response = await axios.post(
          `${BASE_URL}/events/batch`,
          {
            events: [
              event(et.eventType),
              event(noEndpoint.eventType),
              event(`unregistered.${generateUniqueId()}`),
            ],
          },
          auth()
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(response.data.error).toBe("invalid_event_type");
        expect(await writesFor(et.eventType)).toBe(0);
        expect(await writesFor(noEndpoint.eventType)).toBe(0);
      });

      it("returns 400 duplicate_idempotency_key for a key repeated within the batch", async () => {
        const et = await createTestEventType(testToken);
        const idempotencyKey = `idem-${generateUniqueId()}`;

        const response = await axios.post(
          `${BASE_URL}/events/batch`,
          {
            events: [
              event(et.eventType, { idempotencyKey }),
              event(et.eventType, { idempotencyKey }),
            ],
          },
          auth()
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(response.data.error).toBe("duplicate_idempotency_key");
        expect(await writesFor(et.eventType)).toBe(0);
      });
    });

    describe("organizationId", () => {
      const event = (organizationId: string) => ({
        organizationId,
        eventType: "test.event",
        entityType: "TestEntity",
        entityId: "test-1",
        data: {},
      });
      const post = (path: string, data: unknown) =>
        axios.post(`${BASE_URL}${path}`, data, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

      it("returns 400 for a malformed organization id", async () => {
        const single = await post("/events", event("not-a-uuid"));
        expect(single.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(single.data.error).toBe("invalid_request");
        expect(single.data.error_description).toEqual(expect.any(String));

        const batch = await post("/events/batch", {
          events: [event("not-a-uuid")],
        });
        expect(batch.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(batch.data.error).toBe("invalid_request");
        expect(batch.data.error_description).toEqual(expect.any(String));
      });

      it("returns 400 unknown_organization for an unknown organization", async () => {
        const unknown = crypto.randomUUID();
        const single = await post("/events", event(unknown));
        expect(single.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(single.data.error).toBe("unknown_organization");

        const batch = await post("/events/batch", {
          events: [event(getTestOrgId()), event(unknown)],
        });
        expect(batch.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(batch.data.error).toBe("unknown_organization");
        expect(batch.data.error_description).toContain(unknown);
      });
    });
  });
});
