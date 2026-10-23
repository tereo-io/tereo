// @module-tag int
// @module-tag notifications
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { cleanNotifications } from "../../../../../support/notifications.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import {
  connectionsApi,
  connectionPayload,
  createConnection,
} from "../../../../../support/notificationConnections.js";

let adminToken: string;
let readToken: string;
let sendOnlyToken: string;
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
  sendOnlyToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });
  await cleanNotifications();
});

afterAll(async () => {
  await cleanNotifications();
});

describe("/v1/admin/notifications/connections", () => {
  describe("authorization", () => {
    it("refuses a caller with neither read nor admin", async () => {
      expect(
        (await connectionsApi("GET", "/connections", sendOnlyToken)).status
      ).toBe(403);
    });

    it("lets .read list and get, but not write", async () => {
      await cleanNotifications();
      const c = await create();
      const list = await connectionsApi("GET", "/connections", readToken);
      expect(list.status).toBe(200);
      expect(list.body.data.map((x: { id: string }) => x.id)).toContain(c.id);
      expect(
        (await connectionsApi("GET", `/connections/${c.id}`, readToken)).status
      ).toBe(200);

      expect(
        (
          await connectionsApi(
            "POST",
            "/connections",
            readToken,
            connectionPayload()
          )
        ).status
      ).toBe(403);
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
