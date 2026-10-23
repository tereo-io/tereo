import { createHash, createHmac, randomBytes } from "crypto";

// PKCE helpers
export function generateCodeVerifier(): string {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// RFC 6238 code for the current 30s step, computed independently of
// utils/totp.ts so the tests check the server against the spec. A code is
// accepted once, so a second use for the same user within a step takes
// `stepOffset` 1: the next step's code, still inside the server's window.
export function generateTotpCode(secret: string, stepOffset = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of secret.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(
    BigInt(Math.floor(Date.now() / 1000 / 30) + stepOffset)
  );
  const hash = createHmac("sha1", Buffer.from(bytes))
    .update(timeBuffer)
    .digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

export function generateUniqueId(): string {
  return randomBytes(8).toString("hex");
}
