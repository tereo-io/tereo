// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TEST_SERVICE } from "../../../../support/testService.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  generateUniqueId,
  EventTypeResponse,
  PaginatedResponse,
} from "../../../../support/webhooks.js";

type EventTypeRow = {
  eventType: string;
  serviceName: string;
  retiredAt: string | null;
};

const get = <T>(path: string, token: string, headers = {}) =>
  axios.get<T>(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    validateStatus: () => true,
  });

describe("GET /v1/webhooks/event-types", () => {
  describe("Event Type Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("writes are gone", () => {
      it.each([
        ["post", "/event-types"],
        ["put", "/event-types"],
        ["delete", "/event-types/auth.user.updated"],
      ] as const)("%s %s is 404", async (method, path) => {
        const response = await axios.request({
          method,
          url: `${BASE_URL}${path}`,
          data: [{ eventType: "test.x", source: "test" }],
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });
        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
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

    describe("GET /event-types", () => {
      it("should list event types", async () => {
        await createTestEventType(testToken);

        const response = await axios.get<PaginatedResponse<EventTypeResponse>>(
          `${BASE_URL}/event-types`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data).toBeDefined();
        expect(Array.isArray(response.data.data)).toBe(true);
        expect(response.data.data.length).toBeGreaterThan(0);

        const et = response.data.data[0];
        expect(et.eventType).toBeDefined();
        expect(et.source).toBeDefined();
        expect(et.createdAt).toBeDefined();
      });

      it("should support pagination", async () => {
        await Promise.all([
          createTestEventType(testToken),
          createTestEventType(testToken),
          createTestEventType(testToken),
        ]);

        const response = await axios.get<PaginatedResponse<EventTypeResponse>>(
          `${BASE_URL}/event-types?limit=2`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data.length).toBeLessThanOrEqual(2);
      });

      it("should round-trip nextCursor for a second page", async () => {
        await Promise.all([
          createTestEventType(testToken),
          createTestEventType(testToken),
          createTestEventType(testToken),
          createTestEventType(testToken),
        ]);

        const page1 = await axios.get<PaginatedResponse<EventTypeResponse>>(
          `${BASE_URL}/event-types?limit=2`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(page1.status).toBe(HTTP_STATUS.OK);
        expect(page1.data.data.length).toBe(2);
        expect(page1.data.hasMore).toBe(true);
        expect(page1.data.nextCursor).toBeDefined();
        expect(page1.data.nextCursor).not.toBeNull();

        const page2 = await axios.get<PaginatedResponse<EventTypeResponse>>(
          `${BASE_URL}/event-types?limit=2&cursor=${encodeURIComponent(
            page1.data.nextCursor!
          )}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(page2.status).toBe(HTTP_STATUS.OK);
        expect(page2.data.data.length).toBeGreaterThan(0);
        // Page 2 must not contain anything from page 1
        const page1Ids = new Set(page1.data.data.map((e) => e.eventType));
        for (const e of page2.data.data) {
          expect(page1Ids.has(e.eventType)).toBe(false);
        }
      });

      it("should return 400 for an invalid/tampered cursor", async () => {
        const response = await axios.get(
          `${BASE_URL}/event-types?cursor=not-a-real-cursor`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(response.data.error).toBe("invalid_cursor");
      });

      it("should filter by source", async () => {
        const response = await axios.get<PaginatedResponse<EventTypeResponse>>(
          `${BASE_URL}/event-types?filter[source]=core&filter[eventType]=auth.user.updated&filter[eventType_op]=contains`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data.map((e) => e.eventType)).toEqual([
          "auth.user.updated",
        ]);
        expect(response.data.data[0].source).toBe("core");
      });

      it("should filter by eventType contains", async () => {
        const uniqueId = generateUniqueId();
        await createTestEventType(testToken, {
          eventType: `test.filter.${uniqueId}`,
        });

        const response = await axios.get<PaginatedResponse<EventTypeResponse>>(
          `${BASE_URL}/event-types?filter[eventType]=${uniqueId}&filter[eventType_op]=contains`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data.length).toBeGreaterThanOrEqual(1);
        expect(response.data.data[0].eventType).toContain(uniqueId);
      });

      it("should return 401 without authentication", async () => {
        const response = await axios.get(`${BASE_URL}/event-types`, {
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      });
    });
  });

  describe("Webhook list filters and fields", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /event-types — serviceName and retired", () => {
      const tag = generateUniqueId();
      let active: string;
      let retired: string;

      beforeAll(async () => {
        active = (
          await createTestEventType(token, {
            eventType: `test.retired-filter.${tag}.active`,
          })
        ).eventType;
        retired = (
          await createTestEventType(token, {
            eventType: `test.retired-filter.${tag}.gone`,
          })
        ).eventType;
        await prisma.eventType.update({
          where: { eventType: retired },
          data: { retiredAt: new Date() },
        });
      });

      const list = (query: string) =>
        get<PaginatedResponse<EventTypeRow>>(
          `/event-types?limit=200&filter[eventType]=${tag}&filter[eventType_op]=contains&${query}`,
          token
        );

      it("names the declaring service", async () => {
        const res = await list("");
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.data.map((e) => e.serviceName)).toEqual([
          TEST_SERVICE.name,
          TEST_SERVICE.name,
        ]);

        const one = await get<EventTypeRow>(`/event-types/${active}`, token);
        expect(one.status).toBe(HTTP_STATUS.OK);
        expect(one.data.serviceName).toBe(TEST_SERVICE.name);
      });

      it("filters retired and not-retired event types", async () => {
        const onlyRetired = await list("filter[retired]=true");
        expect(onlyRetired.status).toBe(HTTP_STATUS.OK);
        expect(onlyRetired.data.data.map((e) => e.eventType)).toEqual([
          retired,
        ]);

        const notRetired = await list("filter[retired]=false");
        expect(notRetired.status).toBe(HTTP_STATUS.OK);
        expect(notRetired.data.data.map((e) => e.eventType)).toEqual([active]);
      });

      it("lists both without the filter", async () => {
        const res = await list("");
        expect(res.data.data.map((e) => e.eventType).sort()).toEqual(
          [active, retired].sort()
        );
      });

      it("returns 400, not 500, for a filter named after an Object member", async () => {
        for (const name of ["constructor", "toString", "__proto__"]) {
          const res = await list(`filter[${name}]=x`);
          expect(res.status, name).toBe(HTTP_STATUS.BAD_REQUEST);
        }
      });

      it("matches a text filter against the words true and false", async () => {
        const res = await list("filter[source]=true");
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.data).toEqual([]);
      });
    });
  });
});
