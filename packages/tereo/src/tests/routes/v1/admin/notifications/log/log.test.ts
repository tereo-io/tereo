// @module-tag int
// @module-tag notifications
import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ensureDailyPartitions } from "../../../../../../utils/partitions.js";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomBytes, randomUUID } from "crypto";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../../../../../jobs/notificationQueues.js";
import {
  SYSTEM_USER,
  SYSTEM_USER_ID,
} from "../../../../../../definitions/index.js";

const BASE = `${CORE_URL}/v1/admin/notifications`;
const rand = () => randomBytes(4).toString("hex");

let readToken: string;

let sendToken: string;
let senderA: string;
let senderB: string;

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
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await ensureDefaultOrganization();
  senderA = randomUUID();
  senderB = randomUUID();
  readToken = await getTestPrincipalToken({
    permissions: ["notifications.read"],
  });

  sendToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });
  await getTestPrincipalToken({ userId: senderA, permissions: [] });
  await getTestPrincipalToken({ userId: senderB, permissions: [] });
  await clean();
  await getNotificationQueue("email").obliterate({ force: true });
});

beforeEach(async () => {
  await clean();
});

afterAll(async () => {
  await getNotificationQueue("email")
    .obliterate({ force: true })
    .catch(() => {});
  await closeNotificationQueues();
  await clean();
});

describe("GET /v1/admin/notifications", () => {
  describe("notifications log", () => {
    it("requires notifications.read", async () => {
      expect((await api("GET", "", null)).status).toBe(401);
      expect((await api("GET", "", sendToken)).status).toBe(403);
      expect((await api("GET", `/${randomUUID()}`, sendToken)).status).toBe(
        403
      );
      expect((await api("GET", "", readToken)).status).toBe(200);
    });

    it("lists newest first and pages with a stable cursor", async () => {
      const base = Date.now() - 60_000;
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await seed({ createdAt: new Date(base + i * 1000) })).id);
      }
      const expected = [...ids].reverse();

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 3; page++) {
        const res: Awaited<ReturnType<typeof api>> = await api(
          "GET",
          `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          readToken
        );
        expect(res.status).toBe(200);
        seen.push(...res.body.data.map((n: { id: string }) => n.id));
        cursor = res.body.nextCursor;
        expect(res.body.hasMore).toBe(page < 2);
      }
      expect(seen).toEqual(expected);
      expect(cursor).toBeNull();
    });

    it("does not take /connections and /channels as an id", async () => {
      expect((await api("GET", "/connections", readToken)).body.data).toEqual(
        []
      );
      const channels = await api("GET", "/channels", readToken);
      expect(channels.status).toBe(200);
      expect(channels.body.data[0].channel).toBe("email");
    });

    it("filters by status, sender, recipient and date", async () => {
      const t = Date.now() - 3_600_000;
      const sent = await seed({
        senderUserId: senderA,
        addresses: ["alice@example.com"],
        createdAt: new Date(t),
      });
      const failed = await seed({
        status: "failed",
        deliveryStatuses: ["failed"],
        senderUserId: senderB,
        addresses: ["bob@example.com"],
        createdAt: new Date(t + 600_000),
      });
      const partial = await seed({
        status: "partial",
        senderUserId: senderA,
        addresses: ["carol@example.com", "dave@example.com"],
        deliveryStatuses: ["sent", "failed"],
        createdAt: new Date(t + 1_200_000),
      });
      const ids = async (query: string) =>
        (await api("GET", query, readToken)).body.data
          .map((n: { id: string }) => n.id)
          .sort();
      const sorted = (...n: { id: string }[]) => n.map((x) => x.id).sort();

      expect(await ids("?filter[status]=failed")).toEqual(sorted(failed));
      expect(await ids("?filter[channel]=email")).toEqual(
        sorted(sent, failed, partial)
      );
      expect(await ids(`?filter[senderUserId]=${senderA}`)).toEqual(
        sorted(sent, partial)
      );
      expect(await ids("?filter[recipient]=Dave@Example.com")).toEqual(
        sorted(partial)
      );
      expect(await ids("?filter[recipient]=nobody@example.com")).toEqual([]);
      expect(
        await ids(
          `?filter[createdAt_gte]=${new Date(t + 300_000).toISOString()}&filter[createdAt_lte]=${new Date(t + 900_000).toISOString()}`
        )
      ).toEqual(sorted(failed));
    });

    it("finds a send to a mixed-case address by recipient in any case", async () => {
      const created = await fetch(`${CORE_URL}/v1/notifications`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sendToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: "email",
          recipients: [{ address: "Ops@Acme.com" }],
          content: { subject: "Mixed case", text: "Hello" },
        }),
      });
      expect(created.status).toBe(202);
      const { id } = (await created.json()) as { id: string };

      for (const address of ["ops@acme.com", "OPS@ACME.COM"]) {
        const res = await api(
          "GET",
          `?filter[recipient]=${encodeURIComponent(address)}`,
          readToken
        );
        expect(res.body.data.map((n: { id: string }) => n.id)).toEqual([id]);
      }
      const row = await prisma.notification.findFirstOrThrow({
        where: { id },
        include: { deliveries: true },
      });
      expect(row.recipients).toEqual([{ address: "ops@acme.com", as: "to" }]);
      expect(row.deliveries[0].recipients).toEqual([
        { address: "ops@acme.com", as: "to" },
      ]);
    });

    it("answers the list without content or secrets", async () => {
      await seed();
      const [row] = (await api("GET", "", readToken)).body.data;
      expect(row).toMatchObject({
        channel: "email",
        status: "sent",
        senderUserId: SYSTEM_USER_ID,
        sender: SYSTEM_USER,
      });
      expect(row).not.toHaveProperty("content");
    });

    it("lists each send's summary and its latest delivery's sentAt", async () => {
      const early = new Date(Date.now() - 120_000);
      const late = new Date(Date.now() - 60_000);
      const sent = await seed({
        summary: "Invoice 1042",
        addresses: ["a@example.com", "b@example.com"],
        deliveryStatuses: ["sent", "sent"],
        sentAt: [early, late],
        createdAt: new Date(Date.now() - 180_000),
      });
      const unsent = await seed({
        status: "failed",
        deliveryStatuses: ["failed"],
        summary: null,
      });
      const partial = await seed({
        status: "partial",
        addresses: ["a@example.com", "b@example.com"],
        deliveryStatuses: ["sent", "failed"],
        sentAt: [early, null],
      });
      const rows = (await api("GET", "", readToken)).body.data;
      const byId = Object.fromEntries(
        rows.map((n: { id: string }) => [n.id, n])
      );
      expect(byId[sent.id]).toMatchObject({
        summary: "Invoice 1042",
        sentAt: late.toISOString(),
      });
      expect(byId[sent.id]).not.toHaveProperty("deliveries");
      expect(byId[unsent.id]).toMatchObject({ summary: null, sentAt: null });
      expect(byId[partial.id].sentAt).toBe(early.toISOString());
    });
  });
});
