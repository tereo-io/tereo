// @module-tag int
// @module-tag notifications
import { ensureDefaultOrganization } from "../../../../../../../utils/defaultOrganization.js";
import { ensureDailyPartitions } from "../../../../../../../utils/partitions.js";
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  SYSTEM_USER,
  SYSTEM_USER_ID,
} from "../../../../../../../definitions/index.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { waitFor } from "../../../../../../support/webhooks.js";
import { CORE_URL } from "../../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../../support/http.js";
import { randomBytes, randomUUID } from "crypto";
import env from "../../../../../../../env.js";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "../../../../../../../jobs/notificationDelivery.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../../../../../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../../../../../../support/fakeSmtpServer.js";

const BASE = `${CORE_URL}/v1/admin/notifications`;
const rand = () => randomBytes(4).toString("hex");

let readToken: string;
let adminToken: string;
let sendToken: string;
let smtp: FakeSmtpServer;
let smtpCode = 250;
const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${BASE}${path}`, token, body);

const clean = async () => {
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationConnection.deleteMany();
};

interface SeedOptions {
  status?: "pending" | "sent" | "partial" | "failed";
  senderUserId?: string;
  addresses?: string[];
  createdAt?: Date;
  content?: object | null;
  deliveryStatuses?: ("pending" | "sending" | "sent" | "failed")[];
  /** Per delivery; a sent one defaults to now. */
  sentAt?: (Date | null)[];
  connectionId?: string;
  summary?: string | null;
}

/** A notification with one delivery per entry of `deliveryStatuses`. */
const seed = async (o: SeedOptions = {}) => {
  const addresses = o.addresses ?? ["ops@example.com"];
  const statuses = o.deliveryStatuses ?? ["sent"];
  const notification = await prisma.notification.create({
    data: {
      channel: "email",
      connectionId: o.connectionId ?? null,
      senderUserId: o.senderUserId ?? SYSTEM_USER_ID,
      recipients: addresses.map((address) => ({ address, as: "to" })),
      content:
        o.content === undefined
          ? { subject: `Subject ${rand()}`, text: "Hello" }
          : (o.content ?? undefined),
      summary: o.summary ?? null,
      attachments: [],
      status: o.status ?? "sent",
      ...(o.createdAt && { createdAt: o.createdAt }),
    },
  });
  for (const [i, status] of statuses.entries()) {
    await prisma.notificationDelivery.create({
      data: {
        notificationId: notification.id,
        notificationCreatedAt: notification.createdAt,
        connectionId: o.connectionId ?? null,
        recipients: [{ address: addresses[i] ?? addresses[0], as: "to" }],
        status,
        attempts: status === "failed" ? 3 : 1,
        lastError: status === "failed" ? "550 mailbox unavailable" : null,
        providerResponse: status === "sent" ? "250 OK" : null,
        sentAt: o.sentAt?.[i] ?? (status === "sent" ? new Date() : null),
      },
    });
  }
  return notification;
};

beforeAll(async () => {
  env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await ensureDefaultOrganization();
  readToken = await getTestPrincipalToken({
    permissions: ["notifications.read"],
  });
  adminToken = await getTestPrincipalToken({
    permissions: ["notifications.admin", "notifications.read"],
  });
  sendToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });
  smtp = await startFakeSmtpServer({ reply: () => smtpCode });
  await clean();
  await getNotificationQueue("email").obliterate({ force: true });
});

beforeEach(async () => {
  smtpCode = 250;
  smtp.messages.length = 0;
  await clean();
});

afterAll(async () => {
  await getNotificationQueue("email")
    .obliterate({ force: true })
    .catch(() => {});
  await closeNotificationQueues();
  await smtp.close();
  await clean();
  env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
});

describe("/v1/admin/notifications/:id", () => {
  describe("notifications log", () => {
    it("rejects an id that is not a uuid", async () => {
      const res = await api("GET", "/not-a-uuid", readToken);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(res.body.error_description).toEqual(expect.any(String));
    });

    it("shows detail with content while kept, deliveries and attachments", async () => {
      const n = await seed({
        status: "partial",
        addresses: ["a@example.com", "b@example.com"],
        deliveryStatuses: ["sent", "failed"],
        content: { subject: "Kept", text: "Body" },
        summary: "Kept",
      });
      const res = await api("GET", `/${n.id}`, readToken);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: n.id,
        summary: "Kept",
        status: "partial",
        content: { subject: "Kept", text: "Body" },
        attachments: [],
        sender: SYSTEM_USER,
      });
      expect(res.body.deliveries).toHaveLength(2);
      const byStatus = Object.fromEntries(
        res.body.deliveries.map((d: { status: string }) => [d.status, d])
      );
      expect(byStatus.sent.providerResponse).toBe("250 OK");
      expect(byStatus.failed.lastError).toBe("550 mailbox unavailable");
      expect(byStatus.failed.attempts).toBe(3);
    });

    it("shows content null once sent, and never connection secrets", async () => {
      const connection = await prisma.notificationConnection.create({
        data: {
          channel: "email",
          slug: `c-${rand()}`,
          displayName: "C",
          settings: {},
          secrets: "sealed-secret-blob",
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      const n = await seed({ content: null, connectionId: connection.id });
      const res = await api("GET", `/${n.id}`, readToken);
      expect(res.body.content).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("sealed-secret-blob");
      expect(res.body.connectionId).toBe(connection.id);
    });

    it("404s an unknown notification", async () => {
      expect((await api("GET", `/${randomUUID()}`, readToken)).status).toBe(
        404
      );
    });
  });

  describe("notification retry", () => {
    const connection = () =>
      prisma.notificationConnection.create({
        data: {
          channel: "email",
          slug: `c-${rand()}`,
          displayName: "Test",
          settings: {
            host: "127.0.0.1",
            port: smtp.port,
            security: "none",
            defaultFrom: { address: "billing@acme.com" },
            allowedSenders: ["@acme.com"],
          },
          isDefault: true,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });

    it("requires notifications.admin", async () => {
      const n = await seed({ status: "failed", deliveryStatuses: ["failed"] });
      expect((await api("POST", `/${n.id}/retry`, null)).status).toBe(401);
      expect((await api("POST", `/${n.id}/retry`, readToken)).status).toBe(403);
    });

    it("409s when nothing failed, and 404s an unknown id", async () => {
      const n = await seed({ deliveryStatuses: ["sent"] });
      const res = await api("POST", `/${n.id}/retry`, adminToken);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("nothing_to_retry");
      expect(
        (await api("POST", `/${randomUUID()}/retry`, adminToken)).status
      ).toBe(404);
    });

    it("re-queues a failed delivery whose failed job is still kept, and sends it", async () => {
      await connection();
      await startNotificationDeliveryWorker();
      try {
        smtpCode = 550;
        const created = await fetch(`${CORE_URL}/v1/notifications`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sendToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: "email",
            recipients: [{ address: "ops@example.com" }],
            content: { subject: "Retry me", text: "Hello" },
          }),
        });
        expect(created.status).toBe(202);
        const { id } = (await created.json()) as { id: string };

        const failedDelivery = async () =>
          prisma.notificationDelivery.findFirstOrThrow({
            where: { notificationId: id },
          });
        await waitFor(
          async () => (await failedDelivery()).status === "failed",
          15_000,
          50
        );
        const delivery = await failedDelivery();
        expect(delivery.attempts).toBe(1);
        const queue = getNotificationQueue("email");
        // The settled job is kept; a plain add under its id would be ignored.
        await waitFor(
          async () =>
            ["completed", "failed"].includes(
              (await (await queue.getJob(delivery.id))?.getState()) ?? ""
            ),
          15_000,
          50
        );

        smtpCode = 250;
        const res = await api("POST", `/${id}/retry`, adminToken);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ requeued: 1 });

        await waitFor(
          async () => (await failedDelivery()).status === "sent",
          15_000,
          50
        );
        const sent = await failedDelivery();
        expect(sent.attempts).toBe(1);
        expect(sent.lastError).toBeNull();
        expect(smtp.messages).toHaveLength(1);
        await waitFor(
          async () =>
            (await prisma.notification.findFirstOrThrow({ where: { id } }))
              .status === "sent",
          15_000,
          50
        );

        const audit = await prisma.auditLogEntry.findFirst({
          where: { entityType: "Notification", entityId: id, action: "UPDATE" },
        });
        expect(audit).not.toBeNull();
      } finally {
        await stopNotificationDeliveryWorker();
      }
    });

    it("resets only the failed deliveries and rolls the notification back to pending", async () => {
      const n = await seed({
        status: "partial",
        addresses: ["a@example.com", "b@example.com"],
        deliveryStatuses: ["sent", "failed"],
      });
      const res = await api("POST", `/${n.id}/retry`, adminToken);
      expect(res.body).toEqual({ requeued: 1 });

      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notificationId: n.id },
      });
      const sent = deliveries.find((d) => d.providerResponse === "250 OK")!;
      const retried = deliveries.find((d) => d.providerResponse === null)!;
      expect(sent).toMatchObject({ status: "sent", attempts: 1 });
      expect(retried).toMatchObject({ status: "pending", attempts: 0 });
      expect(
        (await prisma.notification.findFirstOrThrow({ where: { id: n.id } }))
          .status
      ).toBe("pending");

      await waitFor(
        async () =>
          (await getNotificationQueue("email").getJob(retried.id)) !==
          undefined,
        15_000,
        50
      );
    });
  });
});
