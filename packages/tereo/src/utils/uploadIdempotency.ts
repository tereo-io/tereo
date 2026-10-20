import { Prisma } from "../../prisma/generated/client/index.js";
import { getRedisClient, redisKey } from "./redis.js";
import { randomUUID } from "node:crypto";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import {
  BadRequestError,
  IdempotencyInProgressError,
  UnprocessableEntityError,
} from "./errors.js";

const PENDING_PREFIX = "file-service:idempotency:";
const PENDING_TTL_SECONDS = 60;
// A claim is renewed this often while its request runs, so it outlives a
// request slower than its TTL and lapses only once the process holding it
// is gone.
const CLAIM_RENEW_MS = 5_000;
const RESULT_TTL_SECONDS = 24 * 60 * 60;

// Renew or release a claim only while it is still this holder's.
const RENEW_IF_OWNED = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_IF_OWNED = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Keeps a claim alive until the returned function is called. */
function keepClaimAlive(key: string, token: string): () => void {
  const redis = getRedisClient();
  const timer = setInterval(() => {
    redis
      .eval(RENEW_IF_OWNED, 1, key, token, PENDING_TTL_SECONDS * 1000)
      .catch((err: unknown) =>
        logger.warn({ key, err }, "Claim renewal failed")
      );
  }, CLAIM_RENEW_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function releaseClaim(key: string, token: string): Promise<void> {
  await getRedisClient().eval(RELEASE_IF_OWNED, 1, key, token);
}

/**
 * Runs `fn` holding the Redis claim `key`, renewed while it runs, so no other
 * caller can run it at the same time; a caller that finds the claim held gets
 * `busy()` thrown. Released when `fn` settles.
 */
export async function withExclusiveClaim<T>(
  name: string,
  busy: () => Error,
  fn: () => Promise<T>
): Promise<T> {
  const key = redisKey(name);
  const token = randomUUID();
  const claimed = await getRedisClient().set(
    key,
    token,
    "EX",
    PENDING_TTL_SECONDS,
    "NX"
  );
  if (claimed !== "OK") throw busy();
  const stop = keepClaimAlive(key, token);
  try {
    return await fn();
  } finally {
    stop();
    await releaseClaim(key, token).catch(() => {});
  }
}

/** Whether `withExclusiveClaim(name, …)` is running somewhere now. */
export async function isClaimHeld(name: string): Promise<boolean> {
  return (await getRedisClient().exists(redisKey(name))) === 1;
}

export interface IdempotencyInput {
  scope: string;
  key: string;
  requestHash: string;
  userId: string;
}

export interface IdempotencyResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const pendingRedisKey = (scope: string, key: string): string =>
  redisKey(`${PENDING_PREFIX}${scope}:${key}`);

async function findLiveRecord(scope: string, key: string) {
  return prisma.idempotencyRecord.findFirst({
    where: { scope, key, expiresAt: { gt: new Date() } },
  });
}

/** Whether a request under (scope, key) has a stored response to replay. */
export async function hasStoredResult(
  scope: string,
  key: string
): Promise<boolean> {
  return (await findLiveRecord(scope, key)) !== null;
}

function replayOrConflict<T>(
  existing: {
    requestHash: string;
    responseStatus: number;
    responseBody: unknown;
    createdAt: Date;
  },
  requestHash: string
): IdempotencyResult<T> {
  if (existing.requestHash !== requestHash) {
    throw new UnprocessableEntityError(
      "idempotency_key_conflict",
      `This idempotency key was first used at ${existing.createdAt.toISOString()} with a different request payload`
    );
  }
  return {
    status: existing.responseStatus,
    body: existing.responseBody as T,
    replayed: true,
  };
}

export type PersistIdempotentResult<T> = (
  tx: Prisma.TransactionClient,
  result: { status: number; body: T }
) => Promise<void>;

/**
 * Wrap a handler with idempotency semantics.
 *
 * - First call for (scope, key): runs handler, persists response to Postgres, returns with replayed=false.
 * - Replay with same requestHash: returns the cached response with replayed=true.
 * - Replay with different requestHash: throws UnprocessableEntityError "idempotency_key_conflict" (422).
 * - Concurrent call with same key: throws 409 `idempotency_request_in_progress`.
 * - On handler error: releases the Redis claim and propagates.
 *
 * A handler that writes calls `persist` inside its own transaction, so the
 * record commits with the write or not at all: a retry after a failure
 * between the two would otherwise repeat the write. A handler that returns
 * without calling it (it wrote nothing) has its result stored afterwards.
 *
 * Lookup order: Postgres first (source of truth for completed requests),
 * Redis second (concurrency guard only, 60s TTL). Expired Postgres rows are
 * ignored so a deterministic key can be safely reused after its TTL.
 */
export async function withIdempotency<T>(
  input: IdempotencyInput,
  handler: (
    persist: PersistIdempotentResult<T>
  ) => Promise<{ status: number; body: T }>
): Promise<IdempotencyResult<T>> {
  const { scope, key, requestHash } = input;
  const redis = getRedisClient();
  const claimKey = pendingRedisKey(scope, key);

  const preExisting = await findLiveRecord(scope, key);
  if (preExisting) return replayOrConflict<T>(preExisting, requestHash);

  const token = randomUUID();
  const claimed = await redis.set(
    claimKey,
    token,
    "EX",
    PENDING_TTL_SECONDS,
    "NX"
  );

  if (claimed !== "OK") {
    // A concurrent request holds the claim. It may have finished between our
    // pre-check and this point — check Postgres once more before declaring a
    // 409.
    const postExisting = await findLiveRecord(scope, key);
    if (postExisting) return replayOrConflict<T>(postExisting, requestHash);
    throw new IdempotencyInProgressError();
  }

  // The request that held the claim may have stored its record and released
  // the claim between our first lookup and our claim; running the handler
  // again would repeat its write.
  const raced = await findLiveRecord(scope, key).catch(async (err) => {
    await releaseClaim(claimKey, token);
    throw err;
  });
  if (raced) {
    await releaseClaim(claimKey, token);
    return replayOrConflict<T>(raced, requestHash);
  }

  let persisted = false;
  const persist: PersistIdempotentResult<T> = async (tx, result) => {
    await storeRecord(tx, input, result);
    persisted = true;
  };

  const stopRenewal = keepClaimAlive(claimKey, token);
  try {
    const result = await handler(persist);
    if (!persisted) await storeRecord(prisma, input, result);
    stopRenewal();
    await releaseClaim(claimKey, token);
    return { status: result.status, body: result.body, replayed: false };
  } catch (err) {
    stopRenewal();
    await releaseClaim(claimKey, token);
    logger.warn(
      {
        scope,
        key,
        err,
      },
      "Idempotency handler failed; claim released"
    );
    throw err;
  }
}

async function storeRecord(
  client: Prisma.TransactionClient,
  input: IdempotencyInput,
  result: { status: number; body: unknown }
): Promise<void> {
  const { scope, key, requestHash, userId } = input;
  const expiresAt = new Date(Date.now() + RESULT_TTL_SECONDS * 1000);
  // Upsert so a not-yet-swept expired row with the same (scope, key) is
  // refreshed rather than colliding on the unique index.
  await client.idempotencyRecord.upsert({
    where: { scope_key: { scope, key } },
    create: {
      scope,
      key,
      requestHash,
      responseStatus: result.status,
      responseBody: result.body as Prisma.InputJsonValue,
      createdBy: userId,
      expiresAt,
    },
    update: {
      requestHash,
      responseStatus: result.status,
      responseBody: result.body as Prisma.InputJsonValue,
      createdBy: userId,
      createdAt: new Date(),
      expiresAt,
    },
  });
}

/**
 * The stored response of a request under any of `scopes`, whatever its key,
 * that hashed to `requestHash` — the same request sent under another
 * idempotency key.
 */
export async function findStoredResponse<T>(
  scopes: string[],
  requestHash: string
): Promise<{ status: number; body: T } | null> {
  const record = await prisma.idempotencyRecord.findFirst({
    where: {
      scope: { in: scopes },
      requestHash,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "asc" },
  });
  return record
    ? { status: record.responseStatus, body: record.responseBody as T }
    : null;
}

/**
 * Reads the required `Idempotency-Key` header from a request.
 * Throws BadRequestError("idempotency_key_required") if missing, empty, or too long.
 * The returned key is trimmed so leading/trailing whitespace doesn't produce
 * distinct cache entries.
 */
export function requireIdempotencyKey(
  header: string | string[] | undefined
): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new BadRequestError(
      "idempotency_key_required",
      "The Idempotency-Key header is required on this endpoint"
    );
  }
  if (trimmed.length > 255) {
    throw new BadRequestError(
      "idempotency_key_required",
      "Idempotency-Key must be 255 characters or fewer"
    );
  }
  return trimmed;
}

/**
 * Canonical JSON stringification for idempotency request hashing. Object keys
 * are sorted recursively so payloads that differ only in key insertion order
 * produce the same hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}
