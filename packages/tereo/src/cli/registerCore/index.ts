import { prepareAndRegisterCore } from "../../utils/coreRegistration.js";
import { CORE_VERSION } from "../../utils/version.js";
import { loadKeys } from "../../utils/keys.js";

const USAGE = "Usage: register-core [--accept-older]";

/**
 * `register-core [--accept-older]`: registers this release's own declaration,
 * as a start does, and prints the result as JSON. A start ignores a
 * declaration older than the one recorded, so after a rollback of core what
 * the newer release dropped stays missing and retires under the older code.
 * `--accept-older` applies this release's declaration anyway: what it
 * declares is no longer missing or retired, and what only the newer release
 * declared starts its grace. Run it from the release rolled back to, once no
 * process of the newer one is left to register again.
 */
export async function runRegisterCoreCli(args: string[]): Promise<void> {
  let acceptOlder = false;
  for (const arg of args) {
    if (arg === "--accept-older") acceptOlder = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      console.error(USAGE);
      process.exit(1);
    }
  }

  await loadKeys();
  const result = await prepareAndRegisterCore({ acceptOlder });
  if (!result.applied) {
    console.error(
      `Not applied: a declaration newer than this release's (${CORE_VERSION}) is recorded. ` +
        "If core was rolled back on purpose, run again with --accept-older."
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({ ...result, version: CORE_VERSION, acceptOlder }, null, 2)
  );
}
