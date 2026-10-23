// @module-tag unit
// @module-tag platform
// @module-tag security
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "node:http";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  redactClientSpan,
  redactHttpSpan,
  redactUrl,
  redisStatement,
} from "../../telemetry/redact.js";

const SECRET = "c0ffee-credential-value-1234567890";

describe("redactUrl, redactHttpSpan and redactClientSpan", () => {
  describe("credentials kept out of spans", () => {
    it("strips query strings and share tokens from URLs", () => {
      expect(redactUrl(`/files/signed/objects/a/b?sig=${SECRET}&exp=1`)).toBe(
        "/files/signed/objects/a/b"
      );
      expect(redactUrl(`/files/shared/${SECRET}/report.pdf`)).toBe(
        "/files/shared/:token/report.pdf"
      );
      // Express routes case-insensitively.
      expect(redactUrl(`/v1/files/SHARED/${SECRET}`)).toBe(
        "/v1/files/SHARED/:token"
      );
      expect(redactUrl(`/v1/Files/Shared/${SECRET}/a.pdf`)).toBe(
        "/v1/Files/Shared/:token/a.pdf"
      );
      expect(
        redactUrl(`https://core.example/login/2fa?session=${SECRET}`)
      ).toBe("https://core.example/login/2fa");
    });

    it("rewrites an HTTP span's URL attributes", () => {
      const span = new BasicTracerProvider()
        .getTracer("test")
        .startSpan("GET", {
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
      const span = new BasicTracerProvider()
        .getTracer("test")
        .startSpan("POST", {
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

  describe("outbound fetch spans", () => {
    const SECRET = "c0ffee-webhook-secret-1234567890";

    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const instrumentation = new UndiciInstrumentation({
      requestHook: redactClientSpan,
    });
    let server: Server;
    let port: number;

    beforeAll(async () => {
      instrumentation.setTracerProvider(provider);
      instrumentation.enable();
      server = createServer((_req, res) => res.end("ok"));
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      port = (server.address() as { port: number }).port;
    });

    afterAll(async () => {
      instrumentation.disable();
      await new Promise((resolve) => server.close(resolve));
      await provider.shutdown();
    });

    it("exports the origin only", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/services/${SECRET}?token=${SECRET}`
      );
      await res.text();
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        expect(JSON.stringify(span.attributes)).not.toContain(SECRET);
      }
      expect(spans[0].attributes["url.full"]).toBe(`http://127.0.0.1:${port}`);
    });
  });
});
