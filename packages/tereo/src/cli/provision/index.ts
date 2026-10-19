import { ProvisioningDocumentSchema } from "../../utils/provisioning/schema.js";
import { prepareAndRegisterCore } from "../../utils/coreRegistration.js";
import { loadKeys } from "../../utils/keys.js";
import z from "zod";
import {
  ProvisioningError,
  provision,
} from "../../utils/provisioning/index.js";

/**
 * `provision [--path <path>] [--dry-run]`: applies the provisioning
 * documents (`PROVISIONING_PATH` unless `--path` is given) and prints what
 * changed as JSON. `--dry-run` validates and checks against the database,
 * then rolls back.
 */
export async function runProvisionCli(args: string[]): Promise<void> {
  let path: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--path" && args[i + 1]) path = args[++i];
    else {
      console.error(`Unknown argument: ${args[i]}`);
      console.error("Usage: provision [--path <path>] [--dry-run]");
      process.exit(1);
    }
  }

  await loadKeys();
  // As at start: documents may use what this release's core declares.
  await prepareAndRegisterCore();
  try {
    const result = await provision({ path, dryRun });
    console.log(
      JSON.stringify(
        result ?? { message: "No provisioning path set; nothing applied" },
        null,
        2
      )
    );
  } catch (err) {
    if (!(err instanceof ProvisioningError)) throw err;
    console.error("Invalid provisioning:");
    for (const problem of err.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

export const provisioningJsonSchema = () =>
  z.toJSONSchema(ProvisioningDocumentSchema, { io: "input" });

export function runProvisioningSchemaCli(): void {
  console.log(JSON.stringify(provisioningJsonSchema(), null, 2));
}
