import { getKnownDeviceFromCookie, setKnownDeviceCookie } from "./cookies.js";
import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import env from "../env.js";

/**
 * The known-device cookie: proof that this browser has completed a login (2FA
 * included) as one user. A login from it is let through that account's login
 * backoff, so an attacker who keeps the account in backoff does not lock the
 * owner out too.
 *
 * `<userId>.<issued at, unix seconds>.<HMAC>`. The HMAC covers the user's
 * password hash as well, which is salted afresh on every password change or
 * admin reset, so every cookie issued before one stops matching.
 */

const KNOWN_DEVICE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
// Clock skew allowed on the issue time between core's processes.
const MAX_FUTURE_SKEW_SECONDS = 300;

const mac = (userId: string, issuedAt: number, passwordHash: string) =>
  createHmac("sha256", Buffer.from(env.KNOWN_DEVICE_KEY, "base64"))
    .update(`known-device\n${userId}\n${issuedAt}\n${passwordHash}`)
    .digest("base64url");

interface DeviceUser {
  id: string;
  passwordHash: string | null;
}

export const issueKnownDevice = (res: Response, user: DeviceUser) => {
  // The cookie is bound to the password hash; without one there is nothing to bind to.
  if (!user.passwordHash) return;
  const issuedAt = Math.floor(Date.now() / 1000);
  setKnownDeviceCookie(
    res,
    `${user.id}.${issuedAt}.${mac(user.id, issuedAt, user.passwordHash)}`,
    KNOWN_DEVICE_MAX_AGE_SECONDS
  );
};

/** The request's known-device cookie, if it is valid for `user`. */
export const knownDeviceFor = (
  req: Request,
  user: DeviceUser
): string | null => {
  if (!user.passwordHash) return null;
  const token = getKnownDeviceFromCookie(req);
  if (!token) return null;
  const [userId, issued, signature, ...rest] = token.split(".");
  if (rest.length > 0 || !signature || userId !== user.id) return null;
  if (!/^\d{1,12}$/.test(issued)) return null;

  const issuedAt = Number(issued);
  const age = Math.floor(Date.now() / 1000) - issuedAt;
  if (age > KNOWN_DEVICE_MAX_AGE_SECONDS || age < -MAX_FUTURE_SKEW_SECONDS) {
    return null;
  }

  const expected = Buffer.from(mac(userId, issuedAt, user.passwordHash));
  const provided = Buffer.from(signature);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  return token;
};
