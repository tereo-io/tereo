import { DEFAULT_ORGANIZATION_ID } from "../../definitions/index.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dispatchOutboxEvent } from "../../utils/processEvent.js";
import { ensurePermission } from "../support/testService.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
  testOrgId,
} from "../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestEventType,
} from "../support/webhooks.js";
import {
  createTestBucket,
  grantTestPermission,
  getTestAccessToken as getFilesToken,
} from "../support/files.js";

// An endpoint acts as its creator: it is sent an event only while the creator
// is active and could read the event — the event type's read permission in
// the endpoint's organization, and for a file event, the bucket.

const api = axios.create({ validateStatus: () => true });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A member of `orgId` holding `permissions` through a role scoped to it. */
const orgScopedUser = async (orgId: string, permissions: string[]) => {
  const userId = randomUUID();
  await ensureTestMembership(userId, orgId);
  const perms = await Promise.all(permissions.map((p) => ensurePermission(p)));
  const role = await prisma.role.create({
    data: {
      name: `recipient-access-${userId}`,
      displayName: "Org-scoped test role",
      rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  const assignment = await prisma.userRole.create({
    data: { userId, roleId: role.id, organizationId: testOrgId(orgId) },
  });
  const token = await getTestPrincipalToken({
    userId,
    organizationId: orgId,
    permissions: [],
  });
  return { userId, token, assignmentId: assignment.id };
};

const subscribe = (token: string, eventTypes: string[]) =>
  api.post(
    `${BASE_URL}/webhooks`,
    { url: "https://example.com/recipient-access", eventTypes },
    { headers: auth(token) }
  );

/** Fans one event out as the outbox reaper would, and counts what `endpointId` got. */
const fanOut = async (
  endpointId: string,
  event: {
    organizationId: string;
    eventType: string;
    data?: Record<string, unknown>;
  }
) => {
  const entityId = randomUUID();
  await dispatchOutboxEvent(
    { entityType: "Thing", data: {}, ...event, entityId },
    randomUUID(),
    new Date()
  );
  return prisma.webhookDelivery.count({
    where: {
      webhookEndpointId: endpointId,
      payload: { path: ["entityId"], equals: entityId },
    },
  });
};

describe("webhook recipients act as the endpoint's creator", () => {
  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("platform events", () => {
    it("refuses to subscribe without the event type's read permission", async () => {
      const { token } = await orgScopedUser(DEFAULT_ORGANIZATION_ID, [
        "webhooks.write",
      ]);
      const res = await subscribe(token, ["auth.user.created"]);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.data.error_description).toContain("users.read");
    });

    it("sends them only while the creator still holds the read permission", async () => {
      const userId = randomUUID();
      const token = await getTestPrincipalToken({
        userId,
        organizationId: DEFAULT_ORGANIZATION_ID,
        permissions: ["webhooks.write", "users.read"],
      });
      const created = await subscribe(token, ["auth.user.created"]);
      expect(created.status).toBe(HTTP_STATUS.CREATED);
      const event = {
        organizationId: DEFAULT_ORGANIZATION_ID,
        eventType: "auth.user.created",
      };
      expect(await fanOut(created.data.id, event)).toBe(1);

      // Down to webhooks.write alone: user events are no longer theirs.
      await prisma.userRole.deleteMany({ where: { userId } });
      await getTestPrincipalToken({
        userId,
        organizationId: DEFAULT_ORGANIZATION_ID,
        permissions: ["webhooks.write"],
      });
      expect(await fanOut(created.data.id, event)).toBe(0);
    });

    it("refuses a PATCH by someone who can't read what the endpoint is sent", async () => {
      const owner = await getTestPrincipalToken({
        organizationId: DEFAULT_ORGANIZATION_ID,
        permissions: ["webhooks.write", "users.read"],
      });
      const created = await subscribe(owner, ["auth.user.created"]);
      expect(created.status).toBe(HTTP_STATUS.CREATED);

      const { token: other } = await orgScopedUser(DEFAULT_ORGANIZATION_ID, [
        "webhooks.write",
      ]);
      const res = await api.patch(
        `${BASE_URL}/webhooks/${created.data.id}`,
        { url: "https://example.com/somewhere-else" },
        { headers: auth(other) }
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("an inactive creator", () => {
    it("is sent nothing once deactivated", async () => {
      const orgId = testOrgId(`recipient-inactive-${randomUUID()}`);
      const eventType = (await createTestEventType()).eventType;
      const { userId, token } = await orgScopedUser(orgId, ["webhooks.write"]);
      const created = await subscribe(token, [eventType]);
      expect(created.status).toBe(HTTP_STATUS.CREATED);
      expect(
        await fanOut(created.data.id, { organizationId: orgId, eventType })
      ).toBe(1);

      await prisma.user.update({
        where: { id: userId },
        data: { isActive: false },
      });
      expect(
        await fanOut(created.data.id, { organizationId: orgId, eventType })
      ).toBe(0);
    });

    it("is sent nothing once they lose webhooks access in the organization", async () => {
      const orgId = testOrgId(`recipient-revoked-${randomUUID()}`);
      const eventType = (await createTestEventType()).eventType;
      const { token, assignmentId } = await orgScopedUser(orgId, [
        "webhooks.write",
      ]);
      const created = await subscribe(token, [eventType]);
      expect(created.status).toBe(HTTP_STATUS.CREATED);

      await prisma.userRole.delete({ where: { id: assignmentId } });
      expect(
        await fanOut(created.data.id, { organizationId: orgId, eventType })
      ).toBe(0);
    });
  });

  describe("file events", () => {
    let orgLabel: string;
    let orgId: string;
    let bucketName: string;
    let ownerToken: string;

    beforeAll(async () => {
      orgLabel = `recipient-files-${randomUUID()}`;
      orgId = testOrgId(orgLabel);
      ownerToken = await getTestPrincipalToken({
        organizationId: orgLabel,
        permissions: ["file-service.admin"],
      });
      bucketName = (await createTestBucket(ownerToken, { policy: "private" }))
        .name;
    });

    it("are sent only to a creator who can read the bucket", async () => {
      const { userId, token } = await orgScopedUser(orgLabel, [
        "webhooks.write",
        "file-service.objects.read",
      ]);
      const created = await subscribe(token, ["file-service.object.created"]);
      expect(created.status).toBe(HTTP_STATUS.CREATED);
      const event = {
        organizationId: orgId,
        eventType: "file-service.object.created",
        data: { bucketName, objectKey: "secret.txt" },
      };
      expect(await fanOut(created.data.id, event)).toBe(0);

      await grantTestPermission(await getFilesToken(), bucketName, userId, {
        canRead: true,
      });
      expect(await fanOut(created.data.id, event)).toBe(1);
    });

    it("refuse a subscription without the object read permission", async () => {
      const { token } = await orgScopedUser(orgLabel, ["webhooks.write"]);
      const res = await subscribe(token, ["file-service.object.created"]);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });
});
