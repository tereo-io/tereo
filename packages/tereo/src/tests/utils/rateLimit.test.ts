// @module-tag int
// @module-tag platform
// @module-tag security
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import type { Server } from "node:http";
import express from "express";
import axios from "axios";

beforeAll(async () => {
  // Imported here: the limiter takes the Redis client when created, and the
  // setup file connects it in its own beforeAll.
  const { createRateLimitMiddleware } =
    await import("../../utils/rateLimit.js");
  const app = express();
  // A cost no budget covers, so the first request is refused.
  const limiter = createRateLimitMiddleware("rate-limit-log-test", {
    getCost: () => 1e9,
  });
  app.use("/v1/files/shared", limiter, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let server: Server;

let url: string;

describe("createRateLimitMiddleware", () => {
  it("leaves a share link's token out of the logged path", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const res = await axios.get(`${url}/v1/files/shared/s3cr3t-token?x=1`, {
        validateStatus: () => true,
      });
      expect(res.status).toBe(429);
      const logged = warn.mock.calls.find(
        ([, message]) => message === "Rate limit exceeded"
      );
      expect(logged?.[0]).toMatchObject({ path: "/v1/files/shared/:token" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("s3cr3t");
    } finally {
      warn.mockRestore();
    }
  });
});
