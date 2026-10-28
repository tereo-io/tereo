// @module-tag unit
// @module-tag platform
import {
  exporterConfigured,
  initOtel,
  isHealthProbe,
} from "../../telemetry/index.js";
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

describe("isHealthProbe", () => {
  it.each(["/health", "/health/ready", "/HEALTH", "/health?probe=1"])(
    "is true for %s",
    (url) => {
      expect(isHealthProbe(url)).toBe(true);
    }
  );

  it.each(["/", "/healthz", "/v1/health", "/v1/files/health", undefined])(
    "is false for %s",
    (url) => {
      expect(isHealthProbe(url)).toBe(false);
    }
  );
});
