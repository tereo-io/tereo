import { randomBytes, scrypt, timingSafeEqual } from "crypto";

// The one scrypt password hash, for low-entropy secrets: user passwords,
// recovery codes and share passwords. Format `${saltHex}:${keyHex}`.
// High-entropy random tokens use hashFlowToken (utils/crypto.ts) instead.

const SALT_LENGTH = 32;
const KEY_LENGTH = 64;

const scryptAsync = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: 16384, r: 8, p: 1 },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      }
    );
  });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await scryptAsync(password, salt);
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
};

export const verifyPassword = async (
  hash: string,
  password: string
): Promise<boolean> => {
  const [saltHex, keyHex] = hash.split(":");
  if (!saltHex || !keyHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const storedKey = Buffer.from(keyHex, "hex");
  const derivedKey = await scryptAsync(password, salt);
  if (derivedKey.length !== storedKey.length) return false;
  return timingSafeEqual(storedKey, derivedKey);
};
