// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { waitFor } from "../support/webhooks.js";
import { randomBytes } from "node:crypto";
import env from "../../env.js";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "../../jobs/notificationDelivery.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../support/fakeSmtpServer.js";
import {
  cleanNotifications,
  createNotificationConnection,
} from "../support/notifications.js";
import {
  issuePasswordLink,
  issueVerifyLink,
  markEmailVerified,
  retireAllLinks,
  retirePasswordLinks,
} from "../../utils/userLinks.js";

const createUser = () => {
  const id = randomBytes(6).toString("hex");
  return prisma.user.create({
    data: { email: `link-${id}@test.local`, name: `Link ${id}` },
  });
};

const issueReset = (userId: string, clientId?: string) =>
  prisma.$transaction((tx) =>
    issuePasswordLink(tx, {
      userId,
      purpose: "reset",
      createdBy: SYSTEM_USER_ID,
      notify: true,
      clientId,
    })
  );

const issueVerify = (userId: string) =>
  prisma.$transaction((tx) =>
    issueVerifyLink(tx, { userId, createdBy: SYSTEM_USER_ID })
  );

describe("userLinks", () => {
  const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
  let smtp: FakeSmtpServer;

  beforeAll(async () => {
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
    await ensureDefaultOrganization();
    smtp = await startFakeSmtpServer();
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

  const withConnection = () =>
    createNotificationConnection({
      isDefault: true,
      settings: {
        host: "127.0.0.1",
        port: smtp.port,
        security: "none",
        defaultFrom: { address: "billing@acme.com" },
        allowedSenders: ["@acme.com"],
      },
    });

  it("a reset link retires a live setup link", async () => {
    await withConnection();
    const user = await createUser();
    await prisma.$transaction((tx) =>
      issuePasswordLink(tx, {
        userId: user.id,
        purpose: "setup",
        createdBy: SYSTEM_USER_ID,
        notify: false,
      })
    );
    await issueReset(user.id);

    const rows = await prisma.userLinkToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.purpose)).toEqual(["setup", "reset"]);
    expect(rows[0].usedAt).not.toBeNull();
    expect(rows.filter((r) => r.usedAt === null)).toHaveLength(1);
  });

  it("a reset link carries client_id in the query and the token in the fragment", async () => {
    await withConnection();
    const user = await createUser();
    const { url } = await issueReset(user.id, "app-1");

    expect(url).toMatch(
      /\/set-password\?client_id=app-1#token=[A-Za-z0-9_-]{43}$/
    );
  });

  it("a reset email says it can be ignored", async () => {
    await withConnection();
    const user = await createUser();
    await issueReset(user.id);

    await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
    const [message] = smtp.messages;
    expect(message.parsed.subject).toBe("Reset your password");
    expect(message.parsed.text).toContain("your password hasn't changed");
  });

  it("a verify link stores the address and never returns a URL", async () => {
    await withConnection();
    const user = await createUser();
    const result = await issueVerify(user.id);

    expect(result).not.toHaveProperty("url");
    expect(result.expiresAt).toBeInstanceOf(Date);
    const row = await prisma.userLinkToken.findFirstOrThrow({
      where: { userId: user.id, purpose: "verify" },
    });
    expect(row.email).toBe(user.email);
    await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
    expect(smtp.messages[0].parsed.subject).toBe("Confirm your email address");
    expect(smtp.messages[0].parsed.text).toMatch(/\/verify-email#token=/);
  });

  it("issueVerifyLink without a default connection is email_not_configured", async () => {
    const user = await createUser();

    await expect(issueVerify(user.id)).rejects.toMatchObject({
      code: "email_not_configured",
    });
    expect(
      await prisma.userLinkToken.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("retireAllLinks retires password and verify links; retirePasswordLinks keeps verify", async () => {
    await withConnection();
    const user = await createUser();
    const live = (purpose: "setup" | "reset" | "verify") =>
      prisma.userLinkToken.count({
        where: { userId: user.id, purpose, usedAt: null },
      });

    await issueReset(user.id);
    await issueVerify(user.id);
    await prisma.$transaction((tx) => retirePasswordLinks(tx, user.id));
    expect(await live("reset")).toBe(0);
    expect(await live("verify")).toBe(1);

    await issueReset(user.id);
    await prisma.$transaction((tx) => retireAllLinks(tx, user.id));
    expect(await live("reset")).toBe(0);
    expect(await live("verify")).toBe(0);
  });

  it("markEmailVerified writes once", async () => {
    const user = await createUser();
    const verifiedEvents = async () =>
      (await prisma.outbox.findMany({ where: { destination: "webhook" } }))
        .map(
          (r) =>
            r.payload as {
              eventType: string;
              entityId: string;
              data: { via: string };
            }
        )
        .filter(
          (p) =>
            p.eventType === "auth.user.email-verified" && p.entityId === user.id
        );

    const first = await prisma.$transaction((tx) =>
      markEmailVerified(tx, { userId: user.id, via: "link" })
    );
    const second = await prisma.$transaction((tx) =>
      markEmailVerified(tx, { userId: user.id, via: "link" })
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    const events = await verifiedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].data.via).toBe("link");
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.emailVerifiedAt).not.toBeNull();
  });
});
