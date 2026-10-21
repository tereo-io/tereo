/**
 * Response from core's `GET /health`. Core answers 503 with `status: "degraded"`
 * when Postgres or Redis does not respond.
 */
export interface FileServiceHealth {
  /** `"ok"` when healthy, `"degraded"` otherwise. */
  status: "ok" | "degraded";
  /** Service name — always `"tereo"`. */
  service: string;
  /** ISO timestamp when the health check ran. */
  timestamp: string;
  /** Present, as `"fail"`, only when the database check failed. */
  db?: "fail";
  /** Present, as `"fail"`, only when the Redis check failed. */
  redis?: "fail";
}
