/**
 * A cross-tab lock over localStorage, for where `navigator.locks` is missing
 * (outside secure contexts: plain-http hosts). The key holds a lease — the
 * owner and when it lapses — renewed while the holder runs, so a tab that
 * closes mid-refresh blocks the others only until its lease lapses. Tabs
 * waiting on it wake on the `storage` event, or poll.
 *
 * localStorage has no compare-and-set: a tab writes its lease, waits a beat,
 * and holds the lock only if its write is still the one there (the last of
 * racing writers wins, and the others see it).
 */

interface Lease {
  owner: string;
  expiresAt: number;
}

const LEASE_MS = 15_000;
const RENEW_MS = 5_000;
const POLL_MS = 250;
const SETTLE_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readLease = (key: string): Lease | null => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const lease = JSON.parse(raw) as Partial<Lease>;
    return typeof lease.owner === "string" &&
      typeof lease.expiresAt === "number"
      ? (lease as Lease)
      : null;
  } catch {
    return null;
  }
};

/** False when localStorage is unusable (blocked, full, private mode). */
const writeLease = (key: string, owner: string): boolean => {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ owner, expiresAt: Date.now() + LEASE_MS })
    );
    return true;
  } catch {
    return false;
  }
};

const releaseLease = (key: string, owner: string) => {
  try {
    if (readLease(key)?.owner === owner) localStorage.removeItem(key);
  } catch {
    // Nothing to release into; the lease lapses on its own.
  }
};

/** Resolves when another tab changes the key, or after `ms`. */
const waitForChange = (key: string, ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
      resolve();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === key || e.key === null) done();
    };
    const timer = setTimeout(done, ms);
    window.addEventListener("storage", onStorage);
  });

const newOwnerId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Resolves once this tab holds the lease, or at once when localStorage is
 * unusable (then nothing can be shared, and the caller runs unlocked).
 */
const acquire = async (key: string, owner: string): Promise<void> => {
  for (;;) {
    const lease = readLease(key);
    if (!lease || lease.expiresAt <= Date.now()) {
      if (!writeLease(key, owner)) return;
      await sleep(SETTLE_MS);
      if (readLease(key)?.owner === owner) return;
      continue;
    }
    await waitForChange(key, Math.min(POLL_MS, lease.expiresAt - Date.now()));
  }
};

/** Runs `fn` while holding the lock named `key`, across this origin's tabs. */
export const withStorageLock = async <T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> => {
  const owner = newOwnerId();
  await acquire(key, owner);
  const renew = setInterval(() => {
    if (readLease(key)?.owner === owner) writeLease(key, owner);
  }, RENEW_MS);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    releaseLease(key, owner);
  }
};
