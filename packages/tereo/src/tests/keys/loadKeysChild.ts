// Run by keys.test.ts in a separate process: load keys as a fresh core
// process would and print a fingerprint of each, so the test can compare
// processes without handling key material.
import "../../preload.js";
import { resealRowSecrets } from "../../utils/resealRowSecrets.js";
import { currentSigningKey, loadKeys } from "../../utils/keys.js";
import { disconnectDatabase } from "../../utils/db/prisma.js";
import { getMasterKey } from "../../utils/masterKeys.js";
import { createHash } from "crypto";
import env from "../../env.js";

const fingerprint = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

await loadKeys();
const jwtKey = currentSigningKey();
// As core's start does once its keys are loaded.
if (process.env.RESEAL_ROW_SECRETS) await resealRowSecrets();
process.stdout.write(
  JSON.stringify({
    JWT_PRIVATE_KEY: fingerprint(jwtKey.privateKey),
    JWT_PUBLIC_KEY: fingerprint(jwtKey.publicKey),
    JWT_KEY_ID: jwtKey.kid,
    TOTP_ENCRYPTION_KEY: fingerprint(env.TOTP_ENCRYPTION_KEY),
    KNOWN_DEVICE_KEY: fingerprint(env.KNOWN_DEVICE_KEY),
    CURSOR_SIGNING_KEY_V1: fingerprint(env.CURSOR_SIGNING_KEY_V1 ?? ""),
    FILE_SERVICE_SIGNING_KEY_V1: fingerprint(
      env.FILE_SERVICE_SIGNING_KEY_V1 ?? ""
    ),
    FILE_SERVICE_MASTER_KEY_V1: fingerprint(getMasterKey(1)),
    AUTH_CODE_HMAC_KEY: fingerprint(env.AUTH_CODE_HMAC_KEY ?? ""),
  })
);
await disconnectDatabase();
