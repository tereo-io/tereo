import "dotenv/config";

// Master-key registry. Env-supplied keys are loaded once at module init,
// validated, decoded to Buffers, then scrubbed from `process.env` so the
// plaintext base64 strings don't survive in the environment for the process
// lifetime — defence-in-depth against subprocess inheritance, accidental logs,
// and crash-dump exposure. `loadKeys()` (utils/keys.ts) adds stored and
// generated keys through `setMasterKey`.
//
// dotenv loads here because this module reads process.env at import time.

const ENV_PREFIX = "FILE_SERVICE_MASTER_KEY_V";
const KEY_BYTES = 32;

const masterKeys = new Map<number, Buffer>();

function loadMasterKeys(): void {
  for (const envName of Object.keys(process.env)) {
    if (!envName.startsWith(ENV_PREFIX)) continue;
    const versionStr = envName.slice(ENV_PREFIX.length);
    const version = Number(versionStr);
    if (!Number.isInteger(version) || version <= 0) continue;

    const raw = process.env[envName];
    // Don't trip on an env var that's defined-but-empty — treat it as unset
    // so the active-version check below produces the right error message.
    if (raw == null || raw === "") {
      delete process.env[envName];
      continue;
    }

    setMasterKey(version, raw, envName);
    delete process.env[envName];
  }
}

export function setMasterKey(
  version: number,
  base64: string,
  source = `${ENV_PREFIX}${version}`
): void {
  const decoded = Buffer.from(base64, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `${source} must decode to exactly ${KEY_BYTES} bytes of base64 (got ${decoded.length})`
    );
  }
  masterKeys.set(version, decoded);
}

loadMasterKeys();

export function getMasterKey(version: number): Buffer {
  const key = masterKeys.get(version);
  if (!key) {
    throw new Error(
      `Master key version ${version} is not configured (env ${ENV_PREFIX}${version})`
    );
  }
  return key;
}

export function hasMasterKey(version: number): boolean {
  return masterKeys.has(version);
}
