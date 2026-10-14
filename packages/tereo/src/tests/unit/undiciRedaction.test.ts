import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactClientSpan } from "../../telemetry/redact.js";
import { createServer, type Server } from "node:http";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";

const SECRET = "c0ffee-webhook-secret-1234567890";

describe("outbound fetch spans", () => {
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
