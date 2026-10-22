// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  cleanupTestEntities,
  EventTypeResponse,
} from "../../../../../support/webhooks.js";

describe("GET /v1/webhooks/event-types/:eventType", () => {
  describe("Event Type Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /event-types/:eventType", () => {
      it("should get event type by eventType", async () => {
        const et = await createTestEventType(testToken);

        const response = await axios.get<EventTypeResponse>(
          `${BASE_URL}/event-types/${et.eventType}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.eventType).toBe(et.eventType);
        expect(response.data.source).toBe(et.source);
      });

      it("should return 404 for non-existent event type", async () => {
        const response = await axios.get(
          `${BASE_URL}/event-types/non.existent.event.type`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });
  });
});
