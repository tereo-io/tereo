import { logger } from "../utils/logger.js";
import { Job, Queue } from "bullmq";
import env from "../env.js";

/**
 * Module-level shutdown flag. Flipped to `true` by `markShuttingDown()` when
 * `stopBackgroundJobs()` begins tearing down workers. Long-running per-tick
 * loops poll this between iterations and bail out early so in-flight jobs can
 * re-enqueue a continuation before BullMQ force-closes the worker.
 *
 * The flag flips BEFORE `worker.close()` is called. Once flipped, the next
 * iteration of any `createTimeBoxedLoop` run returns `{ completed: false }`
 * with the last cursor, and the worker can (a) re-enqueue a continuation and
 * (b) return promptly so shutdown proceeds inside k8s' termination grace.
 */
let shuttingDown = false;

export function markShuttingDown(): void {
  shuttingDown = true;
}

export function resetShuttingDown(): void {
  // Test-only: allow successive test runs in the same process to re-enter a
  // "running" state after a simulated shutdown.
  shuttingDown = false;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Default time-box / heartbeat values. Can be overridden per-call.
 * Pulled from env so ops can tune without redeploying.
 */
function defaultTimeBoxMs(): number {
  return env.FILE_SERVICE_SWEEP_TIME_BOX_SECONDS * 1000;
}

function defaultHeartbeatMs(): number {
  return env.FILE_SERVICE_SWEEP_HEARTBEAT_SECONDS * 1000;
}

export interface TimeBoxedLoopOptions<Cursor> {
  /** The BullMQ Job we're processing inside of. Used for `updateProgress`. */
  job: Job;
  /**
   * Per-iteration work. Given the current cursor (undefined on first tick),
   * returns the next cursor and whether more work remains. Returning
   * `{ hasMore: false }` ends the loop; the caller should consider the
   * batch completed.
   */
  tick: (cursor: Cursor | undefined) => Promise<{
    cursor?: Cursor;
    hasMore: boolean;
    processed: number;
  }>;
  /** Max wall-clock time before we yield. Defaults to env-configured value. */
  maxDurationMs?: number;
  /** updateProgress cadence. Defaults to env-configured value. */
  heartbeatIntervalMs?: number;
  /** Optional starting cursor; forwarded to the first `tick` call. */
  initialCursor?: Cursor;
  /** Arbitrary metadata merged into progress payloads for observability. */
  progressMeta?: Record<string, unknown>;
}

export interface TimeBoxedLoopResult<Cursor> {
  completed: boolean;
  resumeCursor?: Cursor;
  totalProcessed: number;
  iterations: number;
}

/**
 * Run `tick` repeatedly until either:
 *   (a) `hasMore` is false (natural completion),
 *   (b) wall-clock exceeds `maxDurationMs` (time-box), or
 *   (c) `isShuttingDown()` flips true (graceful shutdown).
 *
 * Emits `job.updateProgress` at least every `heartbeatIntervalMs` — this keeps
 * BullMQ's stall checker happy during long runs and gives ops a live view.
 *
 * Returns a result describing whether the caller should re-enqueue a
 * continuation (with `resumeCursor`) or consider the work done.
 */
export async function createTimeBoxedLoop<Cursor>(
  options: TimeBoxedLoopOptions<Cursor>
): Promise<TimeBoxedLoopResult<Cursor>> {
  const maxDurationMs = options.maxDurationMs ?? defaultTimeBoxMs();
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? defaultHeartbeatMs();
  const started = Date.now();
  let lastHeartbeat = 0;
  let cursor: Cursor | undefined = options.initialCursor;
  let totalProcessed = 0;
  let iterations = 0;

  async function heartbeat(extra: Record<string, unknown> = {}) {
    const now = Date.now();
    if (now - lastHeartbeat < heartbeatIntervalMs) return;
    lastHeartbeat = now;
    try {
      await options.job.updateProgress({
        ...options.progressMeta,
        totalProcessed,
        iterations,
        elapsedMs: now - started,
        ...extra,
      });
    } catch (err) {
      // Heartbeats are best-effort; don't fail the job because Redis hiccuped.
      logger.debug(
        {
          jobId: options.job.id,
          err,
        },
        "job progress heartbeat failed"
      );
    }
  }

  // Initial heartbeat so BullMQ sees activity immediately.
  await heartbeat({ phase: "start" });

  while (true) {
    if (isShuttingDown()) {
      await heartbeat({ phase: "shutdown" });
      return {
        completed: false,
        resumeCursor: cursor,
        totalProcessed,
        iterations,
      };
    }
    if (Date.now() - started >= maxDurationMs) {
      await heartbeat({ phase: "time-box" });
      return {
        completed: false,
        resumeCursor: cursor,
        totalProcessed,
        iterations,
      };
    }

    const tickResult = await options.tick(cursor);
    iterations++;
    totalProcessed += tickResult.processed;
    cursor = tickResult.cursor ?? cursor;

    await heartbeat();

    if (!tickResult.hasMore) {
      await heartbeat({ phase: "complete" });
      return { completed: true, totalProcessed, iterations };
    }
  }
}

/**
 * Enqueue a continuation for a self-driving job. Uses a deterministic jobId so
 * duplicate continuations (e.g. after a worker crash) collapse to a single
 * pending job in the queue. The `counter` parameter lets the caller produce a
 * fresh id for each continuation — without it, BullMQ would dedupe the
 * self-reschedule and the job would never advance.
 */
export async function scheduleContinuation(
  queue: Queue,
  jobName: string,
  data: unknown,
  options: {
    jobId?: string;
    delayMs?: number;
  } = {}
): Promise<void> {
  await queue.add(jobName, data, {
    ...(options.jobId ? { jobId: options.jobId } : {}),
    delay: options.delayMs ?? 0,
  });
}
