// @module-tag int
// @module-tag notifications
import { ensureDailyPartitions } from "../../../../../utils/partitions.js";
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { SYSTEM_USER_ID } from "../../../../../definitions/index.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../support/coreUrl.js";
import { fetchJson } from "../../../../support/http.js";
import { randomBytes, randomUUID } from "crypto";

const BASE = `${CORE_URL}/v1/notifications`;

const rand = () => randomBytes(4).toString("hex");

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${BASE}${path}`, token, body);

const settings = {
  host: "127.0.0.1",
  port: 2525,
  security: "none",
  defaultFrom: { address: "billing@acme.com" },
  allowedSenders: ["@acme.com"],
};

const clean = async () => {
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationConnection.deleteMany();
};

const createConnection = (over: Record<string, unknown> = {}) =>
  prisma.notificationConnection.create({
    data: {
      channel: "email",
      slug: `c-${rand()}`,
      displayName: "Test",
      settings,
      createdBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
      ...over,
    },
  });

let senderToken: string;
let otherSenderToken: string;
let readerToken: string;
let noPermToken: string;
let connectionSlug: string;

const message = (over: Record<string, unknown> = {}) => ({
  channel: "email",
  connection: connectionSlug,
  recipients: [{ address: "ops@example.com" }],
  content: { subject: "Invoice 1042", text: "Hello" },
  ...over,
});

const send = (body: unknown, token = senderToken) =>
  api("POST", "", token, body);

const expectError = (
  res: { status: number; body: { error?: string } },
  status: number,
  code: string
) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.error).toBe(code);
};

beforeAll(async () => {
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await clean();

  senderToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });
  otherSenderToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });
  readerToken = await getTestPrincipalToken({
    permissions: ["notifications.read"],
  });
  noPermToken = await getTestPrincipalToken({
    permissions: ["audit-logs.read"],
  });

  const connection = await createConnection({ isDefault: true });
  connectionSlug = connection.slug;
});

afterAll(async () => {
  await clean();
});

describe("GET /v1/notifications/:id", () => {
  describe("accepted", () => {
    let id: string;

    beforeAll(async () => {
      id = (await send(message())).body.id;
    });

    it("lets the sender read their own send, with deliveries", async () => {
      const res = await api("GET", `/${id}`, senderToken);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        id,
        status: "pending",
        summary: "Invoice 1042",
      });
      expect(res.body.deliveries).toHaveLength(1);
      expect(res.body).not.toHaveProperty("content");
    });

    it("lets notifications.read read any send", async () => {
      expect((await api("GET", `/${id}`, readerToken)).status).toBe(200);
    });

    it("hides another sender's send from a send-only caller", async () => {
      expectError(
        await api("GET", `/${id}`, otherSenderToken),
        404,
        "not_found"
      );
    });

    it("answers 404 for an unknown id", async () => {
      expectError(
        await api("GET", `/${randomUUID()}`, readerToken),
        404,
        "not_found"
      );
    });

    it("refuses a caller with neither send nor read", async () => {
      expect((await api("GET", `/${id}`, noPermToken)).status).toBe(403);
    });
  });
});
