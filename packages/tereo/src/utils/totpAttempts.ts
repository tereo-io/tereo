import { knownDeviceTotp, totpBackoff } from "../middleware/rateLimit.js";
import type { BackoffAttempt } from "./rateLimit.js";
import { knownDeviceFor } from "./knownDevice.js";
import { logAuditTx } from "./outbox.js";
import type { Request } from "express";
import { logger } from "./logger.js";
import db from "./db/index.js";

// Past this many attempts in totpBackoff's window, each failure is audited.
const AUDIT_AFTER_ATTEMPTS = 5;

export interface TotpAttempt {
  succeeded: () => Promise<void>;
  failed: () => Promise<void>;
}

interface AttemptUser {
  id: string;
  email: string;
  passwordHash: string | null;
}

/**
 * Spends one attempt at the login 2FA step for `user`, before the code is
 * checked; 429 while the user's backoff delays it. A browser that has
 * completed a login as the user before (the known-device cookie) is let
 * through the delay, capped per cookie, so an attacker holding the password
 * cannot hold the owner out of their own account.
 */
export const beginTotpAttempt = async (
  req: Request,
  user: AttemptUser,
  method: "totp" | "recovery"
): Promise<TotpAttempt> => {
  const device = knownDeviceFor(req, user);
  let attempt: BackoffAttempt;
  if (device && (await totpBackoff.isDelayed(req, user.id))) {
    await knownDeviceTotp.check(req, device);
    attempt = await totpBackoff.spendUnblocked(req, user.id);
  } else {
    attempt = await totpBackoff.check(req, user.id);
  }

  return {
    async succeeded() {
      await attempt.refund();
      if (device) await knownDeviceTotp.refund(req, device);
    },
    async failed() {
      logger.warn(
        { userId: user.id, ip: req.ip, method, attempts: attempt.attempts },
        "Login 2FA verification failed"
      );
      if (attempt.attempts < AUDIT_AFTER_ATTEMPTS) return;
      await db.$transaction((tx) =>
        logAuditTx(tx, {
          auth: { userId: user.id, email: user.email },
          action: "UPDATE",
          entityType: "User",
          entityId: user.id,
          entityName: user.email,
          metadata: {
            action: "totp_failures",
            method,
            recentFailures: attempt.attempts,
          },
        })
      );
    },
  };
};
