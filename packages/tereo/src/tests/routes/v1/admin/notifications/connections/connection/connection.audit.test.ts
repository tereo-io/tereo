// @module-tag int
// @module-tag notifications
import { DEFAULT_ORGANIZATION_ID } from "../../../../../../../definitions/index.js";
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { cleanNotifications } from "../../../../../../support/notifications.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  connectionsApi,
  createConnection,
} from "../../../../../../support/notificationConnections.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../support/webhooks.js";

let adminToken: string;

let adminUserId: string;

const create = (over: Record<string, unknown> = {}) =>
  createConnection(adminToken, over);

beforeAll(async () => {
  adminUserId = randomUUID();
  adminToken = await getTestPrincipalToken({
    userId: adminUserId,
    permissions: ["notifications.admin", "notifications.read"],
  });

  await cleanNotifications();
});

afterAll(async () => {
  await cleanNotifications();
});

describe("/v1/admin/notifications/connections/:id", () => {
  describe("audit and events", () => {
    let endpointId: string;

    beforeAll(async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        {
          eventTypes: [
            "notification.connection.created",
            "notification.connection.updated",
            "notification.connection.deleted",
          ],
        }
      );
      endpointId = endpoint.id;
    });

    const findEvent = async (eventType: string, entityId: string) => {
      const where = {
        webhookEndpointId: endpointId,
        eventType,
        payload: { path: ["entityId"], equals: entityId },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
      return (await prisma.webhookDelivery.findFirstOrThrow({ where }))
        .payload as { data: Record<string, unknown> };
    };

    const audit = (entityId: string) =>
      prisma.auditLogEntry.findMany({
        where: { entityType: "NotificationConnection", entityId },
        orderBy: { createdAt: "asc" },
      });

    it("records and emits create, update and delete without secrets", async () => {
      const c = await create({ secrets: { password: "audit-secret-pw" } });
      await connectionsApi("PATCH", `/connections/${c.id}`, adminToken, {
        displayName: "Audited",
        secrets: { password: "audit-secret-pw-2" },
      });
      await connectionsApi("DELETE", `/connections/${c.id}`, adminToken);

      const entries = await audit(c.id);
      expect(entries.map((e) => e.action)).toEqual([
        "CREATE",
        "UPDATE",
        "DELETE",
      ]);
      expect(entries.every((e) => e.userId === adminUserId)).toBe(true);
      expect(JSON.stringify(entries)).not.toContain("audit-secret-pw");
      expect(JSON.stringify(entries)).not.toContain("kek1:");

      for (const type of ["created", "updated", "deleted"]) {
        const event = await findEvent(`notification.connection.${type}`, c.id);
        expect(event.data).toMatchObject({ id: c.id, slug: c.slug });
        expect(JSON.stringify(event)).not.toContain("audit-secret-pw");
      }
    });

    it("notes a secrets change in the update's audit entry, never the values", async () => {
      const c = await create({ secrets: { password: "rotate-me-1" } });
      await connectionsApi("PATCH", `/connections/${c.id}`, adminToken, {
        secrets: { password: "rotate-me-2" },
      });
      await connectionsApi("PATCH", `/connections/${c.id}`, adminToken, {
        secrets: null,
      });
      await connectionsApi("PATCH", `/connections/${c.id}`, adminToken, {
        displayName: "Renamed",
      });

      const updates = (await audit(c.id)).filter((e) => e.action === "UPDATE");
      expect(updates.map((e) => e.metadata)).toEqual([
        { secretsChanged: true },
        { secretsCleared: true },
        null,
      ]);
      expect(JSON.stringify(updates)).not.toContain("rotate-me");
    });

    it("audits a default change", async () => {
      await cleanNotifications();
      await create();
      const b = await create();
      await connectionsApi("POST", `/connections/${b.id}/default`, adminToken);
      const entries = await audit(b.id);
      expect(entries.map((e) => e.action)).toEqual(["CREATE", "UPDATE"]);
      await findEvent("notification.connection.updated", b.id);
    });
  });
});
