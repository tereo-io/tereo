// @module-tag int
// @module-tag notifications
import { DEFAULT_ORGANIZATION_ID } from "../../../../../../../definitions/index.js";
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../../support/http.js";
import { randomBytes, randomUUID } from "crypto";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../support/webhooks.js";

const BASE = `${CORE_URL}/v1/admin/notifications`;

let adminToken: string;

let adminUserId: string;

const rand = () => randomBytes(4).toString("hex");

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${BASE}${path}`, token, body);

const settings = (port = 2525, over: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port,
  security: "none",
  defaultFrom: { address: "billing@acme.com" },
  allowedSenders: ["@acme.com"],
  ...over,
});

const payload = (over: Record<string, unknown> = {}) => ({
  channel: "email",
  slug: `c-${rand()}`,
  displayName: "Main",
  settings: settings(),
  ...over,
});

const create = async (over: Record<string, unknown> = {}) => {
  const res = await api("POST", "/connections", adminToken, payload(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

const clean = async () => {
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationConnection.deleteMany();
};

beforeAll(async () => {
  adminUserId = randomUUID();
  adminToken = await getTestPrincipalToken({
    userId: adminUserId,
    permissions: ["notifications.admin", "notifications.read"],
  });

  await clean();
});

afterAll(async () => {
  await clean();
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
      await api("PATCH", `/connections/${c.id}`, adminToken, {
        displayName: "Audited",
        secrets: { password: "audit-secret-pw-2" },
      });
      await api("DELETE", `/connections/${c.id}`, adminToken);

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
      await api("PATCH", `/connections/${c.id}`, adminToken, {
        secrets: { password: "rotate-me-2" },
      });
      await api("PATCH", `/connections/${c.id}`, adminToken, {
        secrets: null,
      });
      await api("PATCH", `/connections/${c.id}`, adminToken, {
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
      await clean();
      await create();
      const b = await create();
      await api("POST", `/connections/${b.id}/default`, adminToken);
      const entries = await audit(b.id);
      expect(entries.map((e) => e.action)).toEqual(["CREATE", "UPDATE"]);
      await findEvent("notification.connection.updated", b.id);
    });
  });
});
