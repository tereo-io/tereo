// @module-tag int
// @module-tag notifications
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { cleanNotifications } from "../../../../../support/notifications.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  connectionsApi,
  connectionPayload,
  createConnection,
} from "../../../../../support/notificationConnections.js";

let adminToken: string;
let readToken: string;

let adminUserId: string;

const create = (over: Record<string, unknown> = {}) =>
  createConnection(adminToken, over);

beforeAll(async () => {
  adminUserId = randomUUID();
  adminToken = await getTestPrincipalToken({
    userId: adminUserId,
    permissions: ["notifications.admin", "notifications.read"],
  });
  readToken = await getTestPrincipalToken({
    permissions: ["notifications.read"],
  });

  await cleanNotifications();
});

afterAll(async () => {
  await cleanNotifications();
});

describe("/v1/admin/notifications/connections", () => {
  describe("list", () => {
    it("filters the list by channel (GET /connections?channel=email)", async () => {
      const c = await create();
      const list = await connectionsApi(
        "GET",
        "/connections?channel=email",
        readToken
      );
      expect(list.body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    });

    describe("lastDeliveryError", () => {
      const deliver = async (
        connectionId: string,
        delivery: { status: "pending" | "sent" | "failed"; lastError?: string }
      ) => {
        const notification = await prisma.notification.create({
          data: {
            channel: "email",
            connectionId,
            senderUserId: adminUserId,
            recipients: [],
            attachments: [],
          },
        });
        await prisma.notificationDelivery.create({
          data: {
            notificationId: notification.id,
            notificationCreatedAt: notification.createdAt,
            connectionId,
            recipients: [],
            attempts: 1,
            ...delivery,
          },
        });
      };

      const lastErrorOf = async (id: string) => {
        const list = await connectionsApi("GET", "/connections", readToken);
        return list.body.data.find((x: { id: string }) => x.id === id)
          .lastDeliveryError;
      };

      it("is null for a connection that has not sent", async () => {
        const c = await create();

        expect(await lastErrorOf(c.id)).toBeNull();
      });

      it("reports a delivery waiting to retry after an error", async () => {
        const c = await create();
        await deliver(c.id, {
          status: "pending",
          lastError: "Connection closed unexpectedly",
        });

        expect(await lastErrorOf(c.id)).toEqual({
          message: "Connection closed unexpectedly",
          at: expect.any(String),
        });
      });

      it("clears once a later delivery is sent", async () => {
        const c = await create();
        await deliver(c.id, { status: "failed", lastError: "refused" });
        await deliver(c.id, { status: "sent" });

        expect(await lastErrorOf(c.id)).toBeNull();
      });
    });
  });

  describe("create", () => {
    it("validates settings with the adapter and reports field issues", async () => {
      const res = await connectionsApi(
        "POST",
        "/connections",
        adminToken,
        connectionPayload({ settings: { host: "", port: 99999 } })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_settings");
      expect(res.body.error_description).toEqual(expect.any(String));
      const paths = res.body.issues.map((i: { path: string }) => i.path);
      expect(paths).toContain("host");
      expect(paths).toContain("port");
    });

    it("validates secrets with the adapter", async () => {
      const res = await connectionsApi(
        "POST",
        "/connections",
        adminToken,
        connectionPayload({ secrets: { password: 42 } })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_secrets");
    });

    it("rejects an unknown channel and a bad slug", async () => {
      const res = await connectionsApi(
        "POST",
        "/connections",
        adminToken,
        connectionPayload({ channel: "sms" })
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(res.body.error_description).toEqual(expect.any(String));
      expect(
        (
          await connectionsApi(
            "POST",
            "/connections",
            adminToken,
            connectionPayload({ slug: "Bad Slug" })
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

      const got = await connectionsApi(
        "GET",
        `/connections/${c.id}`,
        readToken
      );
      expect(got.body.hasSecrets).toBe(true);
      expect(got.body).not.toHaveProperty("secrets");
      const list = await connectionsApi("GET", "/connections", readToken);
      expect(JSON.stringify(list.body)).not.toContain("hunter2-secret");
      expect(JSON.stringify(list.body)).not.toContain("kek1:");
    });

    it("reports hasSecrets false without secrets", async () => {
      const c = await create();
      expect(c.hasSecrets).toBe(false);
    });

    it("conflicts on a duplicate slug within a channel", async () => {
      const c = await create();
      const res = await connectionsApi(
        "POST",
        "/connections",
        adminToken,
        connectionPayload({ slug: c.slug })
      );
      expect(res.status).toBe(409);
    });

    it("makes the first connection of a channel the default", async () => {
      await cleanNotifications();
      const first = await create();
      const second = await create();
      expect(first.isDefault).toBe(true);
      expect(second.isDefault).toBe(false);
    });
  });
});
