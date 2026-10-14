import { TrackedWorker, workerStatus } from "../jobs/workerRegistry.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorkerHealthServer } from "../utils/health.js";
import { getRedisClient } from "../utils/redis.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import axios from "axios";

// The suite's server runs ROLE=all in another process; this file's process
// starts no BullMQ workers of its own, so it controls the tracked set.
const QUEUE = "test-worker-health";

describe("worker health listener", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = await startWorkerHealthServer(0);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const newWorker = () =>
    new TrackedWorker(QUEUE, async () => undefined, {
      connection: getRedisClient().duplicate(),
    });

  it("is degraded with no BullMQ workers running", async () => {
    const res = await axios.get(`${url}/health`, {
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
    expect(res.data).toMatchObject({
      status: "degraded",
      role: "worker",
      workers: { total: 0 },
    });
    expect(res.data.db).toBeUndefined();
    expect(res.data.redis).toBeUndefined();
  });

  it("is ok with the DB, Redis and a running worker", async () => {
    const worker = newWorker();
    try {
      const res = await axios.get(`${url}/health`, {
        validateStatus: () => true,
      });
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({
        status: "ok",
        service: "tereo",
        role: "worker",
        workers: { total: 1 },
      });
      expect(new Date(res.data.timestamp).toISOString()).toBe(
        res.data.timestamp
      );
      // The image's HEALTHCHECK uses `wget --spider`, which sends HEAD.
      const head = await axios.head(`${url}/health`, {
        validateStatus: () => true,
      });
      expect(head.status).toBe(200);
    } finally {
      await worker.close();
    }
  });

  it("reports a closing worker as stopped, and forgets it once closed", async () => {
    const worker = newWorker();
    const closed = worker.close();
    expect(workerStatus()).toEqual({ total: 1, stopped: [QUEUE] });
    await closed;
    expect(workerStatus()).toEqual({ total: 0, stopped: [] });
  });

  it("answers nothing but GET and HEAD /health", async () => {
    const other = await axios.get(`${url}/`, { validateStatus: () => true });
    expect(other.status).toBe(404);
    const post = await axios.post(`${url}/health`, undefined, {
      validateStatus: () => true,
    });
    expect(post.status).toBe(404);
  });
});
