import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { redactClientSpan, redactHttpSpan, redisStatement } from "./redact.js";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { DiagLogLevel, DiagLogger, diag } from "@opentelemetry/api";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { existsSync, readFileSync } from "node:fs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import path from "node:path";
import os from "node:os";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAMESPACE,
} from "@opentelemetry/semantic-conventions/incubating";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  ParentBasedSampler,
  Sampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import {
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";

export interface InitOtelOptions {
  serviceName: string;
  serviceVersion?: string;
  serviceNamespace?: string;
}

let activeSdk: NodeSDK | null = null;

const DEFAULT_SERVICE_NAMESPACE = "tereo";

/** Walk up from `process.argv[1]` to the nearest `package.json` for its `version`. */
function readPackageVersionFromDisk(): string | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  let dir = path.dirname(entry);
  while (dir && dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          version?: unknown;
        };
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
          return pkg.version;
        }
      } catch {
        return undefined;
      }
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function resolveServiceVersion(opt?: string): string {
  return (
    opt ??
    process.env.OTEL_SERVICE_VERSION ??
    process.env.npm_package_version ??
    readPackageVersionFromDisk() ??
    "0.0.0"
  );
}

function resolveDeploymentEnv(): string {
  return process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? "development";
}

function resolveDiagLogLevel(): DiagLogLevel {
  switch ((process.env.OTEL_LOG_LEVEL ?? "warn").toLowerCase()) {
    case "none":
      return DiagLogLevel.NONE;
    case "error":
      return DiagLogLevel.ERROR;
    case "info":
      return DiagLogLevel.INFO;
    case "debug":
      return DiagLogLevel.DEBUG;
    case "verbose":
      return DiagLogLevel.VERBOSE;
    case "all":
      return DiagLogLevel.ALL;
    case "warn":
    default:
      return DiagLogLevel.WARN;
  }
}

/**
 * Emits one JSON object per line matching the fleet's Pino shape, so Loki parses
 * SDK diagnostics as structured logs — `DiagConsoleLogger`'s plain text would
 * land as unparseable noise.
 */
class JsonDiagLogger implements DiagLogger {
  private emit(level: string, message: string, args: unknown[]): void {
    const record: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      service:
        process.env.OTEL_SERVICE_NAME ??
        process.env.SERVICE_NAME ??
        "unknown-service",
      component: "otel-sdk",
      message,
    };
    if (args.length > 0) record.args = args;
    process.stdout.write(JSON.stringify(record) + "\n");
  }
  verbose(message: string, ...args: unknown[]): void {
    this.emit("trace", message, args);
  }
  debug(message: string, ...args: unknown[]): void {
    this.emit("debug", message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.emit("info", message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.emit("warn", message, args);
  }
  error(message: string, ...args: unknown[]): void {
    this.emit("error", message, args);
  }
}

/**
 * Returns `undefined` to defer to NodeSDK's env-based resolution when
 * `OTEL_TRACES_SAMPLER` is set; otherwise defaults to
 * `ParentBased(TraceIdRatioBased(1.0))`. NaN in `OTEL_TRACES_SAMPLER_ARG` is
 * forced to 1.0 — `TraceIdRatioBasedSampler` would silently make it a 0% (blackout)
 * sampler. Out-of-range values are clamped.
 */
function resolveSampler(): Sampler | undefined {
  if (process.env.OTEL_TRACES_SAMPLER) return undefined;
  const raw = parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG ?? "1");
  let ratio: number;
  if (!Number.isFinite(raw)) {
    diag.warn(
      `OTEL_TRACES_SAMPLER_ARG="${process.env.OTEL_TRACES_SAMPLER_ARG}" is not a number; falling back to 1.0`
    );
    ratio = 1;
  } else {
    ratio = Math.min(1, Math.max(0, raw));
    if (ratio !== raw) {
      diag.warn(
        `OTEL_TRACES_SAMPLER_ARG="${raw}" out of [0,1]; clamped to ${ratio}`
      );
    }
  }
  return new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(ratio),
  });
}

/** Defaults to gzip (honors the OTel-spec env vars when set). */
function resolveCompression(): CompressionAlgorithm {
  const v =
    process.env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION ??
    process.env.OTEL_EXPORTER_OTLP_COMPRESSION ??
    "gzip";
  return v === "none" ? CompressionAlgorithm.NONE : CompressionAlgorithm.GZIP;
}

const EXPORTER_ENDPOINT_VARS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
] as const;

/**
 * Whether an OTLP endpoint is configured. Without one the exporter would
 * fall back to http://localhost:4318 and log a failed export every batch.
 */
export const exporterConfigured = (
  env: NodeJS.ProcessEnv = process.env
): boolean => EXPORTER_ENDPOINT_VARS.some((name) => !!env[name]?.trim());

/**
 * Whether an incoming request is a health probe (`/health`, `/health/ready`).
 * Load balancers and the kubelet probe every few seconds per pod, and each
 * probe traced a request span plus its Prisma queries: on an idle install that
 * was most of the span volume, and none of it actionable. Express routes
 * case-insensitively, so this matches the same way.
 */
export const isHealthProbe = (url: string | undefined): boolean => {
  const path = (url ?? "").split(/[?#]/, 1)[0].toLowerCase();
  return path === "/health" || path.startsWith("/health/");
};

const tracesEndpointConfigured = (): boolean =>
  !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
  !!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();

/**
 * Boot the OTel Node SDK. MUST run as the first import in a service entry point
 * so auto-instrumentation can patch http/express/ioredis/prisma before they're
 * required. Returns null in NODE_ENV=test and when no OTLP endpoint is
 * configured: there is nowhere to send spans.
 */
export function initOtel(opts: InitOtelOptions): NodeSDK | null {
  if (process.env.NODE_ENV === "test") return null;
  // Kill switch lets a one-shot/DR process (e.g. backup restore Job) skip SDK
  // init + the flush-on-shutdown stall without unsetting NODE_OPTIONS.
  if (process.env.OTEL_SDK_DISABLED === "true") return null;
  if (!exporterConfigured()) return null;
  if (activeSdk) return activeSdk;

  diag.setLogger(new JsonDiagLogger(), resolveDiagLogLevel());

  const sampler = resolveSampler();
  // A metrics endpoint alone: no trace exporter, and none from the env
  // default either, which would also be OTLP to localhost.
  const exportTraces = tracesEndpointConfigured();
  if (!exportTraces) process.env.OTEL_TRACES_EXPORTER ??= "none";

  const explicitResource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: resolveServiceVersion(opts.serviceVersion),
    [ATTR_SERVICE_NAMESPACE]:
      opts.serviceNamespace ?? DEFAULT_SERVICE_NAMESPACE,
    [ATTR_SERVICE_INSTANCE_ID]: os.hostname(),
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: resolveDeploymentEnv(),
  });

  const sdk = new NodeSDK({
    resource: explicitResource,
    resourceDetectors: [envDetector, hostDetector, osDetector, processDetector],
    ...(sampler ? { sampler } : {}),
    // No `url` argument: the exporter then honors OTEL_EXPORTER_OTLP_ENDPOINT,
    // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS, and
    // OTEL_EXPORTER_OTLP_TIMEOUT per the OTel spec.
    ...(exportTraces
      ? {
          traceExporter: new OTLPTraceExporter({
            compression: resolveCompression(),
          }),
        }
      : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Prisma owns DB span semantics; pg-level spans would double-count.
        "@opentelemetry/instrumentation-pg": { enabled: false },
        // fs spans flood traces with low-value file reads.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // dns is similarly noisy and rarely actionable.
        "@opentelemetry/instrumentation-dns": { enabled: false },
        // Adds a 'finish' listener per Express layer (10+/request), tripping
        // Node's MaxListeners=10 warning on every response. Coverage overlaps
        // with instrumentation-express, so dropping it is cheap.
        "@opentelemetry/instrumentation-router": { enabled: false },
        // Credentials travel in URLs and Redis keys; see redact.ts. An ignored
        // request runs with tracing suppressed, so a probe's Prisma queries
        // start no traces of their own either.
        "@opentelemetry/instrumentation-http": {
          requestHook: redactHttpSpan,
          ignoreIncomingRequestHook: (request) => isHealthProbe(request.url),
        },
        // Outbound global fetch (webhook deliveries, OIDC discovery).
        "@opentelemetry/instrumentation-undici": {
          requestHook: redactClientSpan,
        },
        "@opentelemetry/instrumentation-ioredis": {
          dbStatementSerializer: redisStatement,
        },
      }),
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();
  activeSdk = sdk;
  return sdk;
}

/**
 * Flush and shut down the SDK. Idempotent + safe before init. Await this as the
 * last step of a stop sequence so in-flight spans flush before `process.exit`.
 */
export async function shutdownOtel(): Promise<void> {
  if (!activeSdk) return;
  const sdk = activeSdk;
  activeSdk = null;
  try {
    await sdk.shutdown();
  } catch {
    // Best-effort flush during termination — don't block shutdown.
  }
}
