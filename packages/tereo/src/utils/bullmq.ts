import { closeRedisClient, getRedisClient, redisKey } from "./redis.js";
import { JobsOptions, Queue, QueueOptions } from "bullmq";
import type { Redis } from "ioredis";
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  Span,
} from "@opentelemetry/api";

const TRACE_CONTEXT_KEY = "_otelctx";
const tracer = trace.getTracer("tereo/bullmq");

/**
 * Shared retry presets for BullMQ jobs across the monorepo. Pick the tier
 * that matches the failure profile of the work.
 */
export const RETRY_POLICIES = {
  /** Fast-failing transient work (network, downstream API). Aggressive retry. */
  TRANSIENT: {
    attempts: 5,
    backoff: { type: "exponential" as const, delay: 5_000 },
  },
  /** Recurring evaluation jobs (scheduled checks, allocations). */
  SCHEDULED: {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 2_000 },
  },
  /** Maintenance / housekeeping (sweeps, lifecycle, reconciliation). */
  MAINTENANCE: {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 60_000 },
  },
  /** One-shot work that should not retry. */
  ONESHOT: { attempts: 1 },
} satisfies Record<string, JobsOptions>;

/**
 * Removal retention presets. `removeOnComplete` keeps the last N succeeded jobs,
 * `removeOnFail` keeps the last N failed jobs (for forensics).
 */
export const REMOVAL_POLICIES = {
  /** Keep more failed jobs for investigation (deliveries, audit). */
  TRANSIENT: { removeOnComplete: 100, removeOnFail: 500 },
  /** Default operational retention. */
  DEFAULT: { removeOnComplete: 100, removeOnFail: 100 },
  /** Lighter retention for housekeeping queues. */
  MAINTENANCE: { removeOnComplete: 50, removeOnFail: 100 },
} satisfies Record<
  string,
  Pick<JobsOptions, "removeOnComplete" | "removeOnFail">
>;

const injectTraceContext = <T>(data: T): T => {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (Object.keys(carrier).length === 0) return data;
  // Only plain object payloads can carry the carrier. Primitives have no
  // place to attach it; arrays would lose array semantics under spread
  // (`{ ...[1,2,3], _otelctx }` becomes a non-array record). In both cases
  // the producer span is still emitted but the consumer side can't link.
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return data;
  return { ...(data as object), [TRACE_CONTEXT_KEY]: carrier } as T;
};

const recordError = (span: Span, err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  span.recordException(e);
  span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
};

const CLOSE_CHECK_MS = 2_000;

/**
 * BullMQ's close waits on Redis (QUIT, jobs finishing their Redis writes) and
 * never returns while Redis is unreachable. Waits for `closing` as long as
 * `connection` is up; returns false once it has been down at a check.
 */
export const awaitClose = async (
  closing: Promise<void>,
  connection: Redis
): Promise<boolean> => {
  const settled = closing.then(() => true);
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const checked = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_CHECK_MS);
    });
    try {
      if (await Promise.race([settled, checked])) return true;
    } finally {
      clearTimeout(timer);
    }
    if (connection.status !== "ready") {
      settled.catch(() => undefined);
      return false;
    }
  }
};

/**
 * BullMQ closed during its start-up (reading the server version on each of
 * its connections) leaves that read to fail once the connection goes, after
 * its close has removed the listener the failure is reported to: an unhandled
 * rejection. Waits for the start-up as long as `connection` is up.
 */
export const awaitStarted = (
  starting: Promise<unknown>,
  connection: Redis
): Promise<boolean> =>
  awaitClose(
    starting.then(() => undefined),
    connection
  ).catch(() => false);

/**
 * Create a BullMQ Queue using the shared Redis singleton. Always passes a
 * `.duplicate()` connection so the singleton isn't blocked by BullMQ commands.
 *
 * Wraps `add` / `addBulk` to inject the active OTel trace context into the
 * job payload so the worker side can extract it and continue the trace.
 */
export const createQueue = <T = unknown>(
  name: string,
  options?: Omit<QueueOptions, "connection">
): Queue<T> => {
  const connection = getRedisClient().duplicate();
  const queue = new Queue<T>(name, {
    ...options,
    prefix: redisKey("bull"),
    connection,
  });

  // BullMQ leaves a connection it was handed open.
  const originalClose = queue.close.bind(queue);
  queue.close = async () => {
    try {
      await awaitStarted(queue.waitUntilReady(), connection);
      await awaitClose(originalClose(), connection);
    } finally {
      await closeRedisClient(connection);
    }
  };

  const originalAdd = queue.add.bind(queue);
  queue.add = (async (jobName, data, opts) => {
    return tracer.startActiveSpan(
      `bullmq.publish ${name}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          "messaging.system": "bullmq",
          "messaging.destination.name": name,
          "messaging.operation.name": "publish",
          "bullmq.job.name": jobName,
        },
      },
      async (span) => {
        try {
          return await originalAdd(jobName, injectTraceContext(data), opts);
        } catch (err) {
          recordError(span, err);
          throw err;
        } finally {
          span.end();
        }
      }
    );
  }) as typeof queue.add;

  const originalAddBulk = queue.addBulk.bind(queue);
  queue.addBulk = (async (jobs) => {
    return tracer.startActiveSpan(
      `bullmq.publish ${name}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          "messaging.system": "bullmq",
          "messaging.destination.name": name,
          "messaging.operation.name": "publish",
          "messaging.batch.message_count": jobs.length,
        },
      },
      async (span) => {
        try {
          const enriched = jobs.map((job) => ({
            ...job,
            data: injectTraceContext(job.data),
          }));
          return await originalAddBulk(enriched);
        } catch (err) {
          recordError(span, err);
          throw err;
        } finally {
          span.end();
        }
      }
    );
  }) as typeof queue.addBulk;

  return queue;
};
