import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PermanentDispatchError } from "../../utils/outbox.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { getRedisClient } from "../../utils/redis.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  dispatchOutboxEvent,
  emitWithIdempotency,
} from "../../utils/processEvent.js";
import {
  getTestAccessToken,
  getTestOrgId,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../support/webhooks.js";

describe("Outbox webhook dispatcher", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const event = (eventType: string) => ({
    organizationId: getTestOrgId(),
    eventType,
    entityType: "TestEntity",
    entityId: crypto.randomUUID(),
    data: { k: "v" },
  });

  it("fans an event out once per row id", async () => {
    const ep = await createTestWebhookEndpoint(token);
    const rowId = crypto.randomUUID();
    const payload = event(ep.eventTypes[0]);

    await dispatchOutboxEvent(payload, rowId, new Date());
    await dispatchOutboxEvent(payload, rowId, new Date());

    const count = await prisma.webhookDelivery.count({
      where: { webhookEndpointId: ep.id },
    });
    expect(count).toBe(1);
  });

  it("stamps occurredAt with when the event was written, not dispatched", async () => {
    const ep = await createTestWebhookEndpoint(token);
    const payload = event(ep.eventTypes[0]);
    const writtenAt = new Date(Date.now() - 60 * 60 * 1000);

    await dispatchOutboxEvent(payload, crypto.randomUUID(), writtenAt);

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { webhookEndpointId: ep.id },
    });
    expect((delivery.payload as { occurredAt: string }).occurredAt).toBe(
      writtenAt.toISOString()
    );
  });

  it("fans an event out once when its result was never cached", async () => {
    // A crash between the fan-out's commit and anything after it leaves the
    // row to be claimed again, with no trace in Redis.
    const ep = await createTestWebhookEndpoint(token);
    const rowId = crypto.randomUUID();
    const payload = event(ep.eventTypes[0]);
    const redis = getRedisClient();
    const forget = async () => {
      const keys = await redis.keys(`webhook-service:idempotency:*:${rowId}`);
      if (keys.length > 0) await redis.del(...keys);
    };

    await dispatchOutboxEvent(payload, rowId, new Date());
    await forget();
    await dispatchOutboxEvent(payload, rowId, new Date());

    expect(
      await prisma.webhookDelivery.count({
        where: { webhookEndpointId: ep.id },
      })
    ).toBe(1);
    expect(
      await prisma.webhookOutboxFanout.count({ where: { outboxId: rowId } })
    ).toBe(1);
  });

  it("fans an event out once when two workers dispatch it at the same time", async () => {
    const ep = await createTestWebhookEndpoint(token);
    const rowId = crypto.randomUUID();
    const payload = event(ep.eventTypes[0]);

    const outcomes = await Promise.allSettled([
      dispatchOutboxEvent(payload, rowId, new Date()),
      dispatchOutboxEvent(payload, rowId, new Date()),
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(
      await prisma.webhookDelivery.count({
        where: { webhookEndpointId: ep.id },
      })
    ).toBe(1);
  });

  it("completes a row already fanned out whose event type was retired since", async () => {
    const ep = await createTestWebhookEndpoint(token);
    const rowId = crypto.randomUUID();
    const payload = event(ep.eventTypes[0]);
    await dispatchOutboxEvent(payload, rowId, new Date());
    await prisma.eventType.update({
      where: { eventType: ep.eventTypes[0] },
      data: { retiredAt: new Date() },
    });

    await expect(
      dispatchOutboxEvent(payload, rowId, new Date())
    ).resolves.toBeUndefined();
  });

  it("treats a malformed payload as permanent", async () => {
    await expect(
      dispatchOutboxEvent({ eventType: "x" }, crypto.randomUUID(), new Date())
    ).rejects.toBeInstanceOf(PermanentDispatchError);
  });

  it("treats a retired or unregistered event type as permanent", async () => {
    const et = await createTestEventType(token);
    await prisma.eventType.update({
      where: { eventType: et.eventType },
      data: { retiredAt: new Date() },
    });

    await expect(
      dispatchOutboxEvent(event(et.eventType), crypto.randomUUID(), new Date())
    ).rejects.toThrow(/event_type_retired/);
    await expect(
      dispatchOutboxEvent(
        event("never.registered"),
        crypto.randomUUID(),
        new Date()
      )
    ).rejects.toBeInstanceOf(PermanentDispatchError);
  });

  it("holds an emit's idempotency key only briefly while its request runs", async () => {
    // A process that dies mid-request never releases its claim; one held for
    // the whole 24h result TTL would 409 every retry for a day.
    const redis = getRedisClient();
    const del = vi
      .spyOn(redis, "del")
      .mockRejectedValueOnce(new Error("process died"));
    const key = crypto.randomUUID();
    const ev = { ...event("never.registered.claim"), idempotencyKey: key };
    try {
      await expect(
        emitWithIdempotency(ev, { userId: SYSTEM_USER_ID, email: null })
      ).rejects.toThrow();
    } finally {
      del.mockRestore();
    }

    const ttl = await redis.ttl(
      `webhook-service:idempotency:${SYSTEM_USER_ID}:${ev.organizationId}:${ev.eventType}:${key}`
    );
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});
