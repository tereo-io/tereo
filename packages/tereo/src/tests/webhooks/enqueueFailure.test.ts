import { retryDelivery } from "../../routes/v1/webhooks/webhooks/webhook/deliveries/delivery/controllers.js";
import { bulkRetryDeliveries } from "../../routes/v1/webhooks/webhooks/webhook/deliveries/controllers.js";
import { testWebhookEndpoint } from "../../routes/v1/webhooks/webhooks/webhook/controllers.js";
import { getWebhookDeliveryQueue } from "../../jobs/webhookQueues.js";
import { prisma } from "../../utils/db/prisma.js";
import type { Request, Response } from "express";
import {
  getTestAccessToken,
  getTestOrgId,
  getTestUserId,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "./utils/test-helpers.js";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";

/** A request as the auth and organization middleware leave it. */
const request = (params: Record<string, string>, body: unknown = {}) =>
  ({
    auth: {
      userId: getTestUserId(),
      email: null,
      permissions: ["webhooks.admin"],
    },
    organizationId: getTestOrgId(),
    params,
    body,
    query: {},
  }) as unknown as Request;

const response = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
};

// Redis refusing the job after the delivery committed: the request must still
// succeed, or the client retries and the delivery is written twice. The
// stale-delivery sweep queues it later.
describe("Enqueue failure after the delivery commits", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const failEnqueue = () =>
    vi
      .spyOn(getWebhookDeliveryQueue(), "add")
      .mockRejectedValue(new Error("redis went away"));

  const failedDelivery = async (webhookEndpointId: string, eventType: string) =>
    prisma.webhookDelivery.create({
      data: {
        webhookEndpointId,
        eventType,
        payload: { n: 1 },
        status: "FAILED",
        attempts: 10,
        lastAttemptAt: new Date(),
        completedAt: new Date(),
      },
    });

  it("test send returns 202 and writes one delivery", async () => {
    const ep = await createTestWebhookEndpoint(token);
    const add = failEnqueue();
    const res = response();

    await testWebhookEndpoint(
      request({ id: ep.id }),
      res as unknown as Response
    );

    expect(add).toHaveBeenCalled();
    expect(res.statusCode).toBe(202);
    const { deliveryId } = res.body as { deliveryId: string };
    const rows = await prisma.webhookDelivery.findMany({
      where: { webhookEndpointId: ep.id },
    });
    expect(rows.map((r) => r.id)).toEqual([deliveryId]);
    expect(rows[0].status).toBe("PENDING");
  });

  it("retry one returns 202 with the delivery reset to PENDING", async () => {
    const ep = await createTestWebhookEndpoint(token);
    const delivery = await failedDelivery(ep.id, ep.eventTypes[0]);
    failEnqueue();
    const res = response();

    await retryDelivery(
      request({ id: ep.id, deliveryId: delivery.id }),
      res as unknown as Response
    );

    expect(res.statusCode).toBe(202);
    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { id: delivery.id },
    });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    // Counts as never attempted, so the sweep's short threshold applies.
    expect(row.lastAttemptAt).toBeNull();
  });

  it("bulk retry returns 202 with every delivery reset", async () => {
    const ep = await createTestWebhookEndpoint(token);
    await failedDelivery(ep.id, ep.eventTypes[0]);
    await failedDelivery(ep.id, ep.eventTypes[0]);
    failEnqueue();
    const res = response();

    await bulkRetryDeliveries(
      request({ id: ep.id }, { limit: 100 }),
      res as unknown as Response
    );

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ retriedCount: 2 });
    const pending = await prisma.webhookDelivery.count({
      where: { webhookEndpointId: ep.id, status: "PENDING" },
    });
    expect(pending).toBe(2);
  });
});
