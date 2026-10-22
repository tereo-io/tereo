// @module-tag unit
// @module-tag platform
import { exporterConfigured, initOtel } from "../../telemetry/index.js";
import { afterEach, describe, expect, it } from "vitest";

describe("exporterConfigured", () => {
  it("is false with no endpoint", () => {
    expect(exporterConfigured({})).toBe(false);
    expect(exporterConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: " " })).toBe(
      false
    );
  });

  it.each([
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  ])("is true with %s", (name) => {
    expect(exporterConfigured({ [name]: "http://collector:4318" })).toBe(true);
  });
});

describe("initOtel", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("starts nothing outside tests when no endpoint is configured", () => {
    process.env.NODE_ENV = "production";
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    expect(initOtel({ serviceName: "tereo" })).toBeNull();
  });
});
