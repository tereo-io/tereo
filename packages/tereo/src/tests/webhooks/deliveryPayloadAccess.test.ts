import { DEFAULT_ORGANIZATION_ID } from "../../definitions/index.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dispatchOutboxEvent } from "../../utils/processEvent.js";
import { ensurePermission } from "../utils/testService.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  createTestBucket,
  grantTestPermission,
  getTestAccessToken as getFilesToken,
} from "../files/utils/test-helpers.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
} from "./utils/test-helpers.js";
import {
  ensureTestMembership,
  getTestPrincipalToken,
  testOrgId,
} from "../utils/principals.js";

// A stored delivery carries the event as it was sent. Whoever views it sees
// the payload, and the receiver's response that may echo it, only if they
// could read the event themselves — the same check its endpoint was sent it
// under.

const api = axios.create({ validateStatus: () => true });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A member of `org` holding `permissions` through a role scoped to it. */
const orgScopedViewer = async (org: string, permissions: string[]) => {
  const userId = randomUUID();
  await ensureTestMembership(userId, org);
  const perms = await Promise.all(permissions.map((p) => ensurePermission(p)));
  const role = await prisma.role.create({
    data: {
      name: `delivery-viewer-${userId}`,
      displayName: "Org-scoped delivery viewer",
      rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  await prisma.userRole.create({
    data: { userId, roleId: role.id, organizationId: testOrgId(org) },
  });
  const token = await getTestPrincipalToken({
    userId,
    organizationId: org,
    permissions: [],
  });
  return { userId, token };
};

/** Fans one event out to `endpointId` and returns its delivery's id. */
const deliver = async (
  endpointId: string,
  event: {
    organizationId: string;
    eventType: string;
    data: Record<string, unknown>;
  }
) => {
  const entityId = randomUUID();
  await dispatchOutboxEvent(
    { entityType: "Thing", ...event, entityId },
    randomUUID(),
    new Date()
  );
  const delivery = await prisma.webhookDelivery.findFirstOrThrow({
    where: {
      webhookEndpointId: endpointId,
      payload: { path: ["entityId"], equals: entityId },
    },
  });
  return delivery.id;
};

const views = (token: string, endpointId: string, deliveryId: string) =>
  Promise.all([
    api.get(`${BASE_URL}/webhooks/${endpointId}/deliveries/${deliveryId}`, {
      headers: auth(token),
    }),
    api.get(`${BASE_URL}/webhooks/${endpointId}/deliveries`, {
      headers: auth(token),
    }),
  ]);

describe("delivery payloads are shown only to who could read the event", () => {
  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("a platform event", () => {
    const email = `delivery-secret-${randomUUID()}@example.com`;
    let endpointId: string;
    let deliveryId: string;

    beforeAll(async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.user.created"] }
      );
      endpointId = endpoint.id;
      deliveryId = await deliver(endpointId, {
        organizationId: DEFAULT_ORGANIZATION_ID,
        eventType: "auth.user.created",
        data: { email },
      });
      // A receiver that echoed what it was sent.
      await prisma.webhookDelivery.updateMany({
        where: { id: deliveryId },
        data: { responseBody: `got ${email}` },
      });
    });

    it("is hidden from a viewer without users.read, in one and in the list", async () => {
      const { token } = await orgScopedViewer(DEFAULT_ORGANIZATION_ID, [
        "webhooks.read",
      ]);
      const [one, list] = await views(token, endpointId, deliveryId);
      expect(one.status).toBe(HTTP_STATUS.OK);
      expect(list.status).toBe(HTTP_STATUS.OK);
      expect(one.data.payload).toBeNull();
      expect(one.data.responseBody).toBeNull();
      expect(one.data.payloadRedacted).toBe(true);
      expect(JSON.stringify(one.data)).not.toContain(email);
      expect(JSON.stringify(list.data)).not.toContain(email);
    });

    it("is shown to a viewer holding users.read", async () => {
      const token = await getTestPrincipalToken({
        organizationId: DEFAULT_ORGANIZATION_ID,
        permissions: ["webhooks.read", "users.read"],
      });
      const [one, list] = await views(token, endpointId, deliveryId);
      expect(one.data.payload.data.email).toBe(email);
      expect(one.data.payloadRedacted).toBe(false);
      expect(JSON.stringify(list.data)).toContain(email);
    });

    it("is hidden in a retry's response from a caller without users.read", async () => {
      await prisma.webhookDelivery.updateMany({
        where: { id: deliveryId },
        data: { status: "FAILED", completedAt: new Date() },
      });
      const { token } = await orgScopedViewer(DEFAULT_ORGANIZATION_ID, [
        "webhooks.write",
      ]);
      const res = await api.post(
        `${BASE_URL}/webhooks/${endpointId}/deliveries/${deliveryId}/retry`,
        {},
        { headers: auth(token) }
      );
      expect(res.status).toBe(HTTP_STATUS.ACCEPTED);
      expect(JSON.stringify(res.data)).not.toContain(email);
    });
  });

  it("writes no audit entry for a core event nobody was sent", async () => {
    const organizationId = testOrgId(`delivery-unsent-${randomUUID()}`);
    await ensureTestMembership(randomUUID(), organizationId);
    const entityId = randomUUID();
    await dispatchOutboxEvent(
      {
        organizationId,
        eventType: "auth.user.created",
        entityType: "User",
        entityId,
        data: { email: `unsent-${randomUUID()}@example.com` },
      },
      randomUUID(),
      new Date()
    );
    expect(
      await prisma.auditLogEntry.count({
        where: {
          organizationId,
          entityType: "WebhookEvent",
          metadata: { path: ["entityId"], equals: entityId },
        },
      })
    ).toBe(0);
  });

  describe("a file event", () => {
    const org = `delivery-files-${randomUUID()}`;
    const objectKey = `secret-${randomUUID()}.txt`;
    let bucketName: string;
    let endpointId: string;
    let deliveryId: string;

    beforeAll(async () => {
      const owner = await getTestPrincipalToken({
        organizationId: org,
        permissions: ["file-service.admin"],
      });
      bucketName = (await createTestBucket(owner, { policy: "private" })).name;
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(testOrgId(org)),
        { eventTypes: ["file-service.object.created"] }
      );
      endpointId = endpoint.id;
      deliveryId = await deliver(endpointId, {
        organizationId: testOrgId(org),
        eventType: "file-service.object.created",
        data: { bucketName, objectKey },
      });
    });

    it("is hidden from a viewer without read access to the bucket", async () => {
      const { userId, token } = await orgScopedViewer(org, [
        "webhooks.read",
        "file-service.objects.read",
      ]);
      const [one, list] = await views(token, endpointId, deliveryId);
      expect(one.status).toBe(HTTP_STATUS.OK);
      expect(JSON.stringify(one.data)).not.toContain(objectKey);
      expect(JSON.stringify(list.data)).not.toContain(objectKey);

      await grantTestPermission(await getFilesToken(), bucketName, userId, {
        canRead: true,
      });
      const [granted] = await views(token, endpointId, deliveryId);
      expect(granted.data.payload.data.objectKey).toBe(objectKey);
    });
  });
});
