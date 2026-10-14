import { getLockKey } from "../../routes/oauth/token/controllers.js";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { ClientRecord } from "../../utils/db/clients.js";
import { keyOf } from "../../utils/shareUnlockLimiter.js";
import { describe, it, expect } from "vitest";
import {
  redactClientSpan,
  redactHttpSpan,
  redactUrl,
  redisStatement,
} from "../../telemetry/redact.js";

/**
 * Credentials (codes, refresh tokens, share tokens, signatures) must not
 * appear in Redis keys or in exported spans.
 */

const client = { clientId: "some-client" } as ClientRecord;
const SECRET = "c0ffee-credential-value-1234567890";

describe("credentials kept out of Redis keys", () => {
  it("the token endpoint's lock key holds a hash of the code or refresh token", () => {
    for (const body of [
      {
        grant_type: "authorization_code",
        code: SECRET,
        redirect_uri: "x",
        client_id: "some-client",
      },
      {
        grant_type: "refresh_token",
        refresh_token: SECRET,
        client_id: "some-client",
      },
    ] as Parameters<typeof getLockKey>[1][]) {
      const key = getLockKey(client, body);
      expect(key).not.toContain(SECRET);
      expect(key).toMatch(/:[0-9a-f]{64}$/);
    }
    const fromCookie = getLockKey(
      client,
      { grant_type: "refresh_token", client_id: "some-client" } as Parameters<
        typeof getLockKey
      >[1],
      SECRET
    );
    expect(fromCookie).not.toContain(SECRET);
  });

  it("the share unlock limiter's key holds a hash of the share token", () => {
    expect(keyOf(SECRET, "10.0.0.1")).not.toContain(SECRET);
  });
});

describe("credentials kept out of spans", () => {
  it("strips query strings and share tokens from URLs", () => {
    expect(redactUrl(`/files/signed/objects/a/b?sig=${SECRET}&exp=1`)).toBe(
      "/files/signed/objects/a/b"
    );
    expect(redactUrl(`/files/shared/${SECRET}/report.pdf`)).toBe(
      "/files/shared/:token/report.pdf"
    );
    expect(redactUrl(`https://core.example/login/2fa?session=${SECRET}`)).toBe(
      "https://core.example/login/2fa"
    );
  });

  it("rewrites an HTTP span's URL attributes", () => {
    const span = new BasicTracerProvider().getTracer("test").startSpan("GET", {
      attributes: {
        "http.url": `http://core/files/shared/${SECRET}?x=1`,
        "http.target": `/files/shared/${SECRET}?x=1`,
        "url.full": `http://core/files/shared/${SECRET}?x=1`,
        "url.path": `/files/shared/${SECRET}`,
        "url.query": `sig=${SECRET}`,
      },
    });
    redactHttpSpan(span);
    span.end();
    const attributes = (span as unknown as { attributes: object }).attributes;
    expect(JSON.stringify(attributes)).not.toContain(SECRET);
  });

  it("keeps only the origin of an outbound fetch span's URL", () => {
    const span = new BasicTracerProvider().getTracer("test").startSpan("POST", {
      attributes: {
        "url.full": `https://user:${SECRET}@hooks.example/services/${SECRET}?token=${SECRET}`,
        "url.path": `/services/${SECRET}`,
        "url.query": `?token=${SECRET}`,
        "server.address": "hooks.example",
      },
    });
    redactClientSpan(span);
    span.end();
    const attributes = (span as unknown as { attributes: object }).attributes;
    expect(JSON.stringify(attributes)).not.toContain(SECRET);
    expect(attributes).toMatchObject({
      "url.full": "https://hooks.example",
      "server.address": "hooks.example",
    });
  });

  it("records only the Redis command name", () => {
    expect(redisStatement("set")).toBe("set");
  });
});
