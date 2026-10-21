import { ServiceUnavailableError, TooManyRequestsError } from "./errors.js";
import { Request, RequestHandler, Response, NextFunction } from "express";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { getRedisClient, redisKey } from "./redis.js";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { redactUrl } from "../telemetry/redact.js";
import { logger } from "./logger.js";

// When Redis is unreachable:
// - Credential limiters (createFailureLimiter, createBackoffLimiter and the
//   share unlock limiter) fail closed with 503 temporarily_unavailable: an
//   outage must not turn into unlimited password or code guessing.
// - The general request limiters (createRateLimitMiddleware and
//   createPreAuthRateLimitMiddleware) fail open, so an outage does not take
//   the whole API down with it.
// All of them give up at once while the client is not "ready", rather than
// waiting in ioredis's offline queue for Redis to come back.

const EXTERNAL_POINTS = 100;
const INTERNAL_POINTS = 1000;
// Per IP, before authentication: above the per-user limit, so a NAT shared by
// several users reaches their own limits first.
const PRE_AUTH_EXTERNAL_POINTS = 300;
const PRE_AUTH_INTERNAL_POINTS = 1000;
const DURATION_SECONDS = 1;
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** A credential limiter could not reach Redis: refuse rather than guess. */
export const limiterUnavailable = (): ServiceUnavailableError =>
  new ServiceUnavailableError(
    "The service is temporarily unavailable. Please try again later.",
    UNAVAILABLE_RETRY_AFTER_SECONDS
  );

/** Whether the client can take a command now, not after a reconnect. */
export const isRedisReady = (redis: { status?: string }): boolean =>
  redis.status === "ready";

export interface FailureLimiterConfig {
  keyPrefix: string;
  points: number;
  duration: number;
  errorDescription?: string;
  /** `subject` is what the caller passed to `check`/`reset`, e.g. a user id. */
  getKey: (req: Request, subject?: string) => string;
  logExtra?: (req: Request, subject?: string) => Record<string, unknown>;
  /**
   * Without Redis, let `assertUnderLimit`, `recordFailure` and `reset` pass
   * (logged at warn) instead of refusing with 503: for a credential that is
   * verified either way and must not gain a Redis dependency. `check` still
   * fails closed.
   */
  failOpen?: boolean;
}

/**
 * Counts attempts at a credential. `check` spends one attempt before the
 * credential is verified, atomically, so concurrent requests cannot all pass
 * a check made before any of them failed; a success calls `reset`. Over the
 * limit, `check` throws a 429 (TooManyRequestsError); without Redis, a 503
 * (`limiterUnavailable`).
 */
export interface FailureLimiter {
  check: (req: Request, subject?: string) => Promise<void>;
  reset: (req: Request, subject?: string) => Promise<void>;
}

/**
 * A `FailureLimiter` that can also be used the other way round, for a
 * credential whose correct use must never be refused for being frequent:
 * `assertUnderLimit` refuses only once the stored failures reach the limit,
 * spending nothing, and `recordFailure` spends one after a wrong credential.
 * Concurrent wrong attempts can all pass the read before any is recorded, so
 * this suits high-entropy secrets, not passwords or codes.
 */
export interface PeekableFailureLimiter extends FailureLimiter {
  assertUnderLimit: (req: Request, subject?: string) => Promise<void>;
  recordFailure: (req: Request, subject?: string) => Promise<void>;
  /**
   * Gives back the attempt a successful `check` spent: for a key shared by
   * several accounts (a client and IP), where `reset` would let one account's
   * success clear the failures against the others.
   */
  refund: (req: Request, subject?: string) => Promise<void>;
}

type ReqWithAuth = Request & {
  auth?: {
    userId?: string;
    userType?: "human" | "service_account";
    oauthClientId?: string | null;
  };
};

const DEFAULT_INTERNAL_CIDRS: Array<[string, number, "ipv4" | "ipv6"]> = [
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
];

const internalNetworks = buildInternalBlockList();

function buildInternalBlockList(): BlockList {
  const list = new BlockList();
  const override = process.env.INTERNAL_NETWORK_CIDRS?.trim();
  if (override) {
    for (const entry of override.split(",")) {
      const cidr = entry.trim();
      if (!cidr) continue;
      const [address, prefixStr] = cidr.split("/");
      const prefix = Number(prefixStr);
      if (!address || !Number.isFinite(prefix)) {
        logger.warn({ entry }, "Ignoring invalid INTERNAL_NETWORK_CIDRS entry");
        continue;
      }
      const family = isIPv6(address) ? "ipv6" : "ipv4";
      try {
        list.addSubnet(address, prefix, family);
      } catch (err) {
        logger.warn(
          {
            entry,
            err,
          },
          "Failed to add INTERNAL_NETWORK_CIDRS entry"
        );
      }
    }
    return list;
  }
  for (const [address, prefix, family] of DEFAULT_INTERNAL_CIDRS) {
    list.addSubnet(address, prefix, family);
  }
  return list;
}

const normalizeIp = (
  ip: string
): { address: string; family: "ipv4" | "ipv6" } | null => {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && mapped[1]) return { address: mapped[1], family: "ipv4" };
  if (isIPv4(ip)) return { address: ip, family: "ipv4" };
  if (isIPv6(ip)) return { address: ip, family: "ipv6" };
  return null;
};

const hasProxyHeader = (req: Request): boolean =>
  !!(
    req.headers["x-forwarded-for"] ||
    req.headers["forwarded"] ||
    req.headers["x-real-ip"]
  );

/** A direct connection (no proxy header) from an internal network address. */
const isInternalByNetwork = (req: Request): boolean => {
  if (hasProxyHeader(req)) return false;

  const peer = req.socket.remoteAddress;
  if (!peer) return false;
  const normalized = normalizeIp(peer);
  if (!normalized) return false;

  return internalNetworks.check(normalized.address, normalized.family);
};

function isInternalRequest(req: Request): boolean {
  if (!isInternalByNetwork(req)) return false;
  const auth = (req as ReqWithAuth).auth;
  return auth?.userType === "service_account";
}

export interface CreateRateLimitOpts {
  /**
   * Optional cost calculator. Returns the number of points the request should
   * consume. Defaults to 1 per request. Useful for batch endpoints where one
   * HTTP request represents N units of work (e.g. resolve/batch with N items).
   * Values < 1 are clamped to 1.
   */
  getCost?: (req: Request) => number;
}

interface TieredLimiterConfig {
  keyPrefix: string;
  externalPoints: number;
  internalPoints: number;
  /** Set X-RateLimit-* on requests that pass, not only on a 429. */
  headersOnPass: boolean;
  classify: (req: Request) => { internal: boolean; key: string };
  getCost?: (req: Request) => number;
}

// Fails open: see the policy at the top of this file.
function createTieredLimiter(config: TieredLimiterConfig): RequestHandler {
  const { externalPoints, internalPoints, classify, getCost } = config;
  const keyPrefix = redisKey(config.keyPrefix);
  const options = {
    storeClient: getRedisClient(),
    duration: DURATION_SECONDS,
    rejectIfRedisNotReady: true,
  };
  const limiterExternal = new RateLimiterRedis({
    ...options,
    keyPrefix,
    points: externalPoints,
  });
  const limiterInternal = new RateLimiterRedis({
    ...options,
    keyPrefix: `${keyPrefix}:internal`,
    points: internalPoints,
  });

  return async (req: Request, res: Response, next: NextFunction) => {
    const { internal, key } = classify(req);
    const limiter = internal ? limiterInternal : limiterExternal;
    const points = internal ? internalPoints : externalPoints;

    let cost = 1;
    if (getCost) {
      const computed = getCost(req);
      cost = Number.isFinite(computed) ? Math.max(1, Math.floor(computed)) : 1;
    }

    try {
      const limiterRes = await limiter.consume(key, cost);
      if (config.headersOnPass) setRateLimitHeaders(res, limiterRes, points);
      next();
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        const auth = (req as ReqWithAuth).auth;
        const retryAfter = Math.ceil(error.msBeforeNext / 1000);
        logger.warn(
          {
            keyPrefix,
            tier: internal ? "internal" : "external",
            userId: auth?.userId,
            oauthClientId: auth?.oauthClientId ?? undefined,
            ip: getIpIdentifier(req),
            rateLimitKey: key,
            path: redactUrl(req.originalUrl ?? req.url),
            method: req.method,
            retryAfter,
          },
          "Rate limit exceeded"
        );

        setRateLimitHeaders(res, error, points);
        next(new TooManyRequestsError(retryAfter));
        return;
      }

      logger.warn(
        { keyPrefix, err: error },
        "Rate limiter unavailable; failing open"
      );
      next();
    }
  };
}

/**
 * The general limiter, after authentication: per user, per client IP when
 * unauthenticated, and per OAuth client for internal service accounts.
 */
export function createRateLimitMiddleware(
  serviceName: string,
  opts: CreateRateLimitOpts = {}
): RequestHandler {
  return createTieredLimiter({
    keyPrefix: `${serviceName}:ratelimit`,
    externalPoints: EXTERNAL_POINTS,
    internalPoints: INTERNAL_POINTS,
    headersOnPass: true,
    getCost: opts.getCost,
    classify: (req) => {
      const auth = (req as ReqWithAuth).auth;
      const internal = isInternalRequest(req);
      const key = internal
        ? `svc:${auth?.oauthClientId ?? req.socket.remoteAddress ?? "unknown"}`
        : auth?.userId
          ? `user:${auth.userId}`
          : `ip:${getIpIdentifier(req)}`;
      return { internal, key };
    },
  });
}

/**
 * A cheap per-IP limiter for before `requireAuth`, so a flood of missing or
 * invalid tokens is bounded without verifying any of them. The caller isn't
 * known yet, so an internal-network peer (by address alone) gets the internal
 * tier. A request that passes gets no headers; the general limiter, after
 * authentication, sets them. `scope` gives a route its own count, apart from
 * the API's.
 */
export function createPreAuthRateLimitMiddleware(
  serviceName: string,
  scope = "preauth"
): RequestHandler {
  return createTieredLimiter({
    keyPrefix: `${serviceName}:ratelimit:${scope}`,
    externalPoints: PRE_AUTH_EXTERNAL_POINTS,
    internalPoints: PRE_AUTH_INTERNAL_POINTS,
    headersOnPass: false,
    classify: (req) => ({
      internal: isInternalByNetwork(req),
      key: `ip:${getIpIdentifier(req)}`,
    }),
  });
}

const tooManyFailures = (
  req: Request,
  retryAfter: number,
  errorDescription: string,
  log: Record<string, unknown>
): TooManyRequestsError => {
  logger.warn(
    {
      ip: getIpIdentifier(req),
      path: redactUrl(req.originalUrl ?? req.url),
      method: req.method,
      retryAfter,
      ...log,
    },
    "Failure rate limit exceeded"
  );
  return new TooManyRequestsError(retryAfter, errorDescription);
};

const failClosed = (
  keyPrefix: string,
  error: unknown
): ServiceUnavailableError => {
  logger.error(
    { keyPrefix, err: error },
    "Credential limiter unavailable; refusing"
  );
  return limiterUnavailable();
};

export function createFailureLimiter(
  config: FailureLimiterConfig
): PeekableFailureLimiter {
  const {
    keyPrefix,
    points,
    duration,
    errorDescription = "Too many failed attempts. Please try again later.",
    getKey,
    logExtra,
    failOpen = false,
  } = config;

  // Created on first use, so a module defining a limiter can be loaded
  // before Redis is connected.
  let limiter: RateLimiterRedis | undefined;
  const getLimiter = () =>
    (limiter ??= new RateLimiterRedis({
      storeClient: getRedisClient(),
      keyPrefix: redisKey(keyPrefix),
      points,
      duration,
      rejectIfRedisNotReady: true,
    }));

  const refuse = (req: Request, msBeforeNext: number, subject?: string) =>
    tooManyFailures(
      req,
      Math.max(1, Math.ceil(msBeforeNext / 1000)),
      errorDescription,
      { keyPrefix, ...(logExtra?.(req, subject) ?? {}) }
    );

  const unavailable = (err: unknown): void => {
    if (!failOpen) throw failClosed(keyPrefix, err);
    logger.warn(
      { keyPrefix, err },
      "Credential limiter unavailable; continuing without it"
    );
  };
  const whenReady = () => {
    if (!isRedisReady(getRedisClient())) {
      throw new Error("Redis connection is not ready");
    }
    return getLimiter();
  };

  return {
    async reset(req, subject) {
      if (!failOpen) {
        await getLimiter().delete(getKey(req, subject));
        return;
      }
      try {
        await whenReady().delete(getKey(req, subject));
      } catch (err) {
        unavailable(err);
      }
    },
    async refund(req, subject) {
      if (!failOpen) {
        await getLimiter().reward(getKey(req, subject), 1);
        return;
      }
      try {
        await whenReady().reward(getKey(req, subject), 1);
      } catch (err) {
        unavailable(err);
      }
    },
    async check(req, subject) {
      try {
        await getLimiter().consume(getKey(req, subject), 1);
      } catch (error) {
        if (!(error instanceof RateLimiterRes)) {
          throw failClosed(keyPrefix, error);
        }
        throw refuse(req, error.msBeforeNext, subject);
      }
    },
    async assertUnderLimit(req, subject) {
      let res: RateLimiterRes | null;
      try {
        res = await whenReady().get(getKey(req, subject));
      } catch (err) {
        unavailable(err);
        return;
      }
      if (res && res.consumedPoints >= points) {
        throw refuse(req, res.msBeforeNext, subject);
      }
    },
    async recordFailure(req, subject) {
      try {
        await whenReady().consume(getKey(req, subject), 1);
      } catch (err) {
        // Over the limit already: the next assertUnderLimit refuses.
        if (!(err instanceof RateLimiterRes)) unavailable(err);
      }
    },
  };
}

export interface BackoffLimiterConfig {
  keyPrefix: string;
  /** Failures allowed back to back before the first delay. */
  freeAttempts: number;
  /** The first delay; each further failure doubles it. */
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  /** How long a counter with no further attempts is kept. */
  ttlSeconds: number;
  errorDescription?: string;
  /** `subject` is what the caller passed to `check`/`reset`. */
  getKey: (req: Request, subject?: string) => string;
}

// KEYS[1]: the counter. ARGV: freeAttempts, baseDelayMs, maxDelayMs,
// ttlSeconds, force. During a delay, unless force is 1, it returns {0, ms
// left} and spends nothing; otherwise it spends the attempt, sets when the
// next one may come (never earlier than already set), and returns {1, that
// delay in ms}.
const BACKOFF_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local nextAt = tonumber(redis.call('HGET', KEYS[1], 'next') or '0')
if now < nextAt and ARGV[5] ~= '1' then
  return {0, nextAt - now}
end
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
local free = tonumber(ARGV[1])
local delay = 0
if failures >= free then
  delay = math.floor(math.min(tonumber(ARGV[3]),
    tonumber(ARGV[2]) * 2 ^ (failures - free)))
end
redis.call('HSET', KEYS[1], 'next', math.max(nextAt, now + delay))
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {1, delay}
`;

// KEYS[1]: the counter. Returns the ms left of the current delay, or 0.
const BACKOFF_PEEK_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local nextAt = tonumber(redis.call('HGET', KEYS[1], 'next') or '0')
return math.max(0, nextAt - now)
`;

export interface BackoffLimiter extends FailureLimiter {
  /** Whether an attempt now would be refused, without spending one. */
  isDelayed: (req: Request, subject?: string) => Promise<boolean>;
  /**
   * Spends an attempt even during a delay, so it still lengthens the next
   * one: for a caller that has its own reason to let this attempt through.
   */
  spendUnblocked: (req: Request, subject?: string) => Promise<void>;
}

/**
 * Exponential backoff on a credential, e.g. per account. Not a lockout: past
 * `freeAttempts`, each failure only delays the next attempt, doubling up to
 * `maxDelaySeconds`. Like `createFailureLimiter`, `check` spends the attempt
 * atomically before the credential is verified, and a success calls `reset`;
 * an attempt during a delay gets 429 and spends nothing.
 */
export function createBackoffLimiter(
  config: BackoffLimiterConfig
): BackoffLimiter {
  const {
    keyPrefix,
    freeAttempts,
    baseDelaySeconds,
    maxDelaySeconds,
    ttlSeconds,
    errorDescription = "Too many failed attempts. Please try again later.",
    getKey,
  } = config;
  const keyOf = (req: Request, subject?: string) =>
    redisKey(`${keyPrefix}:${getKey(req, subject)}`);

  const run = async <T>(
    fn: (redis: ReturnType<typeof getRedisClient>) => Promise<T>
  ): Promise<T> => {
    try {
      const redis = getRedisClient();
      if (!isRedisReady(redis)) {
        throw new Error("Redis connection is not ready");
      }
      return await fn(redis);
    } catch (error) {
      throw failClosed(keyPrefix, error);
    }
  };
  const spend = (req: Request, subject: string | undefined, force: boolean) =>
    run(
      async (redis) =>
        (await redis.eval(
          BACKOFF_SCRIPT,
          1,
          keyOf(req, subject),
          freeAttempts,
          baseDelaySeconds * 1000,
          maxDelaySeconds * 1000,
          ttlSeconds,
          force ? 1 : 0
        )) as [number, number]
    );

  return {
    async reset(req, subject) {
      await getRedisClient().del(keyOf(req, subject));
    },
    async check(req, subject) {
      const [allowed, ms] = await spend(req, subject, false);
      if (allowed === 1) return;
      throw tooManyFailures(
        req,
        Math.max(1, Math.ceil(ms / 1000)),
        errorDescription,
        { keyPrefix }
      );
    },
    async isDelayed(req, subject) {
      const ms = await run(
        async (redis) =>
          (await redis.eval(
            BACKOFF_PEEK_SCRIPT,
            1,
            keyOf(req, subject)
          )) as number
      );
      return ms > 0;
    },
    async spendUnblocked(req, subject) {
      await spend(req, subject, true);
    },
  };
}

export interface WindowedBackoffConfig {
  keyPrefix: string;
  /** Attempts in the window allowed back to back before the first delay. */
  freeAttempts: number;
  /** The first delay; each further attempt in the window doubles it. */
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  /** How long an attempt counts. */
  windowSeconds: number;
  errorDescription?: string;
  getKey: (req: Request, subject?: string) => string;
}

export interface BackoffAttempt {
  /** Attempts the window holds, this one included. */
  attempts: number;
  /** Takes this attempt back out of the window, for one that succeeded. */
  refund: () => Promise<void>;
}

export interface WindowedBackoffLimiter {
  /**
   * Spends an attempt before the credential is checked, atomically; during
   * a delay, 429 and nothing spent.
   */
  check: (req: Request, subject?: string) => Promise<BackoffAttempt>;
  /** Whether an attempt now would be refused, without spending one. */
  isDelayed: (req: Request, subject?: string) => Promise<boolean>;
  /** Spends an attempt even during a delay, so it still lengthens the next. */
  spendUnblocked: (req: Request, subject?: string) => Promise<BackoffAttempt>;
}

// KEYS[1]: a sorted set of attempts scored by time. ARGV: freeAttempts,
// baseDelayMs, maxDelayMs, windowMs, mode ('check', 'force' or 'peek'),
// member. Returns {spent, ms to wait, attempts in the window after}.
const WINDOWED_BACKOFF_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
local free = tonumber(ARGV[1])
local wait = 0
if count >= free then
  local last = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
  local delay = math.min(tonumber(ARGV[3]),
    tonumber(ARGV[2]) * 2 ^ (count - free))
  wait = math.max(0, math.floor(tonumber(last[2]) + delay - now))
end
if ARGV[5] == 'peek' or (wait > 0 and ARGV[5] ~= 'force') then
  return {0, wait, count}
end
redis.call('ZADD', KEYS[1], now, ARGV[6])
redis.call('PEXPIRE', KEYS[1], window)
return {1, 0, count + 1}
`;

/**
 * Exponential backoff over a sliding window, e.g. per account. Unlike
 * `createBackoffLimiter`, nothing resets it: each attempt counts until it
 * leaves the window, and a success only takes its own attempt back
 * (`refund`), so the owner's logins hand no one else fresh attempts. Past
 * `freeAttempts` in the window, the next attempt waits a delay after the
 * last one that doubles with each, up to `maxDelaySeconds`. Fails closed
 * without Redis.
 */
export function createWindowedBackoffLimiter(
  config: WindowedBackoffConfig
): WindowedBackoffLimiter {
  const {
    keyPrefix,
    freeAttempts,
    baseDelaySeconds,
    maxDelaySeconds,
    windowSeconds,
    errorDescription = "Too many failed attempts. Please try again later.",
    getKey,
  } = config;
  const keyOf = (req: Request, subject?: string) =>
    redisKey(`${keyPrefix}:${getKey(req, subject)}`);

  const run = async (
    key: string,
    mode: "check" | "force" | "peek",
    member = ""
  ): Promise<[number, number, number]> => {
    try {
      const redis = getRedisClient();
      if (!isRedisReady(redis)) {
        throw new Error("Redis connection is not ready");
      }
      return (await redis.eval(
        WINDOWED_BACKOFF_SCRIPT,
        1,
        key,
        freeAttempts,
        baseDelaySeconds * 1000,
        maxDelaySeconds * 1000,
        windowSeconds * 1000,
        mode,
        member
      )) as [number, number, number];
    } catch (error) {
      throw failClosed(keyPrefix, error);
    }
  };

  const spend = async (
    req: Request,
    subject: string | undefined,
    mode: "check" | "force"
  ): Promise<BackoffAttempt> => {
    const key = keyOf(req, subject);
    const member = randomUUID();
    const [spent, ms, attempts] = await run(key, mode, member);
    if (spent !== 1) {
      throw tooManyFailures(
        req,
        Math.max(1, Math.ceil(ms / 1000)),
        errorDescription,
        { keyPrefix }
      );
    }
    return {
      attempts,
      // A refund lost to Redis costs the user one attempt, not the login.
      refund: async () => {
        try {
          await getRedisClient().zrem(key, member);
        } catch (err) {
          logger.warn({ keyPrefix, err }, "Could not refund a backoff attempt");
        }
      },
    };
  };

  return {
    check: (req, subject) => spend(req, subject, "check"),
    spendUnblocked: (req, subject) => spend(req, subject, "force"),
    async isDelayed(req, subject) {
      const [, ms] = await run(keyOf(req, subject), "peek");
      return ms > 0;
    },
  };
}

/** A key part that doesn't put the identifier itself (e.g. an email) in Redis. */
export const hashKeyPart = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** The eight 16-bit groups of an IPv6 address, or null if it isn't one. */
const ipv6Groups = (ip: string): number[] | null => {
  let address = ip.split("%")[0];
  if (!isIPv6(address)) return null;
  const embedded = address.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (embedded) {
    const [a, b, c, d] = embedded.slice(2).map(Number);
    address = `${embedded[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = address.split("::");
  const parse = (part: string | undefined) =>
    part ? part.split(":").map((g) => parseInt(g, 16)) : [];
  const left = parse(head);
  const right = parse(tail);
  const zeros =
    tail === undefined ? [] : Array(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
};

/**
 * The address a limiter counts by: IPv4 as is, IPv4-mapped IPv6 as the IPv4
 * address, and any other IPv6 address as its /64 — a single host is commonly
 * given a whole /64, so per address it could rotate through 2^64 keys.
 */
export const ipRateLimitKey = (ip: string): string => {
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
};

export const getIpIdentifier = (req: Request): string => {
  // Use Express's `req.ip`, which honors the app's `trust proxy` setting and
  // strips untrusted hops. The previous implementation read the leftmost
  // `X-Forwarded-For` value directly — fully client-controlled — so an attacker
  // could rotate it per request to dodge the IP-keyed failure limiters. Each
  // service must set `app.set("trust proxy", …)` to its real proxy depth for
  // `req.ip` to resolve the true client; where it isn't set, `req.ip` falls
  // back to the proxy/socket address (over-throttles, never bypasses) rather
  // than trusting a spoofable header.
  return ipRateLimitKey(req.ip || req.socket.remoteAddress || "unknown");
};

const setRateLimitHeaders = (
  res: Response,
  limiterRes: RateLimiterRes,
  points: number
): void => {
  res.setHeader("X-RateLimit-Limit", points);
  res.setHeader(
    "X-RateLimit-Remaining",
    Math.max(0, points - limiterRes.consumedPoints)
  );
  res.setHeader(
    "X-RateLimit-Reset",
    new Date(Date.now() + limiterRes.msBeforeNext).toISOString()
  );
};
