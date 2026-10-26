// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../../support/webhooks.js";

describe("Retired event types and webhook endpoints", () => {
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("retired event types", () => {
    it("cannot be subscribed to, and existing subscriptions are flagged", async () => {
      const et = await createTestEventType(testToken);
      const endpoint = await createTestWebhookEndpoint(testToken, {
        eventTypes: [et.eventType],
      });
      await prisma.eventType.update({
        where: { eventType: et.eventType },
        data: { retiredAt: new Date() },
      });

      const fetched = await axios.get(`${BASE_URL}/webhooks/${endpoint.id}`, {
        headers: { Authorization: `Bearer ${testToken}` },
      });
      expect(fetched.data.retiredEventTypes).toEqual([et.eventType]);

      const subscribe = await axios.post(
        `${BASE_URL}/webhooks`,
        { url: "https://example.com/hook", eventTypes: [et.eventType] },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(subscribe.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });
});
