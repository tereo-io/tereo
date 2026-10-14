import { getRedisClient } from "../../utils/redis.js";
import { errorHandler } from "../../utils/errors.js";
import type { Server } from "node:http";
import express from "express";
import axios from "axios";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Limiters with Redis unavailable: credential limiters refuse with 503 (but
 * the client-secret limiter lets a verified secret decide), the general
 * limiters let requests through. Runs its own app against this
 * worker's Redis client, which is made not ready or made to throw.
 */

let server: Server;
let url: string;

beforeAll(async () => {
  // Imported here: the limiters take the Redis client when created, and the
  // setup file connects it in its own beforeAll.
  const limits = await import("../../middleware/rateLimit.js");
  const { recordUnlockAttempt } =
    await import("../../utils/shareUnlockLimiter.js");
  const { verifyClientSecretLimited } = await import("../../utils/auth.js");
  const { hashFlowToken } = await import("../../utils/crypto.js");
  const client = {
    clientId: "limiter-test-client",
    clientSecret: hashFlowToken("right-secret"),
    previousSecretHash: null,
    previousSecretExpiresAt: null,
  } as unknown as Parameters<typeof verifyClientSecretLimited>[1];

  const app = express();
  app.set("trust proxy", "loopback");
  app.post("/failure", async (req, res) => {
    await limits.setupFailure.check(req);
    res.json({ ok: true });
  });
  app.post("/backoff", async (req, res) => {
    const email = "someone@test.local";
    await limits.loginAccountBackoff.check(req, email);
    res.json({ ok: true });
  });
  app.post("/unlock", async (_req, res) => {
    await recordUnlockAttempt("some-share-token", "192.0.2.1");
    res.json({ ok: true });
  });
  app.post("/client-secret/:secret", async (req, res) => {
    const valid = await verifyClientSecretLimited(
      req,
      client,
      req.params.secret
    );
    res.status(valid ? 200 : 401).json({ valid });
  });
  app.get("/general", limits.rateLimitGeneral, (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/preauth", limits.rateLimitPreAuth, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const call = (method: "get" | "post", path: string) =>
  axios.request({ method, url: `${url}${path}`, validateStatus: () => true });

const expectUnavailable = async (path: string) => {
  const res = await call("post", path);
  expect(res.status).toBe(503);
  expect(res.data.error).toBe("temporarily_unavailable");
  expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
};

describe("limiters while the Redis client is not ready", () => {
  let status: string;

  beforeAll(() => {
    const redis = getRedisClient() as unknown as { status: string };
    status = redis.status;
  });

  afterEach(() => {
    (getRedisClient() as unknown as { status: string }).status = status;
  });

  const goDown = () => {
    (getRedisClient() as unknown as { status: string }).status = "reconnecting";
  };

  it("refuses credential attempts with 503", async () => {
    goDown();
    await expectUnavailable("/failure");
    await expectUnavailable("/backoff");
    await expectUnavailable("/unlock");
  });

  it("still verifies client secrets", async () => {
    goDown();
    expect((await call("post", "/client-secret/right-secret")).status).toBe(
      200
    );
    expect((await call("post", "/client-secret/wrong")).status).toBe(401);
  });

  it("lets ordinary requests through", async () => {
    goDown();
    expect((await call("get", "/general")).status).toBe(200);
    expect((await call("get", "/preauth")).status).toBe(200);
  });
});

describe("limiters when Redis commands fail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses credential attempts with 503", async () => {
    const redis = getRedisClient();
    const boom = new Error("connection reset");
    vi.spyOn(
      redis as unknown as { rlflxIncr: () => Promise<unknown> },
      "rlflxIncr"
    ).mockRejectedValue(boom);
    vi.spyOn(redis, "eval").mockRejectedValue(boom);
    vi.spyOn(redis, "multi").mockImplementation(() => {
      throw boom;
    });
    vi.spyOn(redis, "get").mockRejectedValue(boom);

    await expectUnavailable("/failure");
    await expectUnavailable("/backoff");
    await expectUnavailable("/unlock");
    expect((await call("get", "/general")).status).toBe(200);
    expect((await call("post", "/client-secret/right-secret")).status).toBe(
      200
    );
    expect((await call("post", "/client-secret/wrong")).status).toBe(401);
  });

  it("serves normally once Redis answers again", async () => {
    expect((await call("post", "/failure")).status).toBe(200);
    expect((await call("post", "/backoff")).status).toBe(200);
    expect((await call("post", "/unlock")).status).toBe(200);
  });
});
