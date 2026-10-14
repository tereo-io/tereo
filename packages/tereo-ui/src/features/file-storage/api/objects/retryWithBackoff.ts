import type { AxiosError } from "axios";

const DEFAULT_MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const isAxiosLike = (
  err: unknown
): err is AxiosError<{ error_description?: string }> => {
  if (!err || typeof err !== "object") return false;
  return (err as AxiosError).isAxiosError === true;
};

const isRateLimited = (err: unknown): boolean =>
  isAxiosLike(err) && err.response?.status === 429;

const isRetriable = (err: unknown): boolean => {
  // Network failures reach here as axios errors with no response; anything
  // else (a TypeError, say) is a bug that a retry would only repeat.
  if (!isAxiosLike(err)) return false;
  // No response (timeout, DNS, connection dropped) — retry.
  if (!err.response) return true;
  const { status } = err.response;
  // Rate limited or 5xx — retry. 4xx (other than 429) are terminal.
  return status === 429 || status >= 500;
};

/**
 * Parse the standard HTTP `Retry-After` header. Supports both the
 * delta-seconds form (an integer) and the HTTP-date form. Returns 0 when the
 * value is missing or unparseable — callers combine this with their own
 * backoff so the wait is never shorter than expected.
 */
const parseRetryAfter = (header: string | string[] | undefined): number => {
  if (!header) return 0;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);
  const ts = Date.parse(value);
  if (!Number.isNaN(ts)) return Math.max(0, ts - Date.now());
  return 0;
};

/**
 * Run `fn` with exponential backoff on transient failures (network errors,
 * 5xx) and explicit Retry-After honoring on 429s. Terminal 4xx errors throw
 * immediately so callers see idempotency / permission / validation failures
 * without waiting through the full retry budget.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = DEFAULT_MAX_RETRIES
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetriable(err) || attempt >= maxRetries) throw err;

      const retryAfterMs = isRateLimited(err)
        ? parseRetryAfter(
            (err as AxiosError).response?.headers?.["retry-after"] as
              string | string[] | undefined
          )
        : 0;
      // Exponential backoff with decorrelated jitter — baseline even when the
      // server didn't give a Retry-After so 5xx retries don't hammer either.
      const baseBackoff = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
      const jitter = Math.random() * 500;
      const delay = Math.max(retryAfterMs, baseBackoff) + jitter;
      await sleep(delay);
      attempt++;
    }
  }
}
