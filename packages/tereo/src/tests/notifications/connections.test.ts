import { openConnectionSecrets } from "../../utils/notifications/connections.js";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { DEFAULT_ORGANIZATION_ID } from "../../definitions/index.js";
import { getTestPrincipalToken } from "../utils/principals.js";
import { createServer, type AddressInfo } from "net";
import { prisma } from "../../utils/db/prisma.js";
import { currentKek } from "../../utils/keys.js";
import { randomBytes, randomUUID } from "crypto";
import { CORE_URL } from "../utils/coreUrl.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../webhooks/utils/test-helpers.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../utils/fakeSmtpServer.js";

const BASE = `${CORE_URL}/v1/admin/notifications`;

let adminToken: string;
let readToken: string;
let sendOnlyToken: string;
let smtp: FakeSmtpServer;
let smtpCode = 250;
let adminUserId: string;

const rand = () => randomBytes(4).toString("hex");

const api = async (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (text ? JSON.parse(text) : null) as any,
  };
};

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
  readToken = await getTestPrincipalToken({
    permissions: ["notifications.read"],
  });
  sendOnlyToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });
  smtp = await startFakeSmtpServer({ reply: () => smtpCode });
  await clean();
});

afterEach(() => {
  smtpCode = 250;
  smtp.messages.length = 0;
});

afterAll(async () => {
  await smtp.close();
  await clean();
});

describe("connections admin API", () => {
  describe("authorization", () => {
    it("requires authentication", async () => {
      expect((await api("GET", "/connections", null)).status).toBe(401);
    });

    it("refuses a caller with neither read nor admin", async () => {
      expect((await api("GET", "/connections", sendOnlyToken)).status).toBe(
        403
      );
    });

    it("lets .read list and get, but not write", async () => {
      await clean();
      const c = await create();
      const list = await api("GET", "/connections", readToken);
      expect(list.status).toBe(200);
      expect(list.body.data.map((x: { id: string }) => x.id)).toContain(c.id);
      expect((await api("GET", `/connections/${c.id}`, readToken)).status).toBe(
        200
      );

      expect(
        (await api("POST", "/connections", readToken, payload())).status
      ).toBe(403);
      expect(
        (await api("PATCH", `/connections/${c.id}`, readToken, {})).status
      ).toBe(403);
      expect(
        (await api("DELETE", `/connections/${c.id}`, readToken)).status
      ).toBe(403);
      expect(
        (await api("POST", `/connections/${c.id}/default`, readToken)).status
      ).toBe(403);
      expect(
        (
          await api("POST", `/connections/${c.id}/test`, readToken, {
            to: "a@b.com",
          })
        ).status
      ).toBe(403);
    });
  });

  describe("create", () => {
    it("validates settings with the adapter and reports field issues", async () => {
      const res = await api(
        "POST",
        "/connections",
        adminToken,
        payload({ settings: { host: "", port: 99999 } })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_settings");
      const paths = res.body.issues.map((i: { path: string }) => i.path);
      expect(paths).toContain("host");
      expect(paths).toContain("port");
    });

    it("validates secrets with the adapter", async () => {
      const res = await api(
        "POST",
        "/connections",
        adminToken,
        payload({ secrets: { password: 42 } })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_secrets");
    });

    it("rejects an unknown channel and a bad slug", async () => {
      expect(
        (
          await api(
            "POST",
            "/connections",
            adminToken,
            payload({ channel: "sms" })
          )
        ).status
      ).toBe(400);
      expect(
        (
          await api(
            "POST",
            "/connections",
            adminToken,
            payload({ slug: "Bad Slug" })
          )
        ).status
      ).toBe(400);
    });

    it("seals secrets as kek1 and never returns them", async () => {
      const c = await create({ secrets: { password: "hunter2-secret" } });
      expect(c.hasSecrets).toBe(true);
      expect(JSON.stringify(c)).not.toContain("hunter2-secret");
      expect(c).not.toHaveProperty("secrets");
      expect(c.createdBy).toBe(adminUserId);

      const row = await prisma.notificationConnection.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(row.secrets).toMatch(/^kek1:/);
      expect(row.secrets).not.toContain("hunter2-secret");

      const got = await api("GET", `/connections/${c.id}`, readToken);
      expect(got.body.hasSecrets).toBe(true);
      expect(got.body).not.toHaveProperty("secrets");
      const list = await api("GET", "/connections", readToken);
      expect(JSON.stringify(list.body)).not.toContain("hunter2-secret");
      expect(JSON.stringify(list.body)).not.toContain("kek1:");
    });

    it("reports hasSecrets false without secrets", async () => {
      const c = await create();
      expect(c.hasSecrets).toBe(false);
    });

    it("conflicts on a duplicate slug within a channel", async () => {
      const c = await create();
      const res = await api(
        "POST",
        "/connections",
        adminToken,
        payload({ slug: c.slug })
      );
      expect(res.status).toBe(409);
    });

    it("makes the first connection of a channel the default", async () => {
      await clean();
      const first = await create();
      const second = await create();
      expect(first.isDefault).toBe(true);
      expect(second.isDefault).toBe(false);
    });
  });

  describe("get, list, update", () => {
    it("filters the list by channel and answers 404 for an unknown id", async () => {
      const c = await create();
      const list = await api("GET", "/connections?channel=email", readToken);
      expect(list.body.data.map((x: { id: string }) => x.id)).toContain(c.id);
      expect(
        (await api("GET", `/connections/${randomUUID()}`, readToken)).status
      ).toBe(404);
      expect(
        (await api("GET", "/connections/not-a-uuid", readToken)).status
      ).toBe(400);
    });

    it("keeps secrets when PATCH omits them, replaces them when given", async () => {
      const c = await create({ secrets: { password: "first-pass" } });
      const before = await prisma.notificationConnection.findUniqueOrThrow({
        where: { id: c.id },
      });

      const renamed = await api("PATCH", `/connections/${c.id}`, adminToken, {
        displayName: "Renamed",
        isEnabled: false,
        maxPerMinute: 30,
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        displayName: "Renamed",
        isEnabled: false,
        maxPerMinute: 30,
        hasSecrets: true,
      });
      const kept = await prisma.notificationConnection.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(kept.secrets).toBe(before.secrets);

      await api("PATCH", `/connections/${c.id}`, adminToken, {
        secrets: { password: "second-pass" },
      });
      const replaced = await prisma.notificationConnection.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(replaced.secrets).not.toBe(before.secrets);
      expect(replaced.secrets).toMatch(/^kek1:/);

      const cleared = await api("PATCH", `/connections/${c.id}`, adminToken, {
        secrets: null,
      });
      expect(cleared.body.hasSecrets).toBe(false);
    });

    it("validates changed settings and leaves the row alone on failure", async () => {
      const c = await create();
      const res = await api("PATCH", `/connections/${c.id}`, adminToken, {
        settings: settings(2525, { allowedSenders: ["@other.com"] }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_settings");
      const got = await api("GET", `/connections/${c.id}`, readToken);
      expect(got.body.settings.allowedSenders).toEqual(["@acme.com"]);
    });

    it("checks for stored secrets under the row's lock, not before it", async () => {
      const c = await create();
      const withSecrets = await prisma.notificationConnection.findUniqueOrThrow(
        { where: { id: (await create({ secrets: { password: "p" } })).id } }
      );

      let patch: ReturnType<typeof api> | undefined;
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT 1 FROM "notifications"."connections"
          WHERE "id" = ${c.id}::uuid FOR UPDATE`;
        // Arrives while the row has no secrets, then waits for the lock.
        patch = api("PATCH", `/connections/${c.id}`, adminToken, {
          settings: settings(2525, { host: "smtp.elsewhere.example" }),
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        // A concurrent update stores secrets meanwhile.
        await tx.notificationConnection.update({
          where: { id: c.id },
          data: { secrets: withSecrets.secrets },
        });
      });

      const res = await patch!;
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("secrets_required");
    });

    it("needs the secrets again to change where they are sent", async () => {
      const c = await create({ secrets: { password: "stored-pass" } });
      const before = await prisma.notificationConnection.findUniqueOrThrow({
        where: { id: c.id },
      });

      for (const over of [
        { host: "smtp.elsewhere.example" },
        { port: 2526 },
        { security: "starttls" },
        { username: "someone-else" },
      ]) {
        const res = await api("PATCH", `/connections/${c.id}`, adminToken, {
          settings: settings(2525, over),
        });
        expect(res.status, JSON.stringify(over)).toBe(400);
        expect(res.body.error).toBe("secrets_required");
      }
      const unchanged = await prisma.notificationConnection.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(unchanged.settings).toEqual(before.settings);

      // Other settings may change without them.
      const other = await api("PATCH", `/connections/${c.id}`, adminToken, {
        settings: settings(2525, {
          defaultFrom: { address: "ops@acme.com", name: "Ops" },
        }),
      });
      expect(other.status, JSON.stringify(other.body)).toBe(200);
      expect(other.body.settings.defaultFrom.address).toBe("ops@acme.com");

      const moved = await api("PATCH", `/connections/${c.id}`, adminToken, {
        settings: settings(2526, { host: "localhost" }),
        secrets: { password: "new-server-pass" },
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body.settings.host).toBe("localhost");
    });

    it("lets a connection without secrets move freely", async () => {
      const c = await create();
      const res = await api("PATCH", `/connections/${c.id}`, adminToken, {
        settings: settings(2526),
      });
      expect(res.status).toBe(200);
    });

    it("refuses to change the slug or channel", async () => {
      const c = await create();
      const res = await api("PATCH", `/connections/${c.id}`, adminToken, {
        slug: "other",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("default", () => {
    it("moves the default, leaving exactly one", async () => {
      await clean();
      const a = await create();
      const b = await create();
      expect(a.isDefault).toBe(true);

      const res = await api("POST", `/connections/${b.id}/default`, adminToken);
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);

      const rows = await prisma.notificationConnection.findMany({
        where: { channel: "email", isDefault: true },
      });
      expect(rows.map((r) => r.id)).toEqual([b.id]);
      expect(
        (await api("GET", `/connections/${a.id}`, readToken)).body.isDefault
      ).toBe(false);
    });

    it("is idempotent for the current default", async () => {
      await clean();
      const a = await create();
      const res = await api("POST", `/connections/${a.id}/default`, adminToken);
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);
    });
  });

  describe("delete", () => {
    it("deletes an unreferenced connection", async () => {
      const c = await create();
      const res = await api("DELETE", `/connections/${c.id}`, adminToken);
      expect(res.status).toBe(204);
      expect((await api("GET", `/connections/${c.id}`, readToken)).status).toBe(
        404
      );
    });

    it("refuses with connection_in_use once a delivery references it", async () => {
      const c = await create();
      const sender = await prisma.user.findFirstOrThrow({
        where: { id: adminUserId },
      });
      const notification = await prisma.notification.create({
        data: {
          channel: "email",
          connectionId: c.id,
          senderUserId: sender.id,
          recipients: [],
          attachments: [],
        },
      });
      await prisma.notificationDelivery.create({
        data: {
          notificationId: notification.id,
          notificationCreatedAt: notification.createdAt,
          connectionId: c.id,
          recipients: [],
        },
      });

      const res = await api("DELETE", `/connections/${c.id}`, adminToken);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("connection_in_use");
      expect((await api("GET", `/connections/${c.id}`, readToken)).status).toBe(
        200
      );
    });

    it("refuses the default while the channel has another connection", async () => {
      await clean();
      const a = await create();
      const b = await create();

      const refused = await api("DELETE", `/connections/${a.id}`, adminToken);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("connection_is_default");

      expect(
        (await api("DELETE", `/connections/${b.id}`, adminToken)).status
      ).toBe(204);
      expect(
        (await api("DELETE", `/connections/${a.id}`, adminToken)).status
      ).toBe(204);
    });

    it("refuses when only a notification references it", async () => {
      const c = await create();
      await prisma.notification.create({
        data: {
          channel: "email",
          connectionId: c.id,
          senderUserId: adminUserId,
          recipients: [],
          attachments: [],
        },
      });
      const res = await api("DELETE", `/connections/${c.id}`, adminToken);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("connection_in_use");
    });
  });

  describe("test send", () => {
    it("answers ok with the provider response, using the stored secrets", async () => {
      const c = await create({
        settings: settings(smtp.port, { username: "mailer" }),
        secrets: { password: "smtp-pass" },
      });
      const res = await api("POST", `/connections/${c.id}/test`, adminToken, {
        to: "dest@example.com",
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.providerResponse).toBe("string");
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0].rcpt).toEqual(["dest@example.com"]);
      expect(smtp.messages[0].auth).toEqual({
        user: "mailer",
        pass: "smtp-pass",
      });
    });

    it("answers ok false with the error when the provider refuses", async () => {
      smtpCode = 550;
      const c = await create({ settings: settings(smtp.port) });
      const res = await api("POST", `/connections/${c.id}/test`, adminToken, {
        to: "dest@example.com",
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toEqual(expect.any(String));
      expect(res.body.error).toContain("550");
    });

    it("reports a code, not what a non-SMTP service answered", async () => {
      const banner = createServer((socket) =>
        socket.end("SSH-2.0-OpenSSH_9.6 secret-build-banner\r\n")
      );
      await new Promise<void>((r) => banner.listen(0, "127.0.0.1", r));
      try {
        const { port } = banner.address() as AddressInfo;
        const c = await create({ settings: settings(port) });
        const res = await api("POST", `/connections/${c.id}/test`, adminToken, {
          to: "dest@example.com",
        });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).not.toContain("secret-build-banner");
      } finally {
        await new Promise((r) => banner.close(r));
      }
    });

    it("rejects an invalid recipient with 400 and an unknown id with 404", async () => {
      const c = await create({ settings: settings(smtp.port) });
      expect(
        (
          await api("POST", `/connections/${c.id}/test`, adminToken, {
            to: "nope",
          })
        ).status
      ).toBe(400);
      expect(
        (
          await api("POST", `/connections/${randomUUID()}/test`, adminToken, {
            to: "a@b.com",
          })
        ).status
      ).toBe(404);
      expect(smtp.messages).toHaveLength(0);
    });
  });

  describe("channels", () => {
    it("lists email with JSON schemas of its settings and secrets", async () => {
      const res = await api("GET", "/channels", readToken);
      expect(res.status).toBe(200);
      const email = res.body.data.find(
        (c: { channel: string }) => c.channel === "email"
      );
      expect(email.settingsSchema.type).toBe("object");
      expect(email.settingsSchema.properties).toHaveProperty("host");
      expect(email.secretsSchema.properties).toHaveProperty("password");
    });
  });

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

  describe("opening secrets", () => {
    const storePlain = async (password: string) => {
      const c = await create();
      return prisma.notificationConnection.update({
        where: { id: c.id },
        data: { secrets: JSON.stringify({ password }) },
      });
    };

    it("reseals a value not under the current KEK, leaving updatedAt alone", async () => {
      const row = await storePlain("old-kek-pw");
      const opened = await openConnectionSecrets(row);
      expect(opened).toEqual({ password: "old-kek-pw" });

      const after = await prisma.notificationConnection.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.secrets).toMatch(new RegExp(`^kek1:${currentKek().id}:`));
      expect(after.updatedAt).toEqual(row.updatedAt);
      expect(await openConnectionSecrets(after)).toEqual({
        password: "old-kek-pw",
      });
    });

    it("does not overwrite secrets changed since they were read", async () => {
      const row = await storePlain("stale-pw");
      const newer = await prisma.notificationConnection.update({
        where: { id: row.id },
        data: { secrets: JSON.stringify({ password: "newer-pw" }) },
      });

      expect(await openConnectionSecrets(row)).toEqual({
        password: "stale-pw",
      });
      const after = await prisma.notificationConnection.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.secrets).toBe(newer.secrets);
    });
  });
});
