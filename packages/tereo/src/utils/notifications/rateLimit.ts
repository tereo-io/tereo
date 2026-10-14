import { getRedisClient } from "../redis.js";

const WINDOW_MS = 60_000;

/**
 * Take one send from the connection's per-minute allowance (a fixed window).
 * Returns 0 when the send may go now, else the milliseconds until the next
 * window opens. `maxPerMinute` null: no limit.
 */
export async function takeSendToken(
  connectionId: string,
  maxPerMinute: number | null
): Promise<number> {
  if (maxPerMinute === null) return 0;
  const now = Date.now();
  const window = Math.floor(now / WINDOW_MS);
  const key = `notifications:rate:${connectionId}:${window}`;
  const result = await getRedisClient()
    .multi()
    .incr(key)
    .expire(key, 120)
    .exec();
  const [err, count] = result![0];
  if (err) throw err;
  return (count as number) <= maxPerMinute ? 0 : (window + 1) * WINDOW_MS - now;
}
