import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  type WebhookEndpointResponse,
} from "./utils/test-helpers.js";

// Input that reached Postgres and failed there with a 500.
describe("Webhook input Postgres cannot take", () => {
  let token: string;
  let endpoint: WebhookEndpointResponse;
  const cfg = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  beforeAll(async () => {
    token = await getTestAccessToken();
    endpoint = await createTestWebhookEndpoint(token);
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it.each([
    ["a NUL in filter[url]", "/webhooks?filter[url]=a%00"],
    ["a NUL in filter[description]", "/webhooks?filter[description]=%00"],
    ["a NUL in filter[eventType]", "/webhooks?filter[eventType]=%00"],
    ["a NUL in an event-type filter", "/event-types?filter[eventType]=%00"],
    ["a NUL in an event-type source", "/event-types?filter[source]=%00"],
    ["a NUL in an event-type path", "/event-types/a%00"],
    [
      "an event-type path over 100 characters",
      `/event-types/${"a".repeat(101)}`,
    ],
    [
      "a filter value over 500 characters",
      `/webhooks?filter[url]=${"u".repeat(501)}`,
    ],
  ])("refuses %s with a 400", async (_label, path) => {
    const res = await axios.get(`${BASE_URL}${path}`, cfg());
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it.each([
    ["a NUL in filter[eventType]", "filter[eventType]=%00"],
    [
      "a createdAt bound outside the years 1-9999",
      "filter[createdAt_gte]=-271821-04-20T00:00:00Z",
    ],
  ])("refuses %s on the delivery list with a 400", async (_label, query) => {
    const res = await axios.get(
      `${BASE_URL}/webhooks/${endpoint.id}/deliveries?${query}`,
      cfg()
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it.each([
    ["a NUL in eventType", { eventType: "a\u0000" }],
    ["a date outside the years 1-9999", { createdAfter: "-271821-04-20" }],
  ])("refuses %s in a bulk retry with a 400", async (_label, body) => {
    const res = await axios.post(
      `${BASE_URL}/webhooks/${endpoint.id}/deliveries/retry`,
      body,
      cfg()
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it.each([
    ["a NUL in the description", { description: "a\u0000" }],
    ["a NUL in an event type", { eventTypes: ["a\u0000"] }],
    ["a NUL in a custom header value", { customHeaders: { "X-A": "\u0000" } }],
    ["a CRLF in a custom header value", { customHeaders: { "X-A": "a\r\nb" } }],
    [
      "a character fetch cannot send in a custom header value",
      { customHeaders: { "X-A": "\u2603" } },
    ],
    [
      "more than 100 event types",
      { eventTypes: Array.from({ length: 101 }, (_, i) => `x.type-${i}`) },
    ],
  ])("refuses %s on create and update with a 400", async (_label, fields) => {
    const created = await axios.post(
      `${BASE_URL}/webhooks`,
      {
        url: "https://example.com/hook",
        eventTypes: endpoint.eventTypes,
        ...fields,
      },
      cfg()
    );
    expect(created.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const updated = await axios.patch(
      `${BASE_URL}/webhooks/${endpoint.id}`,
      fields,
      cfg()
    );
    expect(updated.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it.each([
    ["a NUL in eventType", { eventType: "a\u0000" }],
    ["a NUL in entityType", { entityType: "a\u0000" }],
    ["a NUL in entityId", { entityId: "a\u0000" }],
    ["a NUL in data", { data: { k: ["\u0000"] } }],
    ["a NUL in a data key", { data: { "k\u0000": 1 } }],
    ["an entityId over 500 characters", { entityId: "e".repeat(501) }],
    ["data over 256 KiB as JSON", { data: { k: "x".repeat(256 * 1024) } }],
  ])("refuses %s in an emitted event with a 400", async (_label, fields) => {
    const event = {
      organizationId: getTestOrgId(),
      eventType: endpoint.eventTypes[0],
      entityType: "InputEntity",
      entityId: crypto.randomUUID(),
      data: { k: "v" },
      ...fields,
    };
    const single = await axios.post(`${BASE_URL}/events`, event, cfg());
    expect(single.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const batch = await axios.post(
      `${BASE_URL}/events/batch`,
      { events: [event] },
      cfg()
    );
    expect(batch.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const deliveries = await prisma.webhookDelivery.count({
      where: { webhookEndpointId: endpoint.id },
    });
    expect(deliveries).toBe(0);
  });
});
