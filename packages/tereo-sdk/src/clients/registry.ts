import type { Declaration, RegistrationResult } from "../types/registry.js";
import { logger } from "../utils/logger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getOriginalResponseData,
  getOriginalStatus,
  requests,
} from "../handler.js";

/**
 * Whether core refused for a reason that time can fix. Core being down or
 * busy, credentials not yet usable, and a requested role that another service
 * has not registered yet all resolve on their own. A declaration that breaks
 * a rule, or names another service already owns, never will.
 */
const isRetryable = (err: unknown): boolean => {
  const status = getOriginalStatus(err);
  if (status === undefined) return true; // no response: core unreachable
  if (status >= 500 || status === 429 || status === 401) return true;
  if (status === 422) {
    const data = getOriginalResponseData(err) as { error?: string } | undefined;
    return data?.error === "invalid_requested_access";
  }
  return false;
};

/**
 * The app's version: `npm_package_version` when npm started it, else the
 * version in `package.json` in the working directory. Null when neither has
 * one.
 */
export const appVersion = (): string | null => {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
};

export interface RegistryClientOptions {
  /** First retry delay; doubles each attempt, with jitter. Default 1 s. */
  baseDelayMs?: number;
  /** Cap on the delay between attempts. Default 60 s. */
  maxDelayMs?: number;
}

/**
 * Registers the service's declaration with core, retrying until core accepts
 * it, and reports readiness: a service should answer not-ready until
 * `isRegistered()`, so it takes no traffic before its permissions, buckets
 * and event types exist.
 */
export class RegistryClient {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private abort = new AbortController();
  private result: RegistrationResult | null = null;
  private settled: Promise<RegistrationResult> | null = null;

  constructor(options: RegistryClientOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
  }

  /**
   * Register `declaration`; resolves with core's answer once accepted.
   * Retries while the failure is one time can fix; rejects at once on one it
   * cannot (the error says why), or when `close()` or another `register()`
   * is called first.
   */
  register(declaration: Declaration): Promise<RegistrationResult> {
    this.abort.abort();
    this.abort = new AbortController();
    this.result = null;
    const version = declaration.version ?? appVersion();
    this.settled = version
      ? this.attempt({ ...declaration, version }, this.abort.signal)
      : Promise.reject(
          new Error(
            "@tereo-io/sdk: the declaration needs a version; none was given, npm_package_version is unset, and ./package.json has none"
          )
        );
    // Callers that only poll isRegistered() should not see an unhandled rejection.
    this.settled.catch(() => {});
    return this.settled;
  }

  /** True once core has accepted the declaration. */
  isRegistered(): boolean {
    return this.result !== null;
  }

  /** True between `register()` and core accepting it. */
  isPending(): boolean {
    return this.settled !== null && this.result === null;
  }

  /** The last accepted registration: what changed and the access statuses. */
  getRegistration(): RegistrationResult | null {
    return this.result;
  }

  /** Resolves when registered; rejects if registration fails or was never started. */
  whenRegistered(): Promise<RegistrationResult> {
    return (
      this.settled ??
      Promise.reject(new Error("register() has not been called"))
    );
  }

  /** Stop retrying. */
  close(): void {
    this.abort.abort();
  }

  private async attempt(
    declaration: Declaration,
    signal: AbortSignal
  ): Promise<RegistrationResult> {
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new Error("Registration aborted");
      try {
        const result = await requests.registry.declare(declaration);
        // A later register() superseded this one while core answered.
        if (signal !== this.abort.signal) {
          throw new Error("Registration aborted");
        }
        this.result = result;
        const pending = result.access.filter((a) => a.status === "pending");
        if (result.applied) {
          logger.info(
            { service: result.service, changed: result.changed, attempt },
            "Registered with core"
          );
        } else {
          logger.warn(
            { service: result.service, version: declaration.version, attempt },
            "Core ignored the declaration: it applied a newer version"
          );
        }
        if (pending.length > 0) {
          logger.warn(
            { service: result.service, pending: pending.map((a) => a.target) },
            "Requested access awaits an admin's approval in core"
          );
        }
        return result;
      } catch (err) {
        if (!isRetryable(err)) {
          logger.error(
            {
              status: getOriginalStatus(err),
              response: getOriginalResponseData(err),
            },
            "Core refused the declaration; fix it and redeploy"
          );
          throw err;
        }
        const ceiling = Math.min(
          this.baseDelayMs * 2 ** (attempt - 1),
          this.maxDelayMs
        );
        const delay = Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
        logger.warn(
          {
            attempt,
            nextRetryInMs: delay,
            status: getOriginalStatus(err),
            response: getOriginalResponseData(err),
          },
          "Registration with core failed; retrying"
        );
        await sleep(delay, signal);
      }
    }
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Registration aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
