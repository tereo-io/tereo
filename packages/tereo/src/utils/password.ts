import { randomBytes, scrypt, timingSafeEqual } from "crypto";

// The one scrypt hash, for low-entropy secrets: user passwords, recovery
// codes and share passwords. Format `scrypt$N$r$p$saltHex$keyHex`; hashes
// from before it are `saltHex:keyHex` at LEGACY_PARAMS and still verify.
// High-entropy random tokens use hashFlowToken (utils/crypto.ts) instead.

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// OWASP's N=2^14, r=8, p=5: 16 MiB per hash, as before, at five times the CPU.
export const PASSWORD_PARAMS: ScryptParams = { N: 16384, r: 8, p: 5 };

// A recovery code is 60 random bits, so the password cost buys it nothing,
// while a login with one may check every code the user has left.
export const RECOVERY_CODE_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

const LEGACY_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

const SALT_LENGTH = 32;
const KEY_LENGTH = 64;

const scryptAsync = (
  password: string,
  salt: Buffer,
  { N, r, p }: ScryptParams
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N, r, p }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
  legacy: boolean;
}

const HEX = /^(?:[0-9a-f]{2})+$/;

// Bounds a stored hash must keep to, so a corrupt row is refused rather
// than run with any cost it names.
const isSaneParams = ({ N, r, p }: ScryptParams) =>
  Number.isInteger(N) &&
  N >= 2 &&
  N <= 2 ** 20 &&
  (N & (N - 1)) === 0 &&
  Number.isInteger(r) &&
  r >= 1 &&
  r <= 32 &&
  Number.isInteger(p) &&
  p >= 1 &&
  p <= 16;

const parseHash = (hash: string): ParsedHash | null => {
  const parts = hash.split("$");
  if (parts.length === 6 && parts[0] === "scrypt") {
    const [, n, r, p, saltHex, keyHex] = parts;
    const params = { N: Number(n), r: Number(r), p: Number(p) };
    if (!isSaneParams(params) || !HEX.test(saltHex) || !HEX.test(keyHex)) {
      return null;
    }
    return {
      params,
      salt: Buffer.from(saltHex, "hex"),
      key: Buffer.from(keyHex, "hex"),
      legacy: false,
    };
  }
  const [saltHex, keyHex, ...rest] = hash.split(":");
  if (rest.length > 0 || !saltHex || !keyHex) return null;
  if (!HEX.test(saltHex) || !HEX.test(keyHex)) return null;
  return {
    params: LEGACY_PARAMS,
    salt: Buffer.from(saltHex, "hex"),
    key: Buffer.from(keyHex, "hex"),
    legacy: true,
  };
};

const sameParams = (a: ScryptParams, b: ScryptParams) =>
  a.N === b.N && a.r === b.r && a.p === b.p;

export const hashPassword = async (
  password: string,
  params: ScryptParams = PASSWORD_PARAMS
): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await scryptAsync(password, salt, params);
  const { N, r, p } = params;
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
};

/**
 * Whether `password` matches `hash`. `expected` is the cost the caller hashes
 * at now: a stored hash at the same N and r but a lower p is topped up to it,
 * so an account still on an old hash answers as slowly as an unknown one.
 */
export const verifyPassword = async (
  hash: string,
  password: string,
  expected: ScryptParams = PASSWORD_PARAMS
): Promise<boolean> => {
  const parsed = parseHash(hash);
  if (!parsed) return false;

  const derivedKey = await scryptAsync(password, parsed.salt, parsed.params);
  const { N, r, p } = parsed.params;
  if (N === expected.N && r === expected.r && p < expected.p) {
    await scryptAsync(password, parsed.salt, { N, r, p: expected.p - p });
  }
  if (derivedKey.length !== parsed.key.length) return false;
  return timingSafeEqual(parsed.key, derivedKey);
};

/** Whether a hash that verified should be stored again at `params`. */
export const needsRehash = (
  hash: string,
  params: ScryptParams = PASSWORD_PARAMS
): boolean => {
  const parsed = parseHash(hash);
  return !parsed || parsed.legacy || !sameParams(parsed.params, params);
};
