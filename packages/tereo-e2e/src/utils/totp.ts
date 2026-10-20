import { createHmac } from "crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`Not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const totpStep = (at = Date.now()) =>
  Math.floor(at / 1000 / STEP_SECONDS);

/** RFC 6238 with an authenticator app's defaults: SHA-1, 6 digits, 30 s. */
export function totpCode(secret: string, step = totpStep()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secret))
    .update(counter)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Resolves once the time step has moved past `step`: core refuses a code it
 * has already accepted, so a second sign-in needs the next one.
 */
export async function nextTotpStep(step: number): Promise<number> {
  const wait = (step + 1) * STEP_SECONDS * 1000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 250));
  return totpStep();
}
