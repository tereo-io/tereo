// @module-tag int
// @module-tag notifications
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { cleanNotifications } from "../../../../../../support/notifications.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import {
  createConnection,
  connectionsApi,
} from "../../../../../../support/notificationConnections.js";

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

describe("/v1/admin/notifications/connections/:id", () => {
  describe("authorization", () => {
    it("lets .read list and get, but not write (GET, PATCH, DELETE /connections/:id, POST /connections/:id/default and /test)", async () => {
      await cleanNotifications();
      const c = await create();
      expect(
        (await connectionsApi("GET", `/connections/${c.id}`, readToken)).status
      ).toBe(200);

      expect(
        (await connectionsApi("PATCH", `/connections/${c.id}`, readToken, {}))
          .status
      ).toBe(403);
      expect(
        (await connectionsApi("DELETE", `/connections/${c.id}`, readToken))
          .status
      ).toBe(403);
      expect(
        (
          await connectionsApi(
            "POST",
            `/connections/${c.id}/default`,
            readToken
          )
        ).status
      ).toBe(403);
      expect(
        (
          await connectionsApi("POST", `/connections/${c.id}/test`, readToken, {
            to: "a@b.com",
          })
        ).status
      ).toBe(403);
    });
  });
});
