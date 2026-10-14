import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestIdMixin } from "../../utils/logger.js";
import type { Server } from "node:http";
import express from "express";
import axios from "axios";
import {
  createRequestIdMiddleware,
  getRequestIpAddress,
} from "../../utils/requestId.js";

describe("request context IP", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    // Core's default: only the loopback proxy is trusted.
    app.set("trust proxy", "loopback");
    app.use(createRequestIdMiddleware());
    app.get("/", (_req, res) => {
      res.json({ ip: getRequestIpAddress(), mixin: requestIdMixin() });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("takes the address the trusted proxy saw, not the client's own claim", async () => {
    const { data } = await axios.get(url, {
      headers: { "X-Forwarded-For": "203.0.113.9, 198.51.100.7" },
    });
    expect(data.ip).toBe("198.51.100.7");
  });

  it("uses the peer address when there is no proxy header", async () => {
    const { data } = await axios.get(url);
    expect(data.ip).toBe("127.0.0.1");
  });

  it("tags log lines with the request id", async () => {
    const { data } = await axios.get(url, {
      headers: { "X-Request-ID": "req-123" },
    });
    expect(data.mixin).toEqual({ request_id: "req-123" });
    expect(requestIdMixin()).toEqual({});
  });

  it.each([
    ["too long", "a".repeat(65)],
    ["with a space", "req 123"],
    ["with a slash", "req/123"],
  ])("replaces a client request id %s", async (_, id) => {
    const res = await axios.get(url, { headers: { "X-Request-ID": id } });
    expect(res.data.mixin.request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers["x-request-id"]).toBe(res.data.mixin.request_id);
  });

  it("keeps a well-formed client request id of up to 64 characters", async () => {
    const id = `trace:${"a".repeat(52)}.1_2-3`;
    expect(id).toHaveLength(64);
    const res = await axios.get(url, { headers: { "X-Request-ID": id } });
    expect(res.data.mixin.request_id).toBe(id);
  });
});
