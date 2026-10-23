// @module-tag int
// @module-tag notifications
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import { describe, it, expect, beforeAll } from "vitest";

const BASE = `${CORE_URL}/v1/admin/notifications`;

let readToken: string;

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${BASE}${path}`, token, body);

beforeAll(async () => {
  readToken = await getTestPrincipalToken({
    permissions: ["notifications.read"],
  });
});

describe("GET /v1/admin/notifications/channels", () => {
  describe("channels", () => {
    it("lists email with JSON schemas of its settings and secrets", async () => {
      const res = await api("GET", "/channels", readToken);
      expect(res.status).toBe(200);
      const email = res.body.data.find(
        (c: { channel: string }) => c.channel === "email"
      );
      expect(email.settingsSchema.type).toBe("object");
      expect(email.settingsSchema.properties).toHaveProperty("host");
      expect(email.secretsSchema.properties).toHaveProperty("password");
    });
  });
});
