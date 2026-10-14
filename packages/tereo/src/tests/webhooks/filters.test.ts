import { getTestPrincipalToken, testOrgId } from "../utils/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TEST_SERVICE } from "../utils/testService.js";
import { prisma } from "../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestOrgId,
  generateUniqueId,
  getTestAccessToken,
  createTestEventType,
  cleanupTestEntities,
  createTestWebhookEndpoint,
  PaginatedResponse,
  WebhookDeliveryResponse,
  WebhookEndpointResponse,
} from "./utils/test-helpers.js";

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

const listEndpoints = (query: string, token: string, headers = {}) =>
  get<PaginatedResponse<WebhookEndpointResponse>>(
    `/webhooks?limit=100&${query}`,
    token,
    headers
  );

const ids = (res: { data: { data: { id: string }[] } }) =>
  res.data.data.map((r) => r.id);

describe("Webhook list filters and fields", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("GET /webhooks/:id/deliveries — createdAt range", () => {
    let endpointId: string;
    let before: Date;

    beforeAll(async () => {
      const et = await createTestEventType(token);
      const ep = await createTestWebhookEndpoint(token, {
        eventTypes: [et.eventType],
      });
      endpointId = ep.id;
      before = new Date(Date.now() - 60_000);
      const emitted = await axios.post(
        `${BASE_URL}/events`,
        {
          organizationId: getTestOrgId(),
          eventType: et.eventType,
          entityType: "TestEntity",
          entityId: `test-entity-${generateUniqueId()}`,
          data: {},
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(emitted.status).toBe(HTTP_STATUS.ACCEPTED);
    });

    const deliveries = (query: string) =>
      get<PaginatedResponse<WebhookDeliveryResponse>>(
        `/webhooks/${endpointId}/deliveries?${query}`,
        token
      );

    it("includes deliveries inside the window", async () => {
      const after = new Date(Date.now() + 60_000);
      const res = await deliveries(
        `filter[createdAt_gte]=${before.toISOString()}&filter[createdAt_lte]=${after.toISOString()}`
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.data.length).toBe(1);
    });

    it("excludes deliveries outside the window", async () => {
      const later = await deliveries(
        `filter[createdAt_gte]=${new Date(Date.now() + 3_600_000).toISOString()}`
      );
      expect(later.status).toBe(HTTP_STATUS.OK);
      expect(later.data.data).toEqual([]);

      const earlier = await deliveries(
        `filter[createdAt_lte]=${before.toISOString()}`
      );
      expect(earlier.status).toBe(HTTP_STATUS.OK);
      expect(earlier.data.data).toEqual([]);
    });

    it("returns 400 for an invalid date or an equality filter", async () => {
      const invalid = await deliveries("filter[createdAt_gte]=not-a-date");
      expect(invalid.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const equals = await deliveries(
        `filter[createdAt]=${before.toISOString()}`
      );
      expect(equals.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("GET /webhooks — description, eventType and archived", () => {
    const tag = generateUniqueId();
    let subscribed: WebhookEndpointResponse;
    let other: WebhookEndpointResponse;
    let archived: WebhookEndpointResponse;
    let eventType: string;

    beforeAll(async () => {
      eventType = (
        await createTestEventType(token, {
          eventType: `test.filters.${tag}.created`,
        })
      ).eventType;
      subscribed = await createTestWebhookEndpoint(token, {
        description: `Billing sync ${tag}`,
        eventTypes: [eventType],
      });
      other = await createTestWebhookEndpoint(token, {
        description: `Inventory ${tag}`,
      });
      archived = await createTestWebhookEndpoint(token, {
        description: `Archived ${tag}`,
        eventTypes: [eventType],
      });
      const res = await axios.post(
        `${BASE_URL}/webhooks/${archived.id}/archive`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
    });

    it("searches description case-insensitively", async () => {
      const res = await listEndpoints(
        `filter[description]=billing SYNC ${tag}&filter[description_op]=contains`,
        token
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(ids(res)).toEqual([subscribed.id]);
    });

    it("filters by an exact subscribed event type", async () => {
      const res = await listEndpoints(`filter[eventType]=${eventType}`, token);
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(ids(res)).toEqual([subscribed.id]);
    });

    it("searches subscribed event types", async () => {
      const res = await listEndpoints(
        `filter[eventType]=FILTERS.${tag}&filter[eventType_op]=contains&includeArchived=true`,
        token
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(ids(res).sort()).toEqual([subscribed.id, archived.id].sort());
      expect(ids(res)).not.toContain(other.id);
    });

    it("filter[archived]=true lists only archived endpoints", async () => {
      const res = await listEndpoints(
        `filter[archived]=true&filter[description]=${tag}&filter[description_op]=contains`,
        token
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(ids(res)).toEqual([archived.id]);
    });

    it("filter[archived]=false lists only unarchived endpoints, even with includeArchived", async () => {
      const res = await listEndpoints(
        `filter[archived]=false&includeArchived=true&filter[description]=${tag}&filter[description_op]=contains`,
        token
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(ids(res).sort()).toEqual([subscribed.id, other.id].sort());
    });

    it("still honours includeArchived", async () => {
      const without = await listEndpoints(
        `filter[description]=${tag}&filter[description_op]=contains`,
        token
      );
      expect(ids(without)).not.toContain(archived.id);

      const withArchived = await listEndpoints(
        `includeArchived=true&filter[description]=${tag}&filter[description_op]=contains`,
        token
      );
      expect(ids(withArchived)).toHaveLength(3);
    });

    it("returns 400 for a non-boolean archived filter", async () => {
      const res = await listEndpoints("filter[archived]=maybe", token);
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
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
      expect(onlyRetired.data.data.map((e) => e.eventType)).toEqual([retired]);

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

  describe("X-Organization-ID", () => {
    const otherOrg = testOrgId("other-org-1");
    let ownEndpoint: WebhookEndpointResponse;
    let otherEndpoint: WebhookEndpointResponse;

    beforeAll(async () => {
      ownEndpoint = await createTestWebhookEndpoint(token);
      const otherToken = await getTestAccessToken(undefined, "other-org-1");
      otherEndpoint = await createTestWebhookEndpoint(otherToken);
    });

    it("lets webhooks.admin read another organization's endpoints", async () => {
      const res = await listEndpoints("", token, {
        "X-Organization-ID": otherOrg,
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(ids(res)).toContain(otherEndpoint.id);
      expect(ids(res)).not.toContain(ownEndpoint.id);

      const one = await get<WebhookEndpointResponse>(
        `/webhooks/${otherEndpoint.id}`,
        token,
        { "X-Organization-ID": otherOrg }
      );
      expect(one.status).toBe(HTTP_STATUS.OK);
    });

    it("is ignored for callers without webhooks.admin", async () => {
      const writer = await getTestPrincipalToken({
        organizationId: getTestOrgId(),
        permissions: ["webhooks.write"],
      });

      const res = await listEndpoints("", writer, {
        "X-Organization-ID": otherOrg,
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(ids(res)).toContain(ownEndpoint.id);
      expect(ids(res)).not.toContain(otherEndpoint.id);

      const one = await get(`/webhooks/${otherEndpoint.id}`, writer, {
        "X-Organization-ID": otherOrg,
      });
      expect(one.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("returns 400 for a malformed id and 404 for an unknown organization", async () => {
      const malformed = await listEndpoints("", token, {
        "X-Organization-ID": "not-a-uuid",
      });
      expect(malformed.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const unknown = await listEndpoints("", token, {
        "X-Organization-ID": "00000000-0000-7002-ffff-000000000000",
      });
      expect(unknown.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });
});
