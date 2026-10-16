import { emitTx, PermanentDispatchError } from "../../utils/outbox.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dispatchOutboxEvent } from "../../utils/processEvent.js";
import { TEST_SERVICE } from "../utils/testService.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { fetchJson } from "../utils/http.js";
import { randomUUID } from "crypto";
import {
  cleanup,
  createIntegration,
  grant,
  integrationToken,
  readableEventType,
  revoke,
  type TestIntegration,
} from "./utils/integrations.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";

// An event addressed to `recipients` (service or integration slugs) goes
// only to endpoints those recipients own, each still gated by its owner's
// read permission.

const ROLLBACK = new Error("rollback");

let adminToken: string;
let emitterToken: string;
let org: string;
let readable: { eventType: string; readPermission: string };

let a: TestIntegration;
let b: TestIntegration;
let platform: TestIntegration;
let aEndpoint: string;
let bEndpoint: string;
let platformEndpoint: string;
let humanEndpoint: string;

const createEndpoint = async (token: string, eventTypes: string[]) => {
  const res = await fetchJson(
    "POST",
    `${CORE_URL}/v1/webhooks/webhooks`,
    token,
    { url: `https://example.com/hooks/${randomUUID()}`, eventTypes }
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

const event = (recipients?: string[]) => ({
  organizationId: org,
  eventType: readable.eventType,
  entityType: "Item",
  entityId: randomUUID(),
  data: { n: 1 },
  ...(recipients && { recipients }),
});

const deliveriesOf = async (entityId: string) =>
  prisma.webhookDelivery.findMany({
    where: { payload: { path: ["entityId"], equals: entityId } },
    select: { webhookEndpointId: true, payload: true },
  });

/** Emits over HTTP; the endpoints the event was delivered to. */
const emit = async (recipients?: string[]) => {
  const body = event(recipients);
  const res = await fetchJson(
    "POST",
    `${CORE_URL}/v1/webhooks/events`,
    emitterToken,
    body
  );
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const deliveries = await deliveriesOf(body.entityId);
  expect(res.body.deliveriesCreated).toBe(deliveries.length);
  return deliveries;
};

const endpointsOf = (deliveries: { webhookEndpointId: string }[]) =>
  deliveries.map((d) => d.webhookEndpointId).sort();

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: ["integrations.read", "integrations.write"],
  });
  emitterToken = await getTestPrincipalToken({
    permissions: ["webhooks.admin"],
  });
  org = await ensureTestOrganization("addressed-events");
  readable = await readableEventType();

  a = await createIntegration(adminToken, org);
  b = await createIntegration(adminToken, org);
  platform = await createIntegration(adminToken);
  for (const integration of [a, b, platform]) {
    await grant(integration, [readable.readPermission]);
  }
  aEndpoint = await createEndpoint(await integrationToken(a), [
    readable.eventType,
  ]);
  bEndpoint = await createEndpoint(await integrationToken(b), [
    readable.eventType,
  ]);
  platformEndpoint = await createEndpoint(await integrationToken(platform), [
    readable.eventType,
  ]);
  humanEndpoint = await createEndpoint(
    await getTestPrincipalToken({
      organizationId: org,
      permissions: ["webhooks.write", readable.readPermission],
    }),
    [readable.eventType]
  );
});

afterAll(async () => {
  await cleanup();
});

describe("addressed events over HTTP", () => {
  it("delivers only to the named recipient's endpoints", async () => {
    const deliveries = await emit([a.slug]);
    expect(endpointsOf(deliveries)).toEqual([aEndpoint]);
    expect(deliveries[0].payload).toMatchObject({ recipients: [a.slug] });
  });

  it("delivers to every named recipient, all-organization endpoints included", async () => {
    const deliveries = await emit([a.slug, platform.slug]);
    expect(endpointsOf(deliveries)).toEqual(
      [aEndpoint, platformEndpoint].sort()
    );
  });

  it("stores recipients sorted and without repeats", async () => {
    const deliveries = await emit([platform.slug, a.slug, platform.slug]);
    expect(endpointsOf(deliveries)).toEqual(
      [aEndpoint, platformEndpoint].sort()
    );
    for (const delivery of deliveries) {
      expect(delivery.payload).toMatchObject({
        recipients: [a.slug, platform.slug].sort(),
      });
    }
  });

  it("delivers nothing to a recipient that may not read the event", async () => {
    const d = await createIntegration(adminToken, org);
    const { roleId } = await grant(d, [readable.readPermission]);
    const dEndpoint = await createEndpoint(await integrationToken(d), [
      readable.eventType,
    ]);
    expect(endpointsOf(await emit([d.slug]))).toEqual([dEndpoint]);

    await revoke(d, roleId);
    expect(await emit([d.slug])).toEqual([]);
  });

  it("accepts a known recipient with no endpoints", async () => {
    expect(await emit([TEST_SERVICE.slug])).toEqual([]);
  });

  it("refuses an unknown recipient", async () => {
    const res = await fetchJson(
      "POST",
      `${CORE_URL}/v1/webhooks/events`,
      emitterToken,
      event([a.slug, `nope-${randomUUID()}`])
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_recipient");

    const batch = await fetchJson(
      "POST",
      `${CORE_URL}/v1/webhooks/events/batch`,
      emitterToken,
      { events: [event([a.slug]), event([`nope-${randomUUID()}`])] }
    );
    expect(batch.status).toBe(400);
  });

  it("refuses more than 50 recipients", async () => {
    const res = await fetchJson(
      "POST",
      `${CORE_URL}/v1/webhooks/events`,
      emitterToken,
      event(Array.from({ length: 51 }, (_, i) => `r-${i}`))
    );
    expect(res.status).toBe(400);
  });

  it("leaves unaddressed events as they were", async () => {
    const deliveries = await emit();
    expect(endpointsOf(deliveries)).toEqual(
      [aEndpoint, bEndpoint, platformEndpoint, humanEndpoint].sort()
    );
    expect(deliveries[0].payload).not.toHaveProperty("recipients");
  });
});

describe("addressed events through the outbox", () => {
  it("keeps emitTx's recipients through dispatch", async () => {
    const eventType = "core.integration.updated";
    const reader = await createIntegration(adminToken);
    const other = await createIntegration(adminToken);
    const endpoints: string[] = [];
    for (const integration of [reader, other]) {
      await grant(integration, ["integrations.read"]);
      endpoints.push(
        await createEndpoint(await integrationToken(integration), [eventType])
      );
    }

    // Read back inside the transaction, then roll it back, so the server's
    // reaper never sees the row.
    const entityId = randomUUID();
    let payload: unknown;
    await prisma
      .$transaction(async (tx) => {
        await emitTx(tx, {
          organizationId: org,
          eventType,
          entityType: "Integration",
          entityId,
          data: {},
          recipients: [reader.slug],
        });
        payload = (
          await tx.outbox.findFirstOrThrow({
            where: { payload: { path: ["entityId"], equals: entityId } },
          })
        ).payload;
        throw ROLLBACK;
      })
      .catch((err) => {
        if (err !== ROLLBACK) throw err;
      });
    expect(payload).toMatchObject({ recipients: [reader.slug] });

    await dispatchOutboxEvent(payload, randomUUID(), new Date());
    expect(endpointsOf(await deliveriesOf(entityId))).toEqual([endpoints[0]]);
  });

  it("dead-letters a row naming an unknown recipient", async () => {
    await expect(
      dispatchOutboxEvent(
        event([`nope-${randomUUID()}`]),
        randomUUID(),
        new Date()
      )
    ).rejects.toBeInstanceOf(PermanentDispatchError);
  });
});
