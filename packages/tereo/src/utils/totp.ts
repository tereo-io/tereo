import { hashFlowToken, hashPassword, verifyPassword } from "./crypto.js";
import { getTotpPolicy } from "./db/settings.js";
import { OAuth2Error } from "./errors.js";
import env from "../env.js";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "crypto";

// TOTP Constants
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30; // seconds
const TOTP_ALGORITHM = "sha1";
const SECRET_LENGTH = 20; // 160 bits for SHA1

// Base32 alphabet (RFC 4648)
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Characters for recovery codes (excluding confusing chars like 0/O, 1/I/l)
const RECOVERY_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface TotpConfig {
  issuer: string;
  accountName: string;
  secret: string;
}

export interface GeneratedRecoveryCodes {
  plainCodes: string[];
  hashedCodes: string[];
}

const base32Encode = (buffer: Buffer): string => {
  let result = "";
  let bits = 0;
  let value = 0;

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      result += BASE32_CHARS[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }

  if (bits > 0) result += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  return result;
};

const base32Decode = (str: string): Buffer => {
  str = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of str) {
    const index = BASE32_CHARS.indexOf(char);
    if (index === -1) continue;

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

const timingSafeCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

export const generateTotpSecret = (): string => {
  const buffer = randomBytes(SECRET_LENGTH);
  return base32Encode(buffer);
};

export const generateTotpUri = (config: TotpConfig): string => {
  const { issuer, accountName, secret } = config;
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccount = encodeURIComponent(accountName);

  return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
};

const generateTotpCodeForTime = (secret: Buffer, timeStep: number): string => {
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(BigInt(timeStep));

  const hmac = createHmac(TOTP_ALGORITHM, secret);
  hmac.update(timeBuffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binary % Math.pow(10, TOTP_DIGITS);
  return otp.toString().padStart(TOTP_DIGITS, "0");
};

/**
 * The time step the code belongs to, or null when it matches none within the
 * window. The caller must still claim the step (`db.totp.claimTotpWindow`) so
 * a code is accepted only once.
 */
export const verifyTotpCode = (
  secret: string,
  code: string,
  windowSize: number = 1
): number | null => {
  if (!/^\d{6}$/.test(code)) return null;

  const secretBuffer = base32Decode(secret);
  const currentStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  for (let i = -windowSize; i <= windowSize; i++) {
    const timeStep = currentStep + i;
    const expectedCode = generateTotpCodeForTime(secretBuffer, timeStep);

    if (timingSafeCompare(code, expectedCode)) return timeStep;
  }
  return null;
};

const generateRecoveryCodeString = (): string => {
  const segments: string[] = [];

  for (let s = 0; s < 3; s++) {
    let segment = "";
    for (let c = 0; c < 4; c++) {
      const randomIndex = randomBytes(1)[0] % RECOVERY_CODE_CHARS.length;
      segment += RECOVERY_CODE_CHARS[randomIndex];
    }
    segments.push(segment);
  }

  return segments.join("-");
};

export const generateRecoveryCodes = async (
  count: number
): Promise<GeneratedRecoveryCodes> => {
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];

  for (let i = 0; i < count; i++) {
    const code = generateRecoveryCodeString();
    plainCodes.push(code);
    const normalizedCode = code.replace(/-/g, "");
    hashedCodes.push(await hashPassword(normalizedCode));
  }

  return { plainCodes, hashedCodes };
};

export const verifyRecoveryCode = async (
  code: string,
  hashedCode: string
): Promise<boolean> => {
  const normalizedCode = code.replace(/-/g, "").toUpperCase();
  return verifyPassword(hashedCode, normalizedCode);
};

export const encryptTotpSecret = (secret: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(env.TOTP_ENCRYPTION_KEY, "hex"),
    iv
  );

  let encrypted = cipher.update(secret, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
};

export const decryptTotpSecret = (encrypted: string): string => {
  const parts = encrypted.split(":");
  const [ivHex, authTagHex, cipherText] = parts;

  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(env.TOTP_ENCRYPTION_KEY, "hex"),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  let decrypted = decipher.update(cipherText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

export const generateTotpSessionToken = (): string => {
  return randomBytes(32).toString("hex");
};

export const generateTotpSetupToken = (): string => {
  return randomBytes(32).toString("hex");
};

export const generateTotpSetupGrant = (): string => {
  return randomBytes(32).toString("base64url");
};

export const hashTotpSetupGrant = hashFlowToken;

// Users who enabled TOTP before the policy became "disabled" keep it and still
// verify at login; only new enrolment is refused.
export const assertTotpSetupAllowed = async (): Promise<void> => {
  if ((await getTotpPolicy()) === "disabled") {
    throw new OAuth2Error(
      "totp_disabled",
      "Two-factor authentication is disabled by the system administrator.",
      403
    );
  }
};
