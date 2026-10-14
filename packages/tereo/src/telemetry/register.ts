import { initOtel, shutdownOtel } from "./index.js";

// NodeSDK auto-creates an OTLPLogExporter when OTEL_EXPORTER_OTLP_ENDPOINT
// is set and no explicit loggerProvider / OTEL_LOGS_EXPORTER are configured.
// We only ship traces over OTLP — logs go to stdout → Loki via Promtail in
// prod — so opt out of the auto-created log exporter unless the operator
// explicitly enables it. Without this, every service POSTs to /v1/logs on
// the collector, which has no logs pipeline and returns 404.
process.env.OTEL_LOGS_EXPORTER ??= "none";

// Same opt-out for metrics: NodeSDK auto-creates a PeriodicExportingMetricReader
// when OTEL_EXPORTER_OTLP_ENDPOINT is set, POSTing /v1/metrics to a backend
// (Tempo) that only ingests traces — every export logs a 404. Metrics ride the
// existing Prometheus scrape path where present.
process.env.OTEL_METRICS_EXPORTER ??= "none";

/**
 * Side-effect entry for Node's `--import` flag (or the `NODE_OPTIONS` env var).
 *
 * Booting OTel before any user module loads guarantees auto-instrumentation
 * patches `http`, `express`, `ioredis`, `@prisma/client`, and `pino` before
 * those modules are required. Run as:
 *
 *     node --import ./dist/telemetry/register.js dist/index.js
 *
 * (`npm start` and the Dockerfile set this through NODE_OPTIONS; `npm run
 * dev` passes the .ts source to tsx.)
 *
 * Without an OTLP endpoint (`exporterConfigured`) nothing starts, and the
 * OTel API stays a no-op: spans are not recorded and logs carry no
 * `trace_id`; the `request_id` on each line still ties a request together.
 *
 * Service identity is `OTEL_SERVICE_NAME` when set, otherwise
 * `tereo` — the same name the logger uses. This runs before
 * `preload.ts`, so it cannot read anything that module sets.
 */
initOtel({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "tereo",
});

/**
 * Long-running services flush via `await shutdownOtel()` in their stop
 * sequence. Short-lived scripts (Prisma migrate, seed scripts) exit when
 * the event loop drains and rely on this `beforeExit` hook to flush their
 * spans. The hook is a no-op when `shutdownOtel` was already called.
 */
let exiting = false;
process.on("beforeExit", () => {
  if (exiting) return;
  exiting = true;
  // beforeExit allows async work to keep the loop alive — return the promise.
  void shutdownOtel();
});
