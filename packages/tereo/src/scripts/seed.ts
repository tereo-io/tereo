import "../preload.js";
import { disconnectDatabase } from "./seed/client.js";
import { ensurePartitions } from "./seed/core.js";
import type { SeedResult } from "./seed/types.js";
import {
  seedDefaultClient,
  seedDefaultOrganization,
  seedDefaultScopes,
  seedSystemUser,
} from "./seed/bootstrapEntities.js";

/**
 * Seeds a fresh database: auth's bootstrap entities (scopes, the system user,
 * the default login client, the default organization) and the first
 * partitions. Idempotent — safe to run on every deploy.
 *
 * Core's permissions, system roles, buckets and event types are not seeded:
 * core registers them itself on every start (utils/coreRegistration.ts). It
 * creates no person either: the first admin comes from setup (utils/setup.ts).
 *
 * Logs go to stderr; stdout carries one JSON summary.
 */
async function main() {
  console.error("Starting database seed...");
  await seedDefaultScopes();
  await seedSystemUser();
  await seedDefaultClient();
  const defaultOrg = await seedDefaultOrganization();
  await ensurePartitions();

  const result: SeedResult = { defaultOrganizationId: defaultOrg.id };
  console.error("Seed completed successfully");
  console.log(JSON.stringify(result));
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
