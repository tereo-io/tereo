import { randomBytes, timingSafeEqual, createHash, createHmac } from "crypto";
import { hashPassword, verifyPassword } from "./password.js";
import { newClientSecretValue } from "./secretRules.js";
import { authCodeHmacKey } from "./keys.js";

export interface GeneratedClientSecret {
  plainSecret: string;
  hashedSecret: string;
}

export interface GeneratedAuthorizationCode {
  code: string;
  codeHash: string;
}

// Passwords share one scrypt implementation with share passwords and recovery
// codes (utils/password.ts).
export { hashPassword, verifyPassword };

export const generateRandomString = (length: number): string => {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
};

export const generateClientId = (): string => {
  return generateRandomString(32);
};

export const generateClientSecret = (): GeneratedClientSecret => {
  const plainSecret = newClientSecretValue();
  return { plainSecret, hashedSecret: hashFlowToken(plainSecret) };
};

export const generateAuthorizationCode = (
  clientId: string
): GeneratedAuthorizationCode => {
  const randomPart = generateRandomString(32);
  const dataToSign = `${randomPart}:${clientId}`;

  const signature = createHmac("sha256", authCodeHmacKey())
    .update(dataToSign)
    .digest("base64url");

  const code = `${randomPart}.${signature}`;
  return { code, codeHash: hashAuthorizationCode(code) };
};

export const verifyAuthorizationCodeBinding = (
  code: string,
  clientId: string
): boolean => {
  const parts = code.split(".");
  if (parts.length !== 2) return false;

  const [randomPart, providedSignature] = parts;
  if (!randomPart || !providedSignature) return false;

  const dataToSign = `${randomPart}:${clientId}`;

  const expectedSignature = createHmac("sha256", authCodeHmacKey())
    .update(dataToSign)
    .digest("base64url");

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (providedBuffer.length !== expectedBuffer.length) {
    const paddedProvided = Buffer.alloc(expectedBuffer.length);
    providedBuffer.copy(
      paddedProvided,
      0,
      0,
      Math.min(providedBuffer.length, expectedBuffer.length)
    );
    timingSafeEqual(paddedProvided, expectedBuffer);
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

/** The lookup key of a stored code: the code itself is never stored. */
export const hashAuthorizationCode = (code: string): string => {
  return createHmac("sha256", authCodeHmacKey()).update(code).digest("hex");
};

// For high-entropy random tokens (client secrets, refresh tokens, TOTP setup
// grants, consent, org-select and 2FA sessions): with 256 bits there is
// nothing for a slow hash to protect, so a plain SHA-256 makes a leaked row
// useless, stays a direct lookup key, and gives an unauthenticated caller no
// expensive hash to make core compute.
export const hashFlowToken = (token: string): string => {
  return createHash("sha256").update(token).digest("hex");
};

export const generateRefreshToken = (): string => {
  return generateRandomString(64);
};

/**
 * Check a confidential client's secret. After a regenerate, the replaced
 * secret keeps working until `previousSecretExpiresAt`, so running copies of
 * a service survive the rollout of the new one.
 */
export const verifyClientSecret = (
  client: {
    clientSecret: string | null;
    previousSecretHash: string | null;
    previousSecretExpiresAt: Date | null;
  },
  secret: string
): boolean => {
  const presented = createHash("sha256").update(secret).digest();
  if (client.clientSecret && hashMatches(client.clientSecret, presented))
    return true;
  if (
    client.previousSecretHash &&
    client.previousSecretExpiresAt &&
    client.previousSecretExpiresAt > new Date()
  ) {
    return hashMatches(client.previousSecretHash, presented);
  }
  return false;
};

const hashMatches = (storedHex: string, presented: Buffer): boolean => {
  const stored = Buffer.from(storedHex, "hex");
  return (
    stored.length === presented.length && timingSafeEqual(stored, presented)
  );
};
