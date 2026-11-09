// @module-tag int
// @module-tag webhooks
import { processWebhookDelivery } from "../../../jobs/webhookDelivery.js";
import { DEFAULT_ORGANIZATION_ID } from "../../../definitions/index.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { dispatchOutboxEvent } from "../../../utils/processEvent.js";
import { redactUnreadable } from "../../../utils/webhookAccess.js";
import { ensurePermission } from "../../support/testService.js";
import { delegatedToken } from "../../support/groups.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
  testOrgId,
} from "../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestEventType,
} from "../../support/webhooks.js";
import {
  createTestBucket,
  grantTestPermission,
  getTestAccessToken as getFilesToken,
} from "../../support/files.js";

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

  describe("group events", () => {
    const WEBHOOKS = ["webhooks.read", "webhooks.write"];
    const EVENT = "auth.group.members-added";

    /** An org-scoped webhooks user holding `memberRole` in a fresh org. */
    const orgAdmin = async (memberRole: "member" | "admin" | "owner") => {
      const orgId = testOrgId(`group-events-${randomUUID()}`);
      const user = await orgScopedUser(orgId, WEBHOOKS);
      await prisma.organizationMember.update({
        where: {
          organizationId_userId: { organizationId: orgId, userId: user.userId },
        },
        data: { memberRole },
      });
      return { ...user, orgId };
    };

    const groupEvent = (
      emittedIn: string,
      groupOrganizationId: string | null
    ) => ({
      organizationId: emittedIn,
      eventType: EVENT,
      data: {
        groupId: randomUUID(),
        organizationId: groupOrganizationId,
        userIds: [],
      },
    });

    it("an org admin or owner subscribes and is sent their org's group events", async () => {
      for (const tier of ["admin", "owner"] as const) {
        const { token, orgId } = await orgAdmin(tier);
        const created = await subscribe(token, [EVENT]);
        expect(created.status, tier).toBe(HTTP_STATUS.CREATED);
        expect(await fanOut(created.data.id, groupEvent(orgId, orgId))).toBe(1);
      }
    });

    it("a plain org member may not subscribe", async () => {
      const { token } = await orgAdmin("member");
      const res = await subscribe(token, [EVENT]);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.data.error_description).toContain("groups.read");
    });

    it("an org admin is sent no group event of another organization, and nothing once demoted", async () => {
      const { token, orgId, userId } = await orgAdmin("admin");
      const created = await subscribe(token, [EVENT]);
      expect(created.status).toBe(HTTP_STATUS.CREATED);
      expect(
        await fanOut(created.data.id, groupEvent(orgId, randomUUID()))
      ).toBe(0);

      await prisma.organizationMember.update({
        where: { organizationId_userId: { organizationId: orgId, userId } },
        data: { memberRole: "member" },
      });
      expect(await fanOut(created.data.id, groupEvent(orgId, orgId))).toBe(0);
    });

    it("the default organization's admin is sent its own groups' events, not global groups'", async () => {
      const userId = randomUUID();
      await ensureTestMembership(userId, DEFAULT_ORGANIZATION_ID);
      await prisma.organizationMember.update({
        where: {
          organizationId_userId: {
            organizationId: DEFAULT_ORGANIZATION_ID,
            userId,
          },
        },
        data: { memberRole: "admin" },
      });
      const token = await getTestPrincipalToken({
        userId,
        organizationId: DEFAULT_ORGANIZATION_ID,
        permissions: WEBHOOKS,
      });
      const created = await subscribe(token, [EVENT]);
      expect(created.status).toBe(HTTP_STATUS.CREATED);
      expect(
        await fanOut(
          created.data.id,
          groupEvent(DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_ID)
        )
      ).toBe(1);
      expect(
        await fanOut(created.data.id, groupEvent(DEFAULT_ORGANIZATION_ID, null))
      ).toBe(0);
    });

    /** The one delivery of a fanned-out event, marked FAILED. */
    const failedDelivery = async (endpointId: string) => {
      const delivery = await prisma.webhookDelivery.findFirstOrThrow({
        where: { webhookEndpointId: endpointId },
        orderBy: { createdAt: "desc" },
      });
      await prisma.webhookDelivery.updateMany({
        where: { id: delivery.id },
        data: { status: "FAILED", attempts: 1, completedAt: new Date() },
      });
      return delivery.id;
    };

    it("a delivery written before the creator's demotion is not sent or retried after it", async () => {
      const { token, orgId, userId } = await orgAdmin("admin");
      const created = await subscribe(token, [EVENT]);
      expect(await fanOut(created.data.id, groupEvent(orgId, orgId))).toBe(1);
      const deliveryId = await failedDelivery(created.data.id);
      const retry = () =>
        api.post(
          `${BASE_URL}/webhooks/${created.data.id}/deliveries/${deliveryId}/retry`,
          {},
          { headers: auth(token) }
        );

      await prisma.organizationMember.update({
        where: { organizationId_userId: { organizationId: orgId, userId } },
        data: { memberRole: "member" },
      });
      const refused = await retry();
      expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(refused.data.error_description).toContain(
        "may no longer receive this event"
      );
      // Nor does the worker send it, should it be pending again (a bulk
      // retry, or a retry of an earlier attempt).
      await prisma.webhookDelivery.updateMany({
        where: { id: deliveryId },
        data: { status: "PENDING", attempts: 0, completedAt: null },
      });
      await processWebhookDelivery({ data: { deliveryId } });
      expect(
        await prisma.webhookDelivery.findFirstOrThrow({
          where: { id: deliveryId },
        })
      ).toMatchObject({
        status: "FAILED",
        errorMessage: "The endpoint's creator may no longer receive this event",
      });

      await prisma.organizationMember.update({
        where: { organizationId_userId: { organizationId: orgId, userId } },
        data: { memberRole: "admin" },
      });
      expect((await retry()).status).toBe(202);
    });

    it("a delegated token acts as an org admin elsewhere only if its scopes allow organizations.write", async () => {
      const { token, orgId } = await orgAdmin("admin");
      const created = await subscribe(token, [EVENT]);
      // Another organization's group event on an endpoint the viewer sees.
      const otherOrg = randomUUID();
      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookEndpointId: created.data.id,
          eventType: EVENT,
          payload: {
            id: randomUUID(),
            organizationId: otherOrg,
            eventType: EVENT,
            data: { groupId: randomUUID(), organizationId: otherOrg },
          },
        },
      });
      const viewer = randomUUID();
      const full = await getTestPrincipalToken({
        userId: viewer,
        permissions: ["organizations.write", "webhooks.admin"],
      });
      const view = async (viewerToken: string) => {
        const res = await api.get(
          `${BASE_URL}/webhooks/${created.data.id}/deliveries/${delivery.id}`,
          { headers: { ...auth(viewerToken), "X-Organization-ID": orgId } }
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        return res.data.payloadRedacted;
      };

      expect(await view(full)).toBe(false);
      expect(await view(await delegatedToken(viewer, ["core:webhooks"]))).toBe(
        true
      );
    });

    it("the delivery view asks once per organization whether the viewer is its admin", async () => {
      const { userId, orgId } = await orgAdmin("admin");
      const deliveries = Array.from({ length: 5 }, () => ({
        eventType: EVENT,
        payload: groupEvent(orgId, orgId),
        responseBody: null,
      }));
      const lookups = vi.spyOn(prisma.organizationMember, "findFirst");
      try {
        const shown = await redactUnreadable(
          { userId, permissions: WEBHOOKS },
          { organizationId: orgId, owner: null },
          deliveries
        );
        expect(shown.map((d) => d.payloadRedacted)).toEqual(
          deliveries.map(() => false)
        );
        expect(lookups).toHaveBeenCalledTimes(1);
      } finally {
        lookups.mockRestore();
      }
    });

    it("a holder of groups.read is sent global and org group events as before", async () => {
      const token = await getTestPrincipalToken({
        organizationId: DEFAULT_ORGANIZATION_ID,
        permissions: [...WEBHOOKS, "groups.read"],
      });
      const created = await subscribe(token, [EVENT]);
      expect(created.status).toBe(HTTP_STATUS.CREATED);
      expect(
        await fanOut(created.data.id, groupEvent(DEFAULT_ORGANIZATION_ID, null))
      ).toBe(1);
    });
  });
});
