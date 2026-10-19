import { isRedisReady, limiterUnavailable } from "./rateLimit.js";
import { canonicalJson } from "./uploadIdempotency.js";
import { getRedisClient, redisKey } from "./redis.js";
import { createHash, randomUUID } from "crypto";
import { logger } from "./logger.js";
import {
  IdempotencyInProgressError,
  UnprocessableEntityError,
} from "./errors.js";

const AUDIT_IDEMPOTENCY_PREFIX = "audit-log-service:idempotency:";
export const NOTIFICATIONS_IDEMPOTENCY_PREFIX = "notifications:idempotency:";
const PENDING_PREFIX = "pending:";
const PENDING_TTL = 60; // 60 seconds for the "pending" claim
const RESULT_TTL = 86400; // 24 hours for the stored result

export interface AuditIdempotencyScope {
  userId: string;
  /** The write endpoint, so one key never replays the other endpoint's result. */
  route: "entries" | "entries/batch" | "notifications";
  /** Redis key prefix; audit's own when absent. */
  prefix?: string;
  /** The client's `idempotencyKey`; without one the write just runs. */
  key: string | undefined;
  /** The validated body, without `idempotencyKey`. */
  body: unknown;
}

interface StoredResult {
  bodyHash: string;
  result: unknown;
}

// Deletes KEYS[1] only while it still holds ARGV[1].
const DELETE_IF_EQUALS =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

const reused = () =>
  new UnprocessableEntityError(
    "idempotency_key_conflict",
    "This idempotency key was already used with a different request body"
  );

/**
 * Runs `write` once per (user, endpoint, idempotency key). A repeat with the
 * same body replays the stored result for 24h; a repeat with a different body
 * is a 422, and one while the first is still running a 409. The claim is a
 * SET NX with a short TTL, so a crash mid-write doesn't leave the key stuck,
 * and it is released if `write` throws so the client can retry. A stored
 * value that cannot be read is a cache miss: it is dropped and the key
 * claimed again.
 */
export async function withAuditIdempotency<T>(
  scope: AuditIdempotencyScope,
  write: () => Promise<T>
): Promise<unknown> {
  if (!scope.key) return write();

  // Without Redis no key can be checked: refuse with a 503 rather than wait
  // for a reconnect or write what may be a duplicate.
  const redis = getRedisClient();
  if (!isRedisReady(redis)) throw limiterUnavailable();
  const claimRedis = async <R>(command: () => Promise<R>): Promise<R> => {
    try {
      return await command();
    } catch (err) {
      logger.error(
        { err },
        "Redis unavailable while claiming an idempotency key"
      );
      throw limiterUnavailable();
    }
  };
  const prefix = scope.prefix ?? AUDIT_IDEMPOTENCY_PREFIX;
  const key = redisKey(`${prefix}${scope.userId}:${scope.route}:${scope.key}`);
  const bodyHash = createHash("sha256")
    .update(canonicalJson(scope.body))
    .digest("hex");

  // Unique per request, so releasing the claim cannot release another's.
  const pending = `${PENDING_PREFIX}${bodyHash}:${randomUUID()}`;
  const claim = () =>
    claimRedis(() => redis.set(key, pending, "EX", PENDING_TTL, "NX"));
  let claimed = await claim();

  if (claimed !== "OK") {
    const cached = await claimRedis(() => redis.get(key));
    if (!cached || cached.startsWith(PENDING_PREFIX)) {
      if (cached && pendingBodyHash(cached) !== bodyHash) throw reused();
      throw new IdempotencyInProgressError();
    }
    const stored = parseStored(cached);
    if (stored) {
      if (stored.bodyHash !== bodyHash) throw reused();
      return stored.result;
    }
    logger.warn(
      { userId: scope.userId, route: scope.route },
      "Dropping an unreadable idempotency entry"
    );
    // Only the unreadable value is dropped: a request that claimed the key
    // since then keeps its claim, and this one gets the 409.
    await claimRedis(() => redis.eval(DELETE_IF_EQUALS, 1, key, cached));
    claimed = await claim();
    if (claimed !== "OK") throw new IdempotencyInProgressError();
  }

  let result: T;
  try {
    result = await write();
  } catch (err) {
    // Only this request's claim: past PENDING_TTL the key may be another's.
    // A failed release just leaves the claim to expire.
    await redis.eval(DELETE_IF_EQUALS, 1, key, pending).catch((releaseErr) => {
      logger.warn(
        { err: releaseErr },
        "Failed to release an idempotency claim after a failed write"
      );
    });
    throw err;
  }

  // The write committed: failing now would have the client retry and write it
  // again. The pending claim stays until it expires.
  const stored: StoredResult = { bodyHash, result };
  await redis
    .set(key, JSON.stringify(stored), "EX", RESULT_TTL)
    .catch((err) => {
      logger.error({ err }, "Failed to cache a write's idempotency result");
    });
  return result;
}

/** The body hash a pending claim was made for. */
function pendingBodyHash(cached: string): string {
  return cached.slice(PENDING_PREFIX.length).split(":")[0];
}

/** The stored result, or null when the value is not one. */
function parseStored(cached: string): StoredResult | null {
  try {
    const stored = JSON.parse(cached) as StoredResult;
    if (typeof stored?.bodyHash === "string") return stored;
  } catch {
    // Not JSON: unreadable, as below.
  }
  return null;
}
