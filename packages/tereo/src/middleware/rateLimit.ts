import { normalizeEmail } from "../utils/email.js";
import {
  createPreAuthRateLimitMiddleware,
  createRateLimitMiddleware,
  createBackoffLimiter,
  createFailureLimiter,
  getIpIdentifier,
  hashKeyPart,
} from "../utils/rateLimit.js";

// Tests run every limiter here at its production limits: the suite clears
// limiter keys between tests, and a test that needs several client addresses
// sends X-Forwarded-For, which the default TRUST_PROXY (loopback) honours.

export const rateLimitGeneral = createRateLimitMiddleware("tereo");

// Mounted before requireAuth, so floods of missing or bad tokens are bounded.
export const rateLimitPreAuth = createPreAuthRateLimitMiddleware("tereo");

// Failed logins per client and IP, the client being the one the request was
// validated against (pass its client_id as the subject), never a header the
// route does not authenticate with: a key the caller can vary per request is
// no limit. Without a client, per IP. The key spans every account tried from
// there, so a success refunds its own attempt and never resets the count:
// otherwise logging into one's own account would clear the failures against
// everyone else's.
export const authFailure = createFailureLimiter({
  keyPrefix: "rl:auth:fail",
  points: 5,
  duration: 300,
  errorDescription:
    "Too many failed authentication attempts. Please try again later.",
  getKey: (req, clientId) => {
    const ip = getIpIdentifier(req);
    return clientId ? `${clientId}:${ip}` : `ip:${ip}`;
  },
  logExtra: (_req, clientId) => ({ clientId }),
});

// Wrong login passwords per account, alongside authFailure's per client and
// IP, so guesses spread over many addresses are still slowed. Keyed on the
// email as submitted (normalised), not the user, so an unknown email behaves
// exactly like a real one. Backoff, not lockout: five attempts, then a delay
// before each next one that doubles from 1 second up to 15 minutes.
export const loginAccountBackoff = createBackoffLimiter({
  keyPrefix: "rl:login:account",
  freeAttempts: 5,
  baseDelaySeconds: 1,
  maxDelaySeconds: 900,
  ttlSeconds: 86_400,
  errorDescription:
    "Too many failed authentication attempts. Please try again later.",
  getKey: (_req, email) => hashKeyPart(normalizeEmail(email ?? "")),
});

// Unlock attempts per password share, alongside the per-(token, IP) window in
// utils/shareUnlockLimiter.ts, so guesses spread over many addresses are
// still slowed. Ten attempts, then a delay before each next one that doubles
// from 1 second up to 15 minutes; a correct password resets it. Keyed on the
// token's hash: the token is a credential.
export const shareUnlockBackoff = createBackoffLimiter({
  keyPrefix: "rl:share-unlock:token",
  freeAttempts: 10,
  baseDelaySeconds: 1,
  maxDelaySeconds: 900,
  ttlSeconds: 86_400,
  errorDescription:
    "Too many unlock attempts. Try again after the cooldown period.",
  getKey: (_req, token) => hashKeyPart(token ?? ""),
});

// Wrong passwords from a known-device browser, per cookie: such a login is
// let through the account's backoff, so a stolen cookie must not become an
// unlimited guess. The failures still count toward the account's backoff.
export const knownDeviceFailure = createFailureLimiter({
  keyPrefix: "rl:login:device",
  points: 5,
  duration: 900,
  errorDescription:
    "Too many failed authentication attempts. Please try again later.",
  getKey: (_req, token) => hashKeyPart(token ?? ""),
});

// Wrong TOTP and recovery codes at login, per user (the 2FA session's). A
// session or IP key would let anyone holding the password start a new login,
// or move to another address, for five more guesses each time.
export const totpFailure = createFailureLimiter({
  keyPrefix: "rl:totp:fail",
  points: 5,
  duration: 300,
  errorDescription: "Too many failed 2FA attempts. Please try again later.",
  getKey: (req, userId) =>
    userId ? `user:${userId}` : `ip:${getIpIdentifier(req)}`,
});

// Wrong TOTP codes on /account/totp, per user. These routes take a bearer
// token rather than a 2FA session, so a stolen access token alone must not be
// enough to brute-force the code that disables 2FA.
export const accountTotpFailure = createFailureLimiter({
  keyPrefix: "rl:totp:account:fail",
  points: 5,
  duration: 300,
  errorDescription: "Too many failed 2FA attempts. Please try again later.",
  getKey: (req) => `user:${req.auth?.userId ?? getIpIdentifier(req)}`,
  logExtra: (req) => ({ userId: req.auth?.userId }),
});

// Wrong current passwords on POST /account/password, per user: as for
// accountTotpFailure, a stolen access token must not be a password oracle.
export const accountPasswordFailure = createFailureLimiter({
  keyPrefix: "rl:password:account:fail",
  points: 5,
  duration: 300,
  errorDescription:
    "Too many failed password attempts. Please try again later.",
  getKey: (req) => `user:${req.auth?.userId ?? getIpIdentifier(req)}`,
  logExtra: (req) => ({ userId: req.auth?.userId }),
});

// Wrong setup tokens, per IP. A token has 60 bits, so this is defence in
// depth; it also keeps the log quiet if something is probing /setup.
export const setupFailure = createFailureLimiter({
  keyPrefix: "rl:setup:fail",
  points: 10,
  duration: 900,
  errorDescription: "Too many failed setup attempts. Please try again later.",
  getKey: (req) => `ip:${getIpIdentifier(req)}`,
});
