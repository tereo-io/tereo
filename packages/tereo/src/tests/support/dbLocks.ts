import { prisma } from "../../utils/db/prisma.js";

/** How many sessions are blocked on a lock right now. Take it before sending the requests. */
export async function lockWaiters(): Promise<number> {
  const [row] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return row.n;
}

/**
 * Resolves once `queued` more sessions are blocked on a lock than `baseline`,
 * or after `ms` when a request waits on something else or fewer requests queue
 * than expected, so it is never slower than a fixed wait of `ms`.
 */
export async function untilQueued(
  baseline: number,
  queued: number,
  ms = 1000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await lockWaiters()) >= baseline + queued) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const waitForLockWait = async (like: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${like}`;
    if (Number(rows[0].n) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No backend waited on a lock for ${like}`);
};
