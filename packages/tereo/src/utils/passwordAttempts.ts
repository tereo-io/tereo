import { getRedisClient, redisKey } from "./redis.js";
import { logPasswordFailure } from "./audit.js";
import { logAuditTx } from "./outbox.js";
import type { Request } from "express";
import db from "./db/index.js";

// From this many wrong passwords in a row, each one is audited.
const AUDIT_AFTER_FAILURES = 5;
// A run of failures with no further attempt for this long starts over.
const FAILURES_TTL_SECONDS = 86_400;

export type PasswordCheck = "login" | "password_change";

export type PasswordFailureReason =
  "unknown_user" | "login_not_allowed" | "no_password" | "invalid_password";

interface AttemptUser {
  id: string;
  email: string;
}

export interface PasswordAttempt {
  succeeded: () => Promise<void>;
  failed: (reason: PasswordFailureReason) => Promise<void>;
}

const failuresKey = (userId: string) => redisKey("password:failures", userId);

/**
 * Records the outcome of a password check for `user`, null when no account
 * has the email. Every failure is logged; a known user's failures in a row
 * are counted across login and password change, and from the
 * AUDIT_AFTER_FAILURES-th on each is audited. Nothing the user typed is
 * logged.
 */
export const beginPasswordAttempt = (
  req: Request,
  user: AttemptUser | null,
  check: PasswordCheck,
  clientId?: string
): PasswordAttempt => ({
  async succeeded() {
    if (user) await getRedisClient().del(failuresKey(user.id));
  },
  async failed(reason) {
    if (!user) {
      logPasswordFailure({ check, reason, clientId, ip: req.ip });
      return;
    }
    const key = failuresKey(user.id);
    // One transaction, so a count is never left without its expiry.
    const exec = await getRedisClient()
      .multi()
      .incr(key)
      .expire(key, FAILURES_TTL_SECONDS)
      .exec();
    const [err, count] = exec?.[0] ?? [new Error("Redis transaction aborted")];
    if (err) throw err;
    const failures = Number(count);
    logPasswordFailure({
      check,
      reason,
      userId: user.id,
      clientId,
      ip: req.ip,
      consecutiveFailures: failures,
    });
    if (failures < AUDIT_AFTER_FAILURES) return;
    await db.$transaction((tx) =>
      logAuditTx(tx, {
        auth: { userId: user.id, email: user.email },
        action: "UPDATE",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: {
          action: "password_failures",
          check,
          reason,
          consecutiveFailures: failures,
        },
      })
    );
  },
});
