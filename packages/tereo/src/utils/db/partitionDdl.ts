import { pgErrorCodes } from "../prismaErrors.js";
import { prisma } from "./prisma.js";
import env from "../../env.js";

// Creating, detaching or dropping a partition takes ACCESS EXCLUSIVE on its
// parent. Left to wait behind a long read, it would queue every insert into the
// parent behind itself; past PARTITION_DDL_LOCK_TIMEOUT_MS it gives up
// instead, and the next run retries.

// A lock not granted in time, and a deadlock: dropping a notifications or
// deliveries partition also locks the table on the other side of their
// foreign key, which a concurrent write can hold while it waits for the
// parent. Postgres has rolled the transaction back either way.
const RETRY_LATER = ["55P03", "40P01"];

/**
 * Runs `statements` in one transaction under a lock timeout. False, with
 * nothing changed, when a lock was not granted in time or the transaction
 * deadlocked.
 */
export const runPartitionDdl = async (
  statements: string[]
): Promise<boolean> => {
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL lock_timeout = ${env.PARTITION_DDL_LOCK_TIMEOUT_MS}`
        );
        for (const sql of statements) await tx.$executeRawUnsafe(sql);
      },
      { timeout: 60_000 }
    );
    return true;
  } catch (err) {
    if (pgErrorCodes(err).some((code) => RETRY_LATER.includes(code))) {
      return false;
    }
    throw err;
  }
};
