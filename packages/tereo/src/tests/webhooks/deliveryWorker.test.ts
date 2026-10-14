import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WEBHOOK_DELIVERY_ATTEMPTS } from "../../jobs/webhookQueues.js";
import { createPinnedDispatcher } from "../../utils/ssrfGuard.js";
import { currentSealPrefix } from "../../utils/sealedSecrets.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { createHmac } from "crypto";
import http from "http";
import {
  AUTO_DISABLE_THRESHOLD,
  MAX_RESPONSE_BODY_BYTES,
  processWebhookDelivery,
  SECRET_UNAVAILABLE,
} from "../../jobs/webhookDelivery.js";
import {
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "./utils/test-helpers.js";

type Received = {
  headers: http.IncomingHttpHeaders;
  body: string;
};

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

// The worker's real guard refuses loopback, so these tests connect through a
// dispatcher pinned to the local receiver instead.
const toLocalReceiver = async () =>
  createPinnedDispatcher([{ address: "127.0.0.1", family: 4 }]);

const LAST_ATTEMPT = WEBHOOK_DELIVERY_ATTEMPTS - 1;

describe("Webhook delivery worker", () => {
  let server: http.Server;
  let port: number;
  let received: Received[];
  let handler: Handler;
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
        handler(req, res);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupTestEntities();
  });

  beforeEach(() => {
    received = [];
    handler = (_req, res) => res.writeHead(200).end("ok");
  });

  /** An endpoint pointed at the local receiver, and a pending delivery to it. */
  const setup = async (
    options: { customHeaders?: Record<string, string> } = {}
  ) => {
    const ep = await createTestWebhookEndpoint(token);
    const endpoint = await prisma.webhookEndpoint.update({
      where: { id: ep.id },
      data: {
        // Written directly: registration refuses a loopback URL.
        url: `http://127.0.0.1:${port}/hook`,
        customHeaders: options.customHeaders,
      },
    });
    const delivery = await db.webhookDeliveries.create({
      webhookEndpointId: ep.id,
      eventType: ep.eventTypes[0],
      payload: {
        id: crypto.randomUUID(),
        eventType: ep.eventTypes[0],
        data: { b: 1, "10": 2, text: "é" },
      },
    });
    // The stored secret is sealed; the plaintext is the one create returned.
    return { endpoint, delivery, signingSecret: ep.signingSecret };
  };

  /** One job run, for a delivery with `priorAttempts` already made. */
  const run = async (deliveryId: string, priorAttempts = 0) => {
    if (priorAttempts > 0) {
      await prisma.webhookDelivery.updateMany({
        where: { id: deliveryId },
        data: { attempts: priorAttempts, lastAttemptAt: new Date() },
      });
    }
    return processWebhookDelivery(
      { data: { deliveryId } },
      { connectTarget: toLocalReceiver }
    );
  };

  const deliveryRow = (id: string) =>
    prisma.webhookDelivery.findFirstOrThrow({ where: { id } });

  it("sends the signed payload and marks the delivery SUCCESS", async () => {
    const { delivery, signingSecret } = await setup();

    await run(delivery.id);

    expect(received).toHaveLength(1);
    const [{ headers, body }] = received;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-webhook-id"]).toBe(delivery.id);
    expect(headers["x-webhook-event"]).toBe(delivery.eventType);
    const timestamp = headers["x-webhook-timestamp"] as string;
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(10);
    const expected = createHmac("sha256", signingSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    expect(headers["x-webhook-signature"]).toBe(`sha256=${expected}`);
    expect(JSON.parse(body)).toEqual(delivery.payload);

    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("SUCCESS");
    expect(row.attempts).toBe(1);
    expect(row.httpStatus).toBe(200);
    expect(row.responseBody).toBe("ok");
    expect(row.completedAt).not.toBeNull();
  });

  it("signs with both secrets during a rotation overlap", async () => {
    const { endpoint, delivery, signingSecret } = await setup();
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        previousSigningSecret: "a".repeat(64),
        previousSecretExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    await run(delivery.id);

    const [{ headers, body }] = received;
    const timestamp = headers["x-webhook-timestamp"] as string;
    const sign = (secret: string) =>
      `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
    expect(headers["x-webhook-signature"]).toBe(
      `${sign(signingSecret)},${sign("a".repeat(64))}`
    );
  });

  it("sends custom headers but never lets them replace core's", async () => {
    const { delivery } = await setup({
      customHeaders: {
        Authorization: "Bearer receiver-token",
        "X-Webhook-Signature": "forged",
      },
    });

    await run(delivery.id);

    const [{ headers }] = received;
    expect(headers.authorization).toBe("Bearer receiver-token");
    expect(headers["x-webhook-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("keeps only the first bytes of a large response, without NULs", async () => {
    const { delivery } = await setup();
    handler = (_req, res) =>
      res
        .writeHead(200)
        .end("\u0000" + "x".repeat(MAX_RESPONSE_BODY_BYTES * 50));

    await run(delivery.id);

    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("SUCCESS");
    expect(row.responseBody).toBe("x".repeat(MAX_RESPONSE_BODY_BYTES - 1));
  });

  it("leaves a non-2xx delivery PENDING and throws so BullMQ retries", async () => {
    const { endpoint, delivery } = await setup();
    handler = (_req, res) => res.writeHead(503).end("busy");

    await expect(run(delivery.id)).rejects.toThrow(/HTTP 503/);

    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.httpStatus).toBe(503);
    expect(row.responseBody).toBe("busy");
    expect(row.completedAt).toBeNull();
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });
    expect(ep.consecutiveFailures).toBe(0);
  });

  it("does not follow a redirect", async () => {
    const { delivery } = await setup();
    handler = (_req, res) =>
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/other` }).end();

    await expect(run(delivery.id)).rejects.toThrow(/HTTP 302/);

    expect(received).toHaveLength(1);
    expect((await deliveryRow(delivery.id)).httpStatus).toBe(302);
  });

  it("marks the last failed attempt FAILED and counts it against the endpoint", async () => {
    const { endpoint, delivery } = await setup();
    handler = (_req, res) => res.writeHead(500).end();

    await run(delivery.id, LAST_ATTEMPT);

    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("FAILED");
    expect(row.completedAt).not.toBeNull();
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });
    expect(ep.consecutiveFailures).toBe(1);
    expect(ep.status).toBe("ACTIVE");
  });

  describe("when the signing secret cannot be opened", () => {
    const breakSecret = (endpointId: string) =>
      prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { signingSecret: `${currentSealPrefix()}not-a-sealed-value` },
      });

    it("records a failed attempt, leaves it PENDING and throws", async () => {
      const { endpoint, delivery } = await setup();
      await breakSecret(endpoint.id);

      await expect(run(delivery.id)).rejects.toThrow(SECRET_UNAVAILABLE);

      expect(received).toHaveLength(0);
      const row = await deliveryRow(delivery.id);
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
      expect(row.errorMessage).toBe(SECRET_UNAVAILABLE);
      expect(row.lastAttemptAt).not.toBeNull();
    });

    it("fails the delivery on the last attempt", async () => {
      const { endpoint, delivery } = await setup();
      await breakSecret(endpoint.id);

      await run(delivery.id, LAST_ATTEMPT);

      const row = await deliveryRow(delivery.id);
      expect(row.status).toBe("FAILED");
      expect(row.attempts).toBe(WEBHOOK_DELIVERY_ATTEMPTS);
      expect(row.errorMessage).toBe(SECRET_UNAVAILABLE);
      // Core's fault, not the receiver's: not counted toward auto-disable.
      const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: endpoint.id },
      });
      expect(ep.consecutiveFailures).toBe(0);
    });
  });

  it("counts attempts on the delivery, so a re-queued job adds none", async () => {
    const { delivery } = await setup();
    handler = (_req, res) => res.writeHead(500).end();

    // Nine attempts made under an earlier job; the sweep's new job is on its
    // first BullMQ attempt, but this is the delivery's tenth and last.
    await run(delivery.id, LAST_ATTEMPT);

    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(WEBHOOK_DELIVERY_ATTEMPTS);
    expect(received).toHaveLength(1);
  });

  it("fails a delivery whose attempts are already spent, without sending it", async () => {
    const { delivery } = await setup();

    await run(delivery.id, WEBHOOK_DELIVERY_ATTEMPTS);

    expect(received).toHaveLength(0);
    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(WEBHOOK_DELIVERY_ATTEMPTS);
    expect(row.completedAt).not.toBeNull();
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: delivery.webhookEndpointId },
    });
    expect(ep.consecutiveFailures).toBe(1);
  });

  it("counts a spent delivery once, however many jobs run for it", async () => {
    const { endpoint, delivery } = await setup();

    await prisma.webhookDelivery.updateMany({
      where: { id: delivery.id },
      data: { attempts: WEBHOOK_DELIVERY_ATTEMPTS, lastAttemptAt: new Date() },
    });
    // Concurrent, so every job reads the delivery PENDING and reaches the
    // write; only the one whose write applies counts the failure.
    await Promise.all(Array.from({ length: 4 }, () => run(delivery.id)));

    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });
    expect(ep.consecutiveFailures).toBe(1);
  });

  /** A receiver that, mid-attempt, has another job settle the delivery FAILED. */
  const settledMeanwhile = (deliveryId: string, status: number) => {
    handler = (_req, res) => {
      void prisma.webhookDelivery
        .updateMany({
          where: { id: deliveryId },
          data: {
            status: "FAILED",
            attempts: WEBHOOK_DELIVERY_ATTEMPTS,
            completedAt: new Date(),
          },
        })
        .then(() => res.writeHead(status).end());
    };
  };

  it("does not overwrite a delivery another job settled during the attempt with SUCCESS", async () => {
    const { endpoint, delivery } = await setup();
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { consecutiveFailures: 3 },
    });
    settledMeanwhile(delivery.id, 200);

    await run(delivery.id);

    expect(received).toHaveLength(1);
    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("FAILED");
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });
    expect(ep.consecutiveFailures).toBe(3);
  });

  it("does not reopen a delivery another job settled during the attempt", async () => {
    const { delivery } = await setup();
    settledMeanwhile(delivery.id, 500);

    await run(delivery.id);

    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(WEBHOOK_DELIVERY_ATTEMPTS);
  });

  it("disables the endpoint at the threshold from a spent delivery", async () => {
    const { endpoint, delivery } = await setup();
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { consecutiveFailures: AUTO_DISABLE_THRESHOLD - 1 },
    });

    await run(delivery.id, WEBHOOK_DELIVERY_ATTEMPTS);

    expect(received).toHaveLength(0);
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });
    expect(ep.status).toBe("DISABLED");
    const audit = await prisma.auditLogEntry.findFirst({
      where: { entityId: endpoint.id, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.metadata).toMatchObject({ reason: "auto-disabled" });
  });

  it("disables the endpoint at the threshold, with an audit entry", async () => {
    const { endpoint, delivery } = await setup();
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { consecutiveFailures: AUTO_DISABLE_THRESHOLD - 1 },
    });
    handler = (_req, res) => res.writeHead(500).end();

    await run(delivery.id, LAST_ATTEMPT);

    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });
    expect(ep.status).toBe("DISABLED");
    const audit = await prisma.auditLogEntry.findFirst({
      where: { entityId: endpoint.id, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.metadata).toMatchObject({ reason: "auto-disabled" });
  });

  it("leaves an endpoint an admin paused meanwhile PAUSED", async () => {
    const { endpoint } = await setup();
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { status: "PAUSED" },
    });

    expect(await db.webhookEndpoints.deactivate(endpoint.id)).toBe(false);
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });
    expect(ep.status).toBe("PAUSED");
  });

  it("resets the failure count on a success", async () => {
    const { endpoint, delivery } = await setup();
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { consecutiveFailures: 3 },
    });

    await run(delivery.id);

    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpoint.id },
    });
    expect(ep.consecutiveFailures).toBe(0);
  });

  it("fails a delivery to a paused endpoint without sending it", async () => {
    const { endpoint, delivery } = await setup();
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { status: "PAUSED" },
    });

    await run(delivery.id);

    expect(received).toHaveLength(0);
    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toBe("Endpoint status is PAUSED");
  });

  it("does not send a delivery that is no longer PENDING", async () => {
    const { delivery } = await setup();
    await run(delivery.id);
    expect(received).toHaveLength(1);

    await run(delivery.id);

    expect(received).toHaveLength(1);
  });

  it("refuses a loopback target through the real guard", async () => {
    const { delivery } = await setup();

    await expect(
      processWebhookDelivery({ data: { deliveryId: delivery.id } })
    ).rejects.toThrow("Webhook delivery failed");

    expect(received).toHaveLength(0);
    const row = await deliveryRow(delivery.id);
    expect(row.status).toBe("PENDING");
    // Generic: the stored message must not reveal what a host resolved to.
    expect(row.errorMessage).toBe(
      "Target resolves to a private or reserved address"
    );
  });

  it("records a generic message for a host that does not resolve", async () => {
    const { delivery, endpoint } = await setup();
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { url: "http://no-such-host.invalid/hook" },
    });

    await expect(
      processWebhookDelivery({ data: { deliveryId: delivery.id } })
    ).rejects.toThrow("Webhook delivery failed");

    const row = await deliveryRow(delivery.id);
    expect(row.errorMessage).toBe("Target host could not be resolved");
  });

  it("records a generic message when the connection fails", async () => {
    const { delivery, endpoint } = await setup();
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { url: `http://127.0.0.1:${closedPort}/hook` },
    });

    await expect(run(delivery.id)).rejects.toThrow("Webhook delivery failed");

    const row = await deliveryRow(delivery.id);
    expect(row.errorMessage).toBe("Connection failed");
  });
});
