// @module-tag int
// @module-tag notifications
import { openConnectionSecrets } from "../../../utils/notifications/connections.js";
import { createConnection } from "../../support/notificationConnections.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { cleanNotifications } from "../../support/notifications.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { currentKek } from "../../../utils/keys.js";
import { randomUUID } from "crypto";

let adminToken: string;

let adminUserId: string;

const create = (over: Record<string, unknown> = {}) =>
  createConnection(adminToken, over);

beforeAll(async () => {
  adminUserId = randomUUID();
  adminToken = await getTestPrincipalToken({
    userId: adminUserId,
    permissions: ["notifications.admin", "notifications.read"],
  });

  await cleanNotifications();
});

afterAll(async () => {
  await cleanNotifications();
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
