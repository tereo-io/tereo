import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();

const notify = (key: string): void => {
  listeners.get(key)?.forEach((fn) => fn());
};

const readRaw = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const readJson = <T>(key: string): T | null => {
  const raw = readRaw(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const writeJson = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the session lives only until the page closes.
  }
  notify(key);
};

export const removeKey = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // See writeJson.
  }
  notify(key);
};

// `storage` events fire only in other tabs, so same-tab writes notify directly.
export const subscribeKey = (key: string, fn: () => void): (() => void) => {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);

  const onStorage = (e: StorageEvent) => {
    if (e.key === key || e.key === null) fn();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    set.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
};

// useSyncExternalStore compares snapshots by identity, so the raw string is the
// snapshot and the parse happens after it.
export const useStoredValue = <T>(key: string): T | null => {
  const subscribe = useCallback(
    (fn: () => void) => subscribeKey(key, fn),
    [key]
  );
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null
  );
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};
