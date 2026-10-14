# Telemetry — `src/telemetry/`

OpenTelemetry SDK init for tereo. Boots `NodeSDK` with auto-instrumentations + Prisma
instrumentation + OTLP HTTP trace exporter — only when an OTLP endpoint is configured (see
[When the SDK starts](#when-the-sdk-starts)).

## Public API

```ts
initOtel({ serviceName, serviceVersion?, serviceNamespace? }): NodeSDK | null
shutdownOtel(): Promise<void>
```

- `initOtel` — boots the SDK once. Returns `null` in `NODE_ENV=test`, with `OTEL_SDK_DISABLED=true`, or when no OTLP endpoint is configured (no exporters constructed). Idempotent.
- `exporterConfigured(env?)` — whether any of the endpoint variables below is set.
- `shutdownOtel` — flushes and tears down. Safe before init or in tests (no-op). `src/index.ts` awaits this as the final step of its stop sequence so spans flush before `process.exit`.

## Boot Mechanism: Node `--import` Hook

The entry file does **not** import this as a side effect. Instead, the SDK boots via Node's `--import` hook, set per launch context:

| Context | How `register` is loaded |
|---|---|
| `npm start` | `NODE_OPTIONS='--import ./dist/telemetry/register.js'` |
| `npm run dev` | `tsx watch --import ./src/telemetry/register.ts` |
| Docker | `ENV NODE_OPTIONS="--import ./dist/telemetry/register.js"` in `docker/Dockerfile` |

The hook loads `register` before the entry module's first line runs, which is the only window in which auto-instrumentation can patch `http`, `express`, `ioredis`, `@prisma/client`, and `pino`.

**Why not in `.env`?** `.env` is loaded inside the app via `import "dotenv/config"` — *after* Node has already started, which is too late for `--import` to fire. NODE_OPTIONS must be in the process env at Node startup, not loaded by the app at runtime.

Service identity: `OTEL_SERVICE_NAME` if set, otherwise `tereo`.

## When the SDK starts

`initOtel` starts the SDK only when at least one of these is set and non-empty:

- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`

Without one, the exporter would fall back to `http://localhost:4318` and log a failed export for
every batch, so nothing starts: no instrumentation is patched in, and the `@opentelemetry/api` calls in
the app (`utils/otel.ts`, `utils/bullmq.ts`, `utils/outbox.ts`) are the API's no-ops. Logs carry no
`trace_id` / `span_id` then, since there is no span; each line logged during a request still carries
its `request_id`, which ties a request's lines together.

The `request_id` is the client's `X-Request-ID` when it matches `^[A-Za-z0-9._:-]{1,64}$`, and a
generated one otherwise (`utils/requestId.ts`); either way it is echoed in the response's
`X-Request-ID`. The id is also stored — in access logs and as audit entries' correlation id — so a
longer or odder value is never trusted.

With only the metrics endpoint set, the SDK starts without a trace exporter (`OTEL_TRACES_EXPORTER`
defaults to `none` in that case); metrics also need `OTEL_METRICS_EXPORTER=otlp`, as below.

## Files

| File | Use |
|---|---|
| `telemetry/index.ts` | API surface — `src/index.ts` imports `shutdownOtel` from here |
| `telemetry/register.ts` | Side-effect entry — loaded via `--import` |
| `telemetry/redact.ts` | Strips credentials from HTTP URL and Redis statement attributes. Outbound `fetch` spans (instrumentation-undici: webhook deliveries, OIDC) keep only the URL's origin, since a webhook URL often carries its secret in the path; `url.path` and a non-empty `url.query` read `[redacted]`. `redactUrl` (query dropped, `/shared/<token>` → `/shared/:token`) also shapes the paths the error handler, the rate limiters and the files access log write |

## Instrumentations

`getNodeAutoInstrumentations()` is enabled with four exclusions:

- `@opentelemetry/instrumentation-pg` — **disabled**. Prisma owns DB span semantics; pg-level spans would double-count.
- `@opentelemetry/instrumentation-fs` — **disabled**. Floods traces with low-value file reads.
- `@opentelemetry/instrumentation-dns` — **disabled**. Same noise issue.
- `@opentelemetry/instrumentation-router` — **disabled**. It adds a `finish` listener per Express layer, tripping Node's MaxListeners warning on every response; `instrumentation-express` covers the same ground.

`PrismaInstrumentation` is registered explicitly. Pino auto-instrumentation injects `trace_id` / `span_id` / `trace_flags` into every log record during a traced request.

## Resource Attributes

Set on every span:

- `service.name` — from `opts.serviceName` (resolved from env in `register.ts`)
- `service.namespace` — `opts.serviceNamespace ?? "tereo"`
- `service.version` — first non-empty of `opts.serviceVersion`, `OTEL_SERVICE_VERSION`, `npm_package_version`, walk-up `package.json` lookup, `"0.0.0"`
- `service.instance.id` — `os.hostname()` (in k8s this is the pod name)
- `deployment.environment.name` — `DEPLOY_ENV` env → `NODE_ENV` fallback → `"development"`

Plus the standard OTel detectors: `envDetector`, `hostDetector`, `osDetector`, `processDetector` — adds `host.*`, `os.*`, `process.*` attributes and merges in `OTEL_RESOURCE_ATTRIBUTES`.

## Sampling

When `OTEL_TRACES_SAMPLER` is set, the SDK honors the standard OTel sampler names. When neither it nor `OTEL_TRACES_SAMPLER_ARG` is set, falls back to `ParentBased(TraceIdRatioBased(1.0))`. Default `1.0` is correct for pre-prod; tail-based sampling for production lives at the Collector, not in this package.

## OTLP Exporter

Constructed with `compression: gzip` (override via `OTEL_EXPORTER_OTLP_COMPRESSION` / `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION`). Reads endpoint, headers, and timeout from the standard OTel env vars directly — nothing here overrides them.

There is no default endpoint: unset, the SDK does not start.

## Diagnostics

`OTEL_LOG_LEVEL` (default `warn`) controls the SDK's internal `diag` logger. Levels: `none`, `error`, `warn`, `info`, `debug`, `verbose`, `all`.

## Test Mode

`NODE_ENV=test` → `initOtel` returns `null` immediately. The `--import` hook still loads `register.ts`, but `initOtel` short-circuits before constructing exporters or registering instrumentations. `shutdownOtel()` is also a no-op when uninitialized. Tests never leak telemetry.

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_OPTIONS` | Yes (set in `package.json` scripts + Dockerfile ENV) | — | Must include `--import ./dist/telemetry/register.js` to boot the SDK |
| `OTEL_SERVICE_NAME` | No | `tereo` | Resource `service.name` |
| `OTEL_SERVICE_VERSION` | No | `package.json` walk-up | Resource `service.version` |
| `DEPLOY_ENV` | No | falls back to `NODE_ENV` | Resource `deployment.environment.name` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | To export | — | Base URL of OTLP HTTP receiver (read by exporter). Unset with the two below, the SDK does not start |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | No | — | Full traces URL (overrides base; read by exporter) |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | No | — | Full metrics URL; needs `OTEL_METRICS_EXPORTER=otlp` |
| `OTEL_SDK_DISABLED` | No | — | `true` skips the SDK even with an endpoint |
| `OTEL_LOGS_EXPORTER` / `OTEL_METRICS_EXPORTER` | No | `none` (set by `register.ts`) | Traces only, unless set |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | No | — | Auth tokens (read by exporter) |
| `OTEL_EXPORTER_OTLP_COMPRESSION` / `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION` | No | `gzip` | OTLP compression — `gzip` or `none` |
| `OTEL_TRACES_SAMPLER` | No | (uses ParentBased+TraceIdRatio) | Standard OTel sampler name |
| `OTEL_TRACES_SAMPLER_ARG` | No | `1.0` | Sampling ratio 0.0–1.0 |
| `OTEL_LOG_LEVEL` | No | `warn` | SDK internal diag verbosity |
| `OTEL_RESOURCE_ATTRIBUTES` | No | — | Extra resource attributes (env detector merges in) |
| `NODE_ENV` | No | `development` | `test` short-circuits init |

## Commands

```bash
npm run build    # Compile TypeScript
npm run check    # Type check
npm run clean    # Remove dist/
```
