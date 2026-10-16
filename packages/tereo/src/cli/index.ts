import "../preload.js";
import { runGenerateSecretCli } from "./generateSecret/index.js";
import { runOutboxReplayCli } from "./outboxReplay/index.js";
import { disconnectDatabase } from "../utils/db/prisma.js";
import { runRewrapCli } from "./rewrapMasterKey/index.js";
import {
  runProvisionCli,
  runProvisioningSchemaCli,
} from "./provision/index.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.error("Usage: npm run cli -- <command> [options]");
    console.error("");
    console.error("Commands:");
    console.error(
      "  rewrap-master-key    Re-wrap every wrapped DEK under the active master key"
    );
    console.error(
      "  outbox-replay        Return dead-lettered outbox rows to the reaper"
    );
    console.error(
      "  generate-secret      Print a new client secret in the tereo_sk_ format"
    );
    console.error(
      "  provision            Apply the provisioning documents [--path <path>] [--dry-run]"
    );
    console.error(
      "  provisioning-schema  Print the JSON Schema provisioning documents validate against"
    );
    process.exit(command ? 0 : 1);
  }

  if (command === "rewrap-master-key") {
    await runRewrapCli(args.slice(1));
  } else if (command === "outbox-replay") {
    await runOutboxReplayCli(args.slice(1));
  } else if (command === "generate-secret") {
    runGenerateSecretCli();
  } else if (command === "provision") {
    await runProvisionCli(args.slice(1));
  } else if (command === "provisioning-schema") {
    runProvisioningSchemaCli();
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("CLI failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectDatabase();
  });
