import { CORE_URL } from "./coreUrl.js";
import { fetchJson } from "./http.js";
import { randomBytes } from "crypto";
import { expect } from "vitest";

const BASE = `${CORE_URL}/v1/admin/notifications`;

const rand = () => randomBytes(4).toString("hex");

export const connectionsApi = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${BASE}${path}`, token, body);

export const connectionSettings = (
  port = 2525,
  over: Record<string, unknown> = {}
) => ({
  host: "127.0.0.1",
  port,
  security: "none",
  defaultFrom: { address: "billing@acme.com" },
  allowedSenders: ["@acme.com"],
  ...over,
});

export const connectionPayload = (over: Record<string, unknown> = {}) => ({
  channel: "email",
  slug: `c-${rand()}`,
  displayName: "Main",
  settings: connectionSettings(),
  ...over,
});

/** Creates a connection through the admin API; `adminToken` holds `notifications.admin`. */
export const createConnection = async (
  adminToken: string,
  over: Record<string, unknown> = {}
) => {
  const res = await connectionsApi(
    "POST",
    "/connections",
    adminToken,
    connectionPayload(over)
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};
