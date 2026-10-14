import { awaitClose, awaitStarted } from "../utils/bullmq.js";
import { Processor, Worker, WorkerOptions } from "bullmq";
import { closeRedisClient } from "../utils/redis.js";
import { Redis } from "ioredis";

const workers = new Set<
  Pick<TrackedWorker, "name" | "stopping" | "closing" | "isRunning">
>();

/**
 * A BullMQ `Worker` the worker health check can see. Closing one takes it
 * out, so a process that stops and starts its jobs (tests) only reports the
 * live set.
 */
export class TrackedWorker<
  DataType = unknown,
  ResultType = unknown,
  NameType extends string = string,
> extends Worker<DataType, ResultType, NameType> {
  constructor(
    name: string,
    processor: Processor<DataType, ResultType, NameType>,
    opts: WorkerOptions
  ) {
    super(name, processor, opts);
    workers.add(this);
    this.once("closed", () => workers.delete(this));
    if (opts.connection instanceof Redis) this.redis = opts.connection;
  }

  private readonly redis?: Redis;

  /** Set once close is called, before it reaches BullMQ's own close. */
  stopping = false;

  /**
   * Also closes the connection the worker was handed, which BullMQ leaves
   * open. While Redis is unreachable BullMQ's close never finishes: stop
   * waiting on it and drop the connections it would have closed.
   */
  override async close(force = false): Promise<void> {
    this.stopping = true;
    if (!this.redis) return super.close(force);
    try {
      await awaitStarted(this.waitUntilReady(), this.redis);
      if (!(await awaitClose(super.close(force), this.redis))) {
        workers.delete(this);
        // BullMQ's own connection for blocking reads, not exposed in its types.
        const { blockingConnection } = this as unknown as {
          blockingConnection: { disconnect(wait: boolean): Promise<void> };
        };
        void blockingConnection.disconnect(false).catch(() => undefined);
      }
    } finally {
      await closeRedisClient(this.redis);
    }
  }
}

export interface WorkerStatus {
  total: number;
  /** Queue names of workers that are closing or whose run loop has exited. */
  stopped: string[];
}

export const workerStatus = (): WorkerStatus => {
  const stopped = [...workers]
    .filter((w) => w.stopping || w.closing !== undefined || !w.isRunning())
    .map((w) => w.name);
  return { total: workers.size, stopped };
};
