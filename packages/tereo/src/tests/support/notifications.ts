import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "./coreUrl.js";
import { fetchJson } from "./http.js";
import { randomBytes } from "crypto";
import { expect } from "vitest";

const BASE = `${CORE_URL}/v1/notifications`;

const rand = () => randomBytes(4).toString("hex");

export const notificationsApi = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${BASE}${path}`, token, body);

export const notificationConnectionSettings = {
  host: "127.0.0.1",
  port: 2525,
  security: "none",
  defaultFrom: { address: "billing@acme.com" },
  allowedSenders: ["@acme.com"],
};

export const cleanNotifications = async () => {
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationConnection.deleteMany();
};

export const createNotificationConnection = (
  over: Record<string, unknown> = {}
) =>
  prisma.notificationConnection.create({
    data: {
      channel: "email",
      slug: `c-${rand()}`,
      displayName: "Test",
      settings: notificationConnectionSettings,
      createdBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
      ...over,
    },
  });

export const currentVersion = async (id: string) =>
  (await prisma.objectVersion.findFirstOrThrow({
    where: { objectId: id, isCurrent: true },
    include: { contentBlob: true },
  }))!;

export const notificationMessage = (
  connection: string,
  over: Record<string, unknown> = {}
) => ({
  channel: "email",
  connection,
  recipients: [{ address: "ops@example.com" }],
  content: { subject: "Invoice 1042", text: "Hello" },
  ...over,
});

export const sendNotification = (token: string, body: unknown) =>
  notificationsApi("POST", "", token, body);

export const expectError = (
  res: { status: number; body: { error?: string } },
  status: number,
  code: string
) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.error).toBe(code);
};
