import type { AdminRemoval } from "./db/roles.js";
import type { Prisma } from "./db/prisma.js";
import { ConflictError } from "./errors.js";
import db from "./db/index.js";

/**
 * Refuses a change that would leave no active human holding `admin`. Setup
 * runs only once, so with no admin left nobody could manage core again.
 * `removal` is what the change takes away; null when it takes no admin away
 * and only needs to queue behind the lock. When no admin exists to begin
 * with, there is nothing to protect.
 *
 * Call it in the transaction that makes the change. It takes a lock held to
 * commit, so two changes each removing a different admin run one after the
 * other and the second sees the first; otherwise both would pass.
 */
export const assertAdminRemains = async (
  removal: AdminRemoval | null,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:admin-remains', 0))`;
  if (removal === null || (await db.roles.adminExists(removal, tx))) return;
  if (await db.roles.adminExists(undefined, tx)) {
    throw new ConflictError(
      "This change would leave no active administrator; grant admin to another user first"
    );
  }
};
