// @module-tag int
// @module-tag notifications
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomBytes, randomUUID } from "crypto";

const BASE = `${CORE_URL}/v1/admin/notifications`;

let adminToken: string;
let readToken: string;
let sendOnlyToken: string;
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
  sendOnlyToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });
  await clean();
});

afterAll(async () => {
  await clean();
});

describe("/v1/admin/notifications/connections", () => {
  describe("authorization", () => {
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
});
