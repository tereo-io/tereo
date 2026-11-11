// @module-tag unit
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestIdMixin } from "../../utils/logger.js";
import type { Server } from "node:http";
import express from "express";
import axios from "axios";
import {
  createRequestIdMiddleware,
  getRequestIpAddress,
} from "../../utils/requestId.js";

describe("clientIp and getRequestIpAddress", () => {
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

describe("createRequestIdMiddleware", () => {
  const servers: Server[] = [];

  const listen = async (trustProxy: unknown) => {
    const app = express();
    app.set("trust proxy", trustProxy);
    app.use(createRequestIdMiddleware());
    app.get("/", (req, res) => {
      res.json({ requestId: req.requestId });
    });
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  };

  afterAll(async () => {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve)))
    );
  });

  it.each([
    ["trust proxy is off", false],
    ["the peer is not one of the trusted proxies", "10.0.0.0/8"],
  ])("generates an id over the client's when %s", async (_, trustProxy) => {
    const res = await axios.get(await listen(trustProxy), {
      headers: { "X-Request-ID": "req-123" },
    });
    expect(res.data.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers["x-request-id"]).toBe(res.data.requestId);
  });

  it.each([
    ["an address list naming the peer", "127.0.0.1/32"],
    ["a hop count", 1],
  ])("keeps the id a trusted proxy sent: %s", async (_, trustProxy) => {
    const res = await axios.get(await listen(trustProxy), {
      headers: { "X-Request-ID": "req-123" },
    });
    expect(res.data.requestId).toBe("req-123");
    expect(res.headers["x-request-id"]).toBe("req-123");
  });
});
