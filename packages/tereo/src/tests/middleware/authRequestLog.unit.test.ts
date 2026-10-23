// @module-tag unit
// @module-tag auth
import { authRequestLog } from "../../middleware/authRequestLog.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";
import express, { Router } from "express";
import type { AddressInfo } from "net";

// Mounted like core's: the logger at the app, the routes in nested routers
// that strip their prefix from `req.path` before the response finishes.
const serve = async () => {
  const app = express();
  app.use(authRequestLog);
  const admin = Router();
  admin.get("/users", (_req, res) => {
    res.json({});
  });
  const v1 = Router();
  v1.use("/admin", admin);
  app.use("/v1", v1);
  const oauth = Router();
  oauth.post("/token", (_req, res) => {
    res.json({});
  });
  app.use("/oauth", oauth);
  app.get("/elsewhere", (_req, res) => {
    res.json({});
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const loggedPaths = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .filter(([, msg]) => msg === "http_request")
    .map(([meta]) => (meta as { path: string }).path);

describe("authRequestLog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs /v1/admin and /oauth requests by their full path, and nothing else", async () => {
    const info = vi.spyOn(logger, "info");
    const debug = vi.spyOn(logger, "debug");
    const { url, close } = await serve();
    try {
      await fetch(`${url}/v1/admin/users?x=1`);
      await fetch(`${url}/oauth/token`, { method: "POST" });
      await fetch(`${url}/elsewhere`);
      // `finish` fires after the response is handed off.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await close();
    }
    expect([...loggedPaths(info), ...loggedPaths(debug)].sort()).toEqual([
      "/oauth/token",
      "/v1/admin/users",
    ]);
  });

  it("logs a request whose path differs only in case", async () => {
    const info = vi.spyOn(logger, "info");
    const debug = vi.spyOn(logger, "debug");
    const { url, close } = await serve();
    try {
      await fetch(`${url}/OAuth/token`, { method: "POST" });
      await fetch(`${url}/V1/Admin/users`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await close();
    }
    expect([...loggedPaths(info), ...loggedPaths(debug)].sort()).toEqual([
      "/OAuth/token",
      "/V1/Admin/users",
    ]);
  });
});
