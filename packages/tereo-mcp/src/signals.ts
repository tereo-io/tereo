export const anySignal = (
  ...signals: (AbortSignal | undefined)[]
): AbortSignal =>
  AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));

// Settles with the work, or rejects with the signal's reason once it aborts.
// Work is not started under an aborted signal, and work that loses the race
// stays observed, so its later rejection is never an unhandled one.
export const untilAborted = <T>(
  work: () => T | Promise<T>,
  signal: AbortSignal
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
