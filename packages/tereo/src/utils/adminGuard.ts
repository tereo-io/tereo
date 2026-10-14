import type { Prisma } from "./db/prisma.js";
import { ConflictError } from "./errors.js";
import db from "./db/index.js";

type Assignment = { userId: string; roleId: string };

/**
 * Refuses a change that would leave no active human holding `admin`. Setup
 * runs only once, so with no admin left nobody could manage core again.
 * `remaining` keeps the admin assignments that survive the change. When no
 * admin exists to begin with, there is nothing to protect.
 *
 * Call it in the transaction that makes the change. It takes a lock held to
 * commit, so two changes each removing a different admin run one after the
 * other and the second sees the first; otherwise both would pass.
 */
export const assertAdminRemains = async (
  remaining: (assignment: Assignment) => boolean,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:admin-remains', 0))`;
  const before = await db.roles.getAdminAssignments(tx);
  if (before.length > 0 && !before.some(remaining)) {
    throw new ConflictError(
      "This change would leave no active administrator; grant admin to another user first"
    );
  }
};
