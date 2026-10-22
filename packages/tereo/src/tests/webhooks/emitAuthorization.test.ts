import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPrincipalToken } from "../support/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  createTestEventType,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  cleanupTestEntities,
  generateUniqueId,
} from "../support/webhooks.js";

const OTHER_ORG = "00000000-0000-7002-8000-000000000001";

describe("Who may emit an event", () => {
  let adminToken: string;

  const post = (token: string, path: string, data: unknown) =>
    axios.post(`${BASE_URL}${path}`, data, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

  const event = (
    eventType: string,
    extra: { organizationId?: string; idempotencyKey?: string } = {}
  ) => ({
    organizationId: getTestOrgId(),
    eventType,
    entityType: "TestEntity",
    entityId: `entity-${generateUniqueId()}`,
    data: { k: "v" },
    ...extra,
  });

  const deliveriesTo = (webhookEndpointId: string) =>
    prisma.webhookDelivery.count({ where: { webhookEndpointId } });

  beforeAll(async () => {
    adminToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("refuses an organization-bound caller emitting into another organization", async () => {
    const et = await createTestEventType();
    const emitter = await getTestPrincipalToken({
      organizationId: getTestOrgId(),
      permissions: ["webhooks.emit"],
    });

    for (const [path, body] of [
      ["/events", event(et.eventType, { organizationId: OTHER_ORG })],
      [
        "/events/batch",
        {
          events: [
            event(et.eventType),
            event(et.eventType, { organizationId: OTHER_ORG }),
          ],
        },
      ],
    ] as const) {
      const res = await post(emitter, path, body);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.data.error_description).toContain("another organization");
    }
    expect(
      await prisma.webhookDelivery.count({ where: { eventType: et.eventType } })
    ).toBe(0);
  });

  it("refuses a caller that is neither the declaring service nor webhooks.admin", async () => {
    const ep = await createTestWebhookEndpoint(adminToken);
    const emitter = await getTestPrincipalToken({
      organizationId: getTestOrgId(),
      permissions: ["webhooks.emit"],
    });

    const res = await post(emitter, "/events", event(ep.eventTypes[0]));
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await deliveriesTo(ep.id)).toBe(0);
  });

  it("refuses core's own event types over HTTP, even for webhooks.admin", async () => {
    const coreType = "auth.organization.created";
    const ep = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(),
      {
        eventTypes: [coreType],
      }
    );

    const single = await post(adminToken, "/events", event(coreType));
    expect(single.status).toBe(HTTP_STATUS.FORBIDDEN);
    const batch = await post(adminToken, "/events/batch", {
      events: [event(coreType)],
    });
    expect(batch.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await deliveriesTo(ep.id)).toBe(0);
  });

  it("scopes an idempotency key to its caller, so another can't pre-empt it", async () => {
    const ep = await createTestWebhookEndpoint(adminToken);
    const otherAdmin = await getTestPrincipalToken({
      organizationId: getTestOrgId(),
      permissions: ["webhooks.admin"],
    });
    const key = `idem-${generateUniqueId()}`;

    const first = await post(
      otherAdmin,
      "/events",
      event(ep.eventTypes[0], { idempotencyKey: key })
    );
    expect(first.status).toBe(HTTP_STATUS.ACCEPTED);
    const second = await post(
      adminToken,
      "/events",
      event(ep.eventTypes[0], { idempotencyKey: key })
    );
    expect(second.status).toBe(HTTP_STATUS.ACCEPTED);
    expect(second.data.deliveriesCreated).toBe(1);
    expect(await deliveriesTo(ep.id)).toBe(2);
  });
});
