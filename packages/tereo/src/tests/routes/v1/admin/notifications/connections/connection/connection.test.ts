// @module-tag int
// @module-tag notifications
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../../support/http.js";
import { createServer, type AddressInfo } from "net";
import { randomBytes, randomUUID } from "crypto";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../../../../../../support/fakeSmtpServer.js";

const BASE = `${CORE_URL}/v1/admin/notifications`;

let adminToken: string;
let readToken: string;

let smtp: FakeSmtpServer;
let smtpCode = 250;
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
  readToken = await getTestPrincipalToken({
    permissions: ["notifications.read"],
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

describe("/v1/admin/notifications/connections/:id", () => {
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

    it("audits a send whatever its outcome", async () => {
      smtpCode = 550;
      const c = await create({ settings: settings(smtp.port) });
      const res = await api("POST", `/connections/${c.id}/test`, adminToken, {
        to: "dest@example.com",
      });
      expect(res.body.ok).toBe(false);
      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityType: "NotificationConnection", entityId: c.id },
        orderBy: { createdAt: "desc" },
      });
      expect(entry.metadata).toEqual({
        operation: "test",
        to: "dest@example.com",
      });
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
});
