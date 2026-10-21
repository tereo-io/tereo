let counter = 0;

/**
 * A client address no other browser context in this run uses, sent as
 * X-Forwarded-For (core trusts it from loopback outside production).
 *
 * Core limits failed sign-ins per client and IP. Every context would
 * otherwise be 127.0.0.1, so a few specs that fail a login on purpose would
 * lock everyone else out for five minutes; distinct addresses make each
 * context the separate visitor it stands for.
 */
export function nextClientIp(): string {
  const worker = Number(process.env.TEST_WORKER_INDEX ?? 0) % 250;
  counter++;
  return `10.${worker}.${(counter >> 8) & 255}.${counter & 255}`;
}

export const clientIpHeaders = (ip = nextClientIp()) => ({
  "X-Forwarded-For": ip,
});
