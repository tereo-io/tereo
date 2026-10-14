import { createWebhookVerifier } from "../utils/webhookVerify.js";
import type { Request, Response, NextFunction } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

function createMockReq(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Request {
  return {
    body,
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    ),
  } as unknown as Request;
}

function createMockRes() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function signPayload(secret: string, body: Record<string, unknown>) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const input = `${timestamp}.${JSON.stringify(body)}`;
  const signature = `sha256=${createHmac("sha256", secret).update(input).digest("hex")}`;
  return {
    "X-Webhook-Signature": signature,
    "X-Webhook-Timestamp": timestamp,
  };
}

const TEST_SECRET = "test-secret-key";
const TEST_BODY = { eventType: "test.event", data: { id: 1 } };

describe("createWebhookVerifier", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it("should return 403 when secret is not configured", () => {
    const middleware = createWebhookVerifier(() => undefined);
    const req = createMockReq(TEST_BODY, signPayload(TEST_SECRET, TEST_BODY));
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: "Webhook signing secret not configured",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when signature header is missing", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const req = createMockReq(TEST_BODY, {
      "X-Webhook-Timestamp": Math.floor(Date.now() / 1000).toString(),
    });
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Missing webhook signature headers" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when timestamp header is missing", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const req = createMockReq(TEST_BODY, {
      "X-Webhook-Signature": "sha256=abc123",
    });
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Missing webhook signature headers" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when both headers are missing", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const req = createMockReq(TEST_BODY);
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Missing webhook signature headers" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when timestamp is not a number", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const req = createMockReq(TEST_BODY, {
      "X-Webhook-Signature": "sha256=abc",
      "X-Webhook-Timestamp": "not-a-number",
    });
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid webhook timestamp" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when timestamp is too old (>300s)", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString();
    const input = `${oldTimestamp}.${JSON.stringify(TEST_BODY)}`;
    const signature = `sha256=${createHmac("sha256", TEST_SECRET).update(input).digest("hex")}`;
    const req = createMockReq(TEST_BODY, {
      "X-Webhook-Signature": signature,
      "X-Webhook-Timestamp": oldTimestamp,
    });
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Webhook timestamp too old" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when timestamp is too far in the future", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const futureTimestamp = (Math.floor(Date.now() / 1000) + 400).toString();
    const input = `${futureTimestamp}.${JSON.stringify(TEST_BODY)}`;
    const signature = `sha256=${createHmac("sha256", TEST_SECRET).update(input).digest("hex")}`;
    const req = createMockReq(TEST_BODY, {
      "X-Webhook-Signature": signature,
      "X-Webhook-Timestamp": futureTimestamp,
    });
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Webhook timestamp too old" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when signature is wrong", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const req = createMockReq(TEST_BODY, {
      "X-Webhook-Signature":
        "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      "X-Webhook-Timestamp": timestamp,
    });
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid webhook signature" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 401 when signature has wrong length", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const req = createMockReq(TEST_BODY, {
      "X-Webhook-Signature": "sha256=short",
      "X-Webhook-Timestamp": timestamp,
    });
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid webhook signature" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should call next() with valid signature", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const headers = signPayload(TEST_SECRET, TEST_BODY);
    const req = createMockReq(TEST_BODY, headers);
    const res = createMockRes();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0); // status was never set
  });

  it("should reject when body changes after signing", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const headers = signPayload(TEST_SECRET, TEST_BODY);
    const tamperedBody = { ...TEST_BODY, data: { id: 999 } };
    const req = createMockReq(tamperedBody, headers);
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid webhook signature" });
    expect(next).not.toHaveBeenCalled();
  });

  describe("during a secret rotation (comma-separated signatures)", () => {
    const rotationHeaders = (secrets: string[]) => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const input = `${timestamp}.${JSON.stringify(TEST_BODY)}`;
      return {
        "X-Webhook-Signature": secrets
          .map(
            (s) =>
              `sha256=${createHmac("sha256", s).update(input).digest("hex")}`
          )
          .join(","),
        "X-Webhook-Timestamp": timestamp,
      };
    };

    it("accepts a receiver holding the new secret", () => {
      const middleware = createWebhookVerifier(() => TEST_SECRET);
      const req = createMockReq(
        TEST_BODY,
        rotationHeaders([TEST_SECRET, "old-secret"])
      );
      const res = createMockRes();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("accepts a receiver still holding the old secret", () => {
      const middleware = createWebhookVerifier(() => TEST_SECRET);
      const req = createMockReq(
        TEST_BODY,
        rotationHeaders(["new-secret", TEST_SECRET])
      );
      const res = createMockRes();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("rejects when no listed signature matches", () => {
      const middleware = createWebhookVerifier(() => TEST_SECRET);
      const req = createMockReq(
        TEST_BODY,
        rotationHeaders(["new-secret", "old-secret"])
      );
      const res = createMockRes();

      middleware(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Invalid webhook signature" });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("raw body", () => {
    // Core signs the body as sent. JSON.parse moves integer-like keys first
    // and rewrites "1.0" as 1, so re-serializing the parsed body differs.
    const raw = '{"data":{"b":1,"10":2,"n":1.0},"eventType":"test.event"}';
    const headersFor = (secret: string) => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${raw}`)
        .digest("hex");
      return {
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-Webhook-Timestamp": timestamp,
      };
    };

    it("verifies req.rawBody, which a parsed body would not match", () => {
      const middleware = createWebhookVerifier(() => TEST_SECRET);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(JSON.stringify(parsed)).not.toBe(raw);

      const withoutRaw = createMockReq(parsed, headersFor(TEST_SECRET));
      middleware(withoutRaw, createMockRes(), next);
      expect(next).not.toHaveBeenCalled();

      const req = createMockReq(parsed, headersFor(TEST_SECRET));
      (req as Request & { rawBody: Buffer }).rawBody = Buffer.from(raw);
      middleware(req, createMockRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("verifies a Buffer body from express.raw()", () => {
      const middleware = createWebhookVerifier(() => TEST_SECRET);
      const req = createMockReq({}, headersFor(TEST_SECRET));
      req.body = Buffer.from(raw);
      middleware(req, createMockRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("rejects a tampered raw body", () => {
      const middleware = createWebhookVerifier(() => TEST_SECRET);
      const req = createMockReq({}, headersFor(TEST_SECRET));
      req.body = Buffer.from(raw.replace('"b":1', '"b":2'));
      const res = createMockRes();
      middleware(req, res, next);
      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  it("should return 401 when the timestamp has trailing characters", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const headers = signPayload(TEST_SECRET, TEST_BODY);
    const req = createMockReq(TEST_BODY, {
      ...headers,
      "X-Webhook-Timestamp": `${headers["X-Webhook-Timestamp"]}abc`,
    });
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid webhook timestamp" });
    expect(next).not.toHaveBeenCalled();
  });

  it("should reject when signed with a different secret", () => {
    const middleware = createWebhookVerifier(() => TEST_SECRET);
    const headers = signPayload("wrong-secret", TEST_BODY);
    const req = createMockReq(TEST_BODY, headers);
    const res = createMockRes();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid webhook signature" });
    expect(next).not.toHaveBeenCalled();
  });
});
