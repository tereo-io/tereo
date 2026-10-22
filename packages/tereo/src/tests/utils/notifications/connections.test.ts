// @module-tag int
// @module-tag notifications
import { openConnectionSecrets } from "../../../utils/notifications/connections.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { currentKek } from "../../../utils/keys.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { fetchJson } from "../../support/http.js";
import { randomBytes, randomUUID } from "crypto";

const BASE = `${CORE_URL}/v1/admin/notifications`;

let adminToken: string;

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

  await clean();
});

afterAll(async () => {
  await clean();
});

describe("openConnectionSecrets", () => {
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
