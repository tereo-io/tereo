import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestEventType,
  createTestWebhookEndpoint,
  getTestAccessToken,
  waitFor,
} from "./utils/test-helpers.js";

const api = axios.create({ validateStatus: () => true });
const auth = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
});

const ENDPOINT_EVENTS = [
  "webhook.endpoint.created",
  "webhook.endpoint.updated",
  "webhook.endpoint.archived",
  "webhook.endpoint.restored",
  "webhook.endpoint.deleted",
  "webhook.endpoint.secret-rotated",
  "webhook.endpoint.previous-secret-revoked",
];

describe("webhook endpoint events and audit URLs", () => {
  let admin: string;
  let subscriberId: string;

  /** The payload `eventType` for `endpointId` reached the subscriber with. */
  const delivered = async (endpointId: string, eventType: string) => {
    let payload: unknown;
    await waitFor(async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: {
          webhookEndpointId: subscriberId,
          eventType,
          payload: { path: ["entityId"], equals: endpointId },
        },
      });
      payload = row?.payload;
      return !!row;
    }, 10_000);
    return payload as { organizationId: string; data: Record<string, unknown> };
  };

  beforeAll(async () => {
    admin = await getTestAccessToken();
    subscriberId = (
      await createTestWebhookEndpoint(admin, { eventTypes: ENDPOINT_EVENTS })
    ).id;
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("emits every endpoint change without its secret or header values", async () => {
    const et = await createTestEventType(admin);
    const path = `/hook/${randomUUID()}`;
    const created = await api.post(
      `${BASE_URL}/webhooks`,
      {
        url: `https://example.com${path}?token=url-secret`,
        eventTypes: [et.eventType],
        customHeaders: { "X-Api-Key": "header-secret" },
      },
      auth(admin)
    );
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    const id: string = created.data.id;
    const secrets = [
      "url-secret",
      "header-secret",
      created.data.signingSecret as string,
    ];

    const steps: [
      string,
      () => Promise<{ status: number; data: { signingSecret?: string } }>,
    ][] = [
      ["created", async () => created],
      [
        "updated",
        () =>
          api.patch(
            `${BASE_URL}/webhooks/${id}`,
            { description: "changed" },
            auth(admin)
          ),
      ],
      [
        "secret-rotated",
        () =>
          api.post(`${BASE_URL}/webhooks/${id}/rotate-secret`, {}, auth(admin)),
      ],
      [
        "previous-secret-revoked",
        () =>
          api.post(
            `${BASE_URL}/webhooks/${id}/revoke-previous-secret`,
            {},
            auth(admin)
          ),
      ],
      [
        "archived",
        () => api.post(`${BASE_URL}/webhooks/${id}/archive`, {}, auth(admin)),
      ],
      [
        "restored",
        () => api.post(`${BASE_URL}/webhooks/${id}/restore`, {}, auth(admin)),
      ],
      ["deleted", () => api.delete(`${BASE_URL}/webhooks/${id}`, auth(admin))],
    ];
    for (const [action, step] of steps) {
      const response = await step();
      expect(response.status, action).toBeLessThan(300);
      if (action === "secret-rotated") {
        secrets.push(response.data.signingSecret!);
      }
      const payload = await delivered(id, `webhook.endpoint.${action}`);
      expect(payload.data.url).toBe(`https://example.com${path}`);
      expect(payload.data.customHeaderNames).toHaveLength(1);
      for (const secret of secrets) {
        expect(JSON.stringify(payload)).not.toContain(secret);
      }
    }
  });

  it("emits no updated event for a PATCH that changes nothing", async () => {
    const endpoint = await createTestWebhookEndpoint(admin, {
      description: "unchanged",
    });
    await delivered(endpoint.id, "webhook.endpoint.created");
    const response = await api.patch(
      `${BASE_URL}/webhooks/${endpoint.id}`,
      { description: "unchanged" },
      auth(admin)
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
    await new Promise((r) => setTimeout(r, 1500));
    expect(
      await prisma.webhookDelivery.count({
        where: {
          webhookEndpointId: subscriberId,
          eventType: "webhook.endpoint.updated",
          payload: { path: ["entityId"], equals: endpoint.id },
        },
      })
    ).toBe(0);
  });

  it("records URLs in the audit log without query string or user-info", async () => {
    const created = await createTestWebhookEndpoint(admin, {
      url: "https://example.com/audited?token=first-secret",
    });
    const patched = await api.patch(
      `${BASE_URL}/webhooks/${created.id}`,
      { url: "https://example.com/moved?token=second-secret" },
      auth(admin)
    );
    expect(patched.status).toBe(HTTP_STATUS.OK);
    expect(
      (await api.delete(`${BASE_URL}/webhooks/${created.id}`, auth(admin)))
        .status
    ).toBe(HTTP_STATUS.NO_CONTENT);

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "WebhookEndpoint", entityId: created.id },
      orderBy: { createdAt: "asc" },
    });
    expect(entries.map((e) => e.action)).toEqual([
      "CREATE",
      "UPDATE",
      "DELETE",
    ]);
    expect(entries[0].metadata).toMatchObject({
      url: "https://example.com/audited",
    });
    expect(entries[1].changes).toMatchObject({
      url: {
        old: "https://example.com/audited",
        new: "https://example.com/moved",
      },
    });
    expect(entries[2].metadata).toMatchObject({
      url: "https://example.com/moved",
    });
    expect(JSON.stringify(entries)).not.toMatch(/first-secret|second-secret/);
  });
});

describe("who may redirect an endpoint's file events", () => {
  const org = `file-redirect-${randomUUID()}`;
  const filePermissions = [
    "webhooks.read",
    "webhooks.write",
    "file-service.objects.read",
  ];
  let creator: string;
  let editor: string;
  let endpointId: string;

  const patch = (token: string, body: Record<string, unknown>) =>
    api.patch(`${BASE_URL}/webhooks/${endpointId}`, body, auth(token));

  const failedDelivery = async (eventType: string) =>
    (
      await prisma.webhookDelivery.create({
        data: {
          webhookEndpointId: endpointId,
          eventType,
          payload: { eventType, data: {} },
          status: "FAILED",
          attempts: 10,
          completedAt: new Date(),
        },
      })
    ).id;

  beforeAll(async () => {
    creator = await getTestPrincipalToken({
      organizationId: org,
      permissions: filePermissions,
    });
    editor = await getTestPrincipalToken({
      organizationId: org,
      permissions: filePermissions,
    });
    endpointId = (
      await createTestWebhookEndpoint(creator, {
        eventTypes: ["file-service.object.created"],
      })
    ).id;
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("refuses anyone else a new URL or custom headers", async () => {
    expect(
      (await patch(editor, { url: "https://example.com/elsewhere" })).status
    ).toBe(HTTP_STATUS.FORBIDDEN);
    expect(
      (await patch(editor, { customHeaders: { "X-Extra": "1" } })).status
    ).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("lets anyone else change what does not redirect it", async () => {
    expect((await patch(editor, { description: "edited" })).status).toBe(
      HTTP_STATUS.OK
    );
  });

  it("lets the creator and webhooks.admin redirect it", async () => {
    expect(
      (await patch(creator, { url: "https://example.com/by-creator" })).status
    ).toBe(HTTP_STATUS.OK);
    const admin = await getTestPrincipalToken({
      organizationId: org,
      permissions: ["webhooks.admin", "file-service.objects.read"],
    });
    expect(
      (await patch(admin, { url: "https://example.com/by-admin" })).status
    ).toBe(HTTP_STATUS.OK);
  });

  it("refuses anyone else a file event type the endpoint does not have yet", async () => {
    const et = await createTestEventType(await getTestAccessToken());
    const other = await createTestWebhookEndpoint(creator, {
      eventTypes: [et.eventType],
    });
    const otherPatch = (token: string, body: Record<string, unknown>) =>
      api.patch(`${BASE_URL}/webhooks/${other.id}`, body, auth(token));
    // Not subscribed to file events: redirecting it reaches nothing a bucket guards.
    expect(
      (await otherPatch(editor, { url: "https://example.com/redirected" }))
        .status
    ).toBe(HTTP_STATUS.OK);
    expect(
      (
        await otherPatch(editor, {
          eventTypes: [et.eventType, "file-service.object.created"],
        })
      ).status
    ).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("refuses anyone else a retry of a file-service delivery", async () => {
    const deliveryId = await failedDelivery("file-service.object.created");
    const retry = (token: string) =>
      api.post(
        `${BASE_URL}/webhooks/${endpointId}/deliveries/${deliveryId}/retry`,
        {},
        auth(token)
      );
    expect((await retry(editor)).status).toBe(HTTP_STATUS.FORBIDDEN);
    expect((await retry(creator)).status).toBe(HTTP_STATUS.ACCEPTED);
  });

  it("leaves file-service deliveries out of anyone else's bulk retry", async () => {
    const et = await createTestEventType(await getTestAccessToken());
    const fileDelivery = await failedDelivery("file-service.object.created");
    const otherDelivery = await failedDelivery(et.eventType);
    const bulk = (token: string, body: Record<string, unknown> = {}) =>
      api.post(
        `${BASE_URL}/webhooks/${endpointId}/deliveries/retry`,
        body,
        auth(token)
      );

    expect(
      (await bulk(editor, { eventType: "file-service.object.created" })).status
    ).toBe(HTTP_STATUS.FORBIDDEN);
    const response = await bulk(editor);
    expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
    const statuses = await prisma.webhookDelivery.findMany({
      where: { id: { in: [fileDelivery, otherDelivery] } },
      select: { id: true, status: true },
    });
    expect(Object.fromEntries(statuses.map((d) => [d.id, d.status]))).toEqual({
      [fileDelivery]: "FAILED",
      [otherDelivery]: "PENDING",
    });
  });
});
