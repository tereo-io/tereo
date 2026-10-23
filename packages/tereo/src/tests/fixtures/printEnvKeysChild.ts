// Run by envSigningKeys.test.ts in a separate process: load keys as a fresh
// core process would and print a fingerprint of each env field named in
// PRINT_KEYS, so the test can compare without handling key material.
import "../../preload.js";
import { disconnectDatabase } from "../../utils/db/prisma.js";
import { loadKeys } from "../../utils/keys.js";
import { createHash } from "crypto";
import env from "../../env.js";

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

await loadKeys();
const fields = env as unknown as Record<string, unknown>;
const printed: Record<string, string | null> = {};
for (const name of (process.env.PRINT_KEYS ?? "").split(",")) {
  const value = fields[name];
  printed[name] = typeof value === "string" ? fingerprint(value) : null;
}
process.stdout.write(JSON.stringify(printed));
await disconnectDatabase();
