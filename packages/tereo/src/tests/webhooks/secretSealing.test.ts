import { currentSealPrefix, openRowSecret } from "../../utils/sealedSecrets.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { processWebhookDelivery } from "../../jobs/webhookDelivery.js";
import { createPinnedDispatcher } from "../../utils/ssrfGuard.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { createHmac } from "crypto";
import axios from "axios";
import http from "http";
import {
  endpointSecretName,
  sealWebhookSecrets,
} from "../../utils/webhookSecrets.js";
import {
  BASE_URL,
  HTTP_STATUS,
  WebhookEndpointResponse,
  cleanupTestEntities,
  createTestWebhookEndpoint,
  getTestAccessToken,
} from "../support/webhooks.js";

const toLocalReceiver = async () =>
  createPinnedDispatcher([{ address: "127.0.0.1", family: 4 }]);

describe("Webhook signing secrets at rest", () => {
  let server: http.Server;
  let port: number;
  let received: { signature: string; timestamp: string; body: string }[];
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({
          signature: req.headers["x-webhook-signature"] as string,
          timestamp: req.headers["x-webhook-timestamp"] as string,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
        res.writeHead(200).end("ok");
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
  });

  const stored = (id: string) =>
    prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });

  /** An endpoint pointed at the local receiver. */
  const localEndpoint = async () => {
    const ep = await createTestWebhookEndpoint(token);
    await prisma.webhookEndpoint.update({
      where: { id: ep.id },
      data: { url: `http://127.0.0.1:${port}/hook` },
    });
    return ep;
  };

  const deliverOnce = async (ep: WebhookEndpointResponse) => {
    const delivery = await db.webhookDeliveries.create({
      webhookEndpointId: ep.id,
      eventType: ep.eventTypes[0],
      payload: { id: crypto.randomUUID(), data: { a: 1 } },
    });
    await processWebhookDelivery(
      { data: { deliveryId: delivery.id } },
      { connectTarget: toLocalReceiver }
    );
    expect(received).toHaveLength(1);
    const [{ signature, timestamp, body }] = received;
    received = [];
    return {
      signatures: signature.split(","),
      sign: (secret: string) =>
        `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`,
    };
  };

  it("stores a new endpoint's secret sealed, and shows only its hint", async () => {
    const ep = await createTestWebhookEndpoint(token);
    const row = await stored(ep.id);

    expect(row.signingSecret.startsWith(currentSealPrefix())).toBe(true);
    expect(row.signingSecret).not.toContain(ep.signingSecret);
    expect(row.signingSecretHint).toBe(ep.signingSecret.slice(0, 8));
    const opened = await openRowSecret(
      endpointSecretName(ep.id),
      row.signingSecret
    );
    expect(opened).toEqual({ value: ep.signingSecret, resealed: null });

    const got = await axios.get(`${BASE_URL}/webhooks/${ep.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(got.data.signingSecret).toBe(ep.signingSecret.slice(0, 8) + "...");
    expect(got.data).not.toHaveProperty("signingSecretHint");
  });

  it("signs with a plaintext secret from before sealing, and seals it on use", async () => {
    const ep = await localEndpoint();
    const plaintext = "c".repeat(64);
    await prisma.webhookEndpoint.update({
      where: { id: ep.id },
      data: { signingSecret: plaintext, signingSecretHint: null },
    });

    const { signatures, sign } = await deliverOnce(ep);

    expect(signatures).toEqual([sign(plaintext)]);
    const row = await stored(ep.id);
    expect(row.signingSecret.startsWith(currentSealPrefix())).toBe(true);
    expect(row.signingSecretHint).toBe("cccccccc");
    // Still the same secret.
    const again = await deliverOnce(ep);
    expect(again.signatures).toEqual([again.sign(plaintext)]);
  });

  it("seals plaintext secrets on start, current and previous alike", async () => {
    const ep = await createTestWebhookEndpoint(token);
    await prisma.webhookEndpoint.update({
      where: { id: ep.id },
      data: {
        signingSecret: "d".repeat(64),
        previousSigningSecret: "e".repeat(64),
        previousSecretExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    expect(await sealWebhookSecrets()).toBeGreaterThanOrEqual(1);

    const row = await stored(ep.id);
    const name = endpointSecretName(ep.id);
    expect(row.signingSecret.startsWith(currentSealPrefix())).toBe(true);
    expect(row.previousSigningSecret!.startsWith(currentSealPrefix())).toBe(
      true
    );
    expect((await openRowSecret(name, row.signingSecret)).value).toBe(
      "d".repeat(64)
    );
    expect((await openRowSecret(name, row.previousSigningSecret!)).value).toBe(
      "e".repeat(64)
    );
    // Nothing left to do for this endpoint.
    await sealWebhookSecrets();
    expect((await stored(ep.id)).signingSecret).toBe(row.signingSecret);
  });

  it("clears an expired previous secret on start instead of leaving it in plaintext", async () => {
    const ep = await createTestWebhookEndpoint(token);
    const before = await stored(ep.id);
    await prisma.webhookEndpoint.update({
      where: { id: ep.id },
      data: {
        previousSigningSecret: "f".repeat(64),
        previousSecretExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    await sealWebhookSecrets();

    const row = await stored(ep.id);
    expect(row.previousSigningSecret).toBeNull();
    expect(row.previousSecretExpiresAt).toBeNull();
    expect(row.signingSecret).toBe(before.signingSecret);
  });

  it("keeps both secrets signing across a rotation", async () => {
    const ep = await localEndpoint();
    const before = await stored(ep.id);

    const rotate = await axios.post<WebhookEndpointResponse>(
      `${BASE_URL}/webhooks/${ep.id}/rotate-secret`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(rotate.status).toBe(HTTP_STATUS.OK);
    const after = await stored(ep.id);
    // The replaced ciphertext moved as it was.
    expect(after.previousSigningSecret).toBe(before.signingSecret);
    expect(after.signingSecret.startsWith(currentSealPrefix())).toBe(true);
    expect(after.signingSecretHint).toBe(rotate.data.signingSecret.slice(0, 8));

    const { signatures, sign } = await deliverOnce(ep);
    expect(signatures).toEqual([
      sign(rotate.data.signingSecret),
      sign(ep.signingSecret),
    ]);
  });
});
