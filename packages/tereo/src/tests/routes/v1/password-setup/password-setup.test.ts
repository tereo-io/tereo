// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { issuePasswordSetupLink } from "../../../../utils/passwordSetup.js";
import { loginAndExchange, postForm } from "../../../support/auth/login.js";
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { getTestPrincipalToken } from "../../../support/principals.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { SYSTEM_USER_ID } from "../../../../definitions/index.js";
import { createTestUser } from "../../../support/auth/users.js";
import { hashFlowToken } from "../../../../utils/crypto.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { waitFor } from "../../../support/webhooks.js";
import { randomBytes } from "node:crypto";
import env from "../../../../env.js";
import axios from "axios";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "../../../../jobs/notificationDelivery.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../../../support/fakeSmtpServer.js";
import {
  cleanNotifications,
  createNotificationConnection,
} from "../../../support/notifications.js";

const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "openid offline_access";
const NEW_PASSWORD = "BrandNewPassword123!";

const post = (path: string, body: unknown, headers: object = {}) =>
  axios.post(`${BASE_URL}/v1/password-setup${path}`, body, {
    validateStatus: () => true,
    headers,
  });

const inspect = (token: string) => post("/inspect", { token });
const setPassword = (token: string, password = NEW_PASSWORD) =>
  post("", { token, password });

const createGuest = async (over: { expiresAt?: Date | null } = {}) => {
  const id = randomBytes(6).toString("hex");
  return prisma.user.create({
    data: {
      email: `guest-${id}@test.local`,
      name: `Guest ${id}`,
      userType: "guest",
      passwordHash: null,
      passwordChangeRequired: true,
      expiresAt:
        over.expiresAt === undefined
          ? new Date(Date.now() + 86_400_000)
          : over.expiresAt,
    },
  });
};

const issue = async (userId: string, notify = false) => {
  const { url } = await prisma.$transaction((tx) =>
    issuePasswordSetupLink(tx, { userId, createdBy: SYSTEM_USER_ID, notify })
  );
  return new URL(url).hash.replace("#token=", "");
};

const insertToken = (
  userId: string,
  over: { usedAt?: Date; expiresAt?: Date } = {}
) => {
  const token = randomBytes(32).toString("base64url");
  return prisma.passwordSetupToken
    .create({
      data: {
        userId,
        tokenHash: hashFlowToken(token),
        createdBy: SYSTEM_USER_ID,
        expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000),
        usedAt: over.usedAt,
      },
    })
    .then(() => token);
};

describe("password setup", () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    await ensureDefaultOrganization();
    client = await createTestClient({ redirectUris: [REDIRECT_URI] });
  });

  describe("POST /v1/password-setup/inspect", () => {
    it("returns email and name without consuming", async () => {
      const guest = await createGuest();
      const token = await issue(guest.id);

      for (let i = 0; i < 2; i++) {
        const res = await inspect(token);
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data).toEqual({ email: guest.email, name: guest.name });
      }
    });
  });

  describe("POST /v1/password-setup", () => {
    it("sets the password, then the user signs in", async () => {
      const guest = await createGuest();
      const token = await issue(guest.id);

      const res = await setPassword(token);
      expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);

      const tokens = await loginAndExchange(
        client,
        { email: guest.email, plainPassword: NEW_PASSWORD },
        REDIRECT_URI,
        SCOPE
      );
      expect(tokens.access_token).toBeTruthy();

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(after.passwordChangeRequired).toBe(false);
    });

    it("answers a used, expired or unknown token and an expired guest with the same 404", async () => {
      const guest = await createGuest();
      const used = await insertToken(guest.id, { usedAt: new Date() });
      const expired = await insertToken(guest.id, {
        expiresAt: new Date(Date.now() - 1000),
      });
      const unknown = randomBytes(32).toString("base64url");
      const lapsedGuest = await createGuest({
        expiresAt: new Date(Date.now() - 1000),
      });
      const lapsed = await insertToken(lapsedGuest.id);
      const inactive = await createTestUser({ isActive: false });
      const inactiveToken = await insertToken(inactive.id);

      const bodies = new Set<string>();
      for (const token of [used, expired, unknown, lapsed, inactiveToken]) {
        for (const send of [inspect, setPassword]) {
          const res = await send(token);
          expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
          bodies.add(JSON.stringify(res.data));
        }
      }
      expect(bodies.size).toBe(1);
    });

    it("ends other sessions on set", async () => {
      const guest = await createGuest();
      await prisma.user.update({
        where: { id: guest.id },
        // Without the flag, so the old password signs in without the
        // forced-change step.
        data: {
          passwordHash: (await createTestUser({ password: "OldPassword123!" }))
            .passwordHash,
          passwordChangeRequired: false,
        },
      });
      const before = await loginAndExchange(
        client,
        { email: guest.email, plainPassword: "OldPassword123!" },
        REDIRECT_URI,
        SCOPE
      );
      const token = await issue(guest.id);

      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

      const res = await postForm("/oauth/token", {
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: before.refresh_token,
      });
      expect(res.status).toBe(400);
    });

    it(
      "lets exactly one of two concurrent sets succeed",
      { tags: ["race"] },
      async () => {
        const guest = await createGuest();
        const token = await issue(guest.id);

        const results = await Promise.all([
          setPassword(token, "FirstPassword123!"),
          setPassword(token, "SecondPassword123!"),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
      }
    );

    it("kills the old link when a new one is issued", async () => {
      const guest = await createGuest();
      const first = await issue(guest.id);
      const second = await issue(guest.id);

      expect((await inspect(first)).status).toBe(HTTP_STATUS.NOT_FOUND);
      expect((await inspect(second)).status).toBe(HTTP_STATUS.OK);
    });

    it("answers 404 and keeps the password when the user is deactivated after inspect", async () => {
      const guest = await createGuest();
      const token = await issue(guest.id);
      expect((await inspect(token)).status).toBe(HTTP_STATUS.OK);

      await prisma.user.update({
        where: { id: guest.id },
        data: { isActive: false },
      });

      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(after.passwordHash).toBeNull();
      expect(after.passwordChangeRequired).toBe(true);
    });

    it(
      "lets two concurrent issues both succeed, leaving one live token",
      { tags: ["race"] },
      async () => {
        const guest = await createGuest();

        await Promise.all([issue(guest.id), issue(guest.id)]);

        expect(
          await prisma.passwordSetupToken.count({
            where: { userId: guest.id, usedAt: null },
          })
        ).toBe(1);
      }
    );

    it("rejects a weak password with 400 and leaves the token usable", async () => {
      const guest = await createGuest();
      const token = await issue(guest.id);

      expect((await setPassword(token, "short")).status).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NO_CONTENT);
    });

    it("limits bad attempts per IP", async () => {
      const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
      const headers = { "X-Forwarded-For": ip };
      const bad = () =>
        post("", { token: "nope", password: NEW_PASSWORD }, headers);

      for (let i = 0; i < 10; i++) {
        expect((await bad()).status).toBe(HTTP_STATUS.NOT_FOUND);
      }
      expect((await bad()).status).toBe(429);
    });
  });

  describe("issuePasswordSetupLink with notify", () => {
    const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
    let smtp: FakeSmtpServer;

    beforeAll(async () => {
      env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
      smtp = await startFakeSmtpServer();
      // The server does not run the delivery worker under test.
      await startNotificationDeliveryWorker();
    });
    beforeEach(async () => {
      smtp.messages.length = 0;
      await cleanNotifications();
    });
    afterAll(async () => {
      await stopNotificationDeliveryWorker();
      await getNotificationQueue("email")
        .obliterate({ force: true })
        .catch(() => {});
      await closeNotificationQueues();
      await cleanNotifications();
      await smtp.close();
      env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
    });

    it("refuses without an email connection and writes nothing", async () => {
      const guest = await createGuest();

      await expect(issue(guest.id, true)).rejects.toMatchObject({
        code: "email_not_configured",
        statusCode: 409,
      });
      expect(
        await prisma.passwordSetupToken.count({ where: { userId: guest.id } })
      ).toBe(0);
      expect(await prisma.notification.count()).toBe(0);
    });

    it("sends the link to the user's address", async () => {
      await createNotificationConnection({
        isDefault: true,
        settings: {
          host: "127.0.0.1",
          port: smtp.port,
          security: "none",
          defaultFrom: { address: "billing@acme.com" },
          allowedSenders: ["@acme.com"],
        },
      });
      const guest = await createGuest();
      const token = await issue(guest.id, true);

      await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
      const [message] = smtp.messages;
      expect(message.rcpt).toEqual([guest.email]);
      expect(message.parsed.text).toContain(`/set-password#token=${token}`);
    });

    const smtpSettings = (port: number) => ({
      host: "127.0.0.1",
      port,
      security: "none",
      defaultFrom: { address: "billing@acme.com" },
      allowedSenders: ["@acme.com"],
    });

    const notificationOfUser = async (email: string) => {
      let found: Awaited<ReturnType<typeof prisma.notification.findFirst>> =
        null;
      await waitFor(
        async () => {
          found = await prisma.notification.findFirst({
            where: { recipients: { path: ["0", "address"], equals: email } },
          });
          return found !== null;
        },
        5000,
        50
      );
      return found!;
    };

    it("marks the notification sensitive and drops its content once sent", async () => {
      await createNotificationConnection({
        isDefault: true,
        settings: smtpSettings(smtp.port),
      });
      const guest = await createGuest();
      await issue(guest.id, true);
      const n = await notificationOfUser(guest.email);
      expect(n.sensitive).toBe(true);

      await waitFor(
        async () =>
          (await prisma.notification.findFirstOrThrow({ where: { id: n.id } }))
            .status === "sent",
        10_000,
        50
      );
      const done = await prisma.notification.findFirstOrThrow({
        where: { id: n.id },
      });
      expect(done.content).toBeNull();
    });

    it("drops the content once the delivery has failed", async () => {
      const refusing = await startFakeSmtpServer({ reply: () => 550 });
      try {
        await createNotificationConnection({
          isDefault: true,
          settings: smtpSettings(refusing.port),
        });
        const guest = await createGuest();
        await issue(guest.id, true);
        const n = await notificationOfUser(guest.email);

        await waitFor(
          async () =>
            (
              await prisma.notification.findFirstOrThrow({
                where: { id: n.id },
              })
            ).status === "failed",
          10_000,
          50
        );
        const done = await prisma.notification.findFirstOrThrow({
          where: { id: n.id },
        });
        expect(done.content).toBeNull();
      } finally {
        await refusing.close();
      }
    });

    it("does not return a pending sensitive notification's content from the log", async () => {
      const conn = await createNotificationConnection({ isDefault: true });
      const row = await prisma.notification.create({
        data: {
          channel: "email",
          connectionId: conn.id,
          senderUserId: SYSTEM_USER_ID,
          recipients: [{ address: "x@test.local" }],
          content: {
            subject: "s",
            text: "https://x/set-password#token=SECRET",
          },
          sensitive: true,
          attachments: [],
        },
      });
      const token = await getTestPrincipalToken({
        permissions: ["notifications.read"],
      });

      const res = await axios.get(
        `${BASE_URL}/v1/admin/notifications/${row.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.content).toBeNull();
      expect(res.data.contentRedacted).toBe(true);
      expect(JSON.stringify(res.data)).not.toContain("SECRET");
    });

    it("never takes `sensitive` from the public API", async () => {
      const conn = await createNotificationConnection({
        isDefault: true,
        settings: smtpSettings(smtp.port),
      });
      const token = await getTestPrincipalToken({
        permissions: ["notifications.send"],
      });

      const res = await axios.post(
        `${BASE_URL}/v1/notifications`,
        {
          channel: "email",
          connection: conn.slug,
          sensitive: true,
          recipients: [{ address: "pub@test.local" }],
          content: { subject: "s", text: "t" },
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      if (res.status === 202) {
        const row = await prisma.notification.findFirstOrThrow({
          where: { id: res.data.id },
        });
        expect(row.sensitive).toBe(false);
      } else {
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      }
    });
  });
});
