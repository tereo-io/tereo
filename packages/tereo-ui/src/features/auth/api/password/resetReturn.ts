const KEY = "tereo.resetReturnTo";

// A reset link lives this long by default; an older entry belongs to a
// reset abandoned long ago.
const MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remembers the login page's query so a finished reset can send the user back
 * to it. In localStorage, not sessionStorage: the emailed link is often opened
 * in another tab.
 */
export const rememberResetReturn = (search: string): void => {
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ search, savedAt: Date.now() })
    );
  } catch {
    // Storage can be blocked; the reset then ends at `/`.
  }
};

export const clearResetReturn = (): void => {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // See rememberResetReturn.
  }
};

export const readResetReturn = (): string | null => {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const entry = JSON.parse(raw) as { search?: unknown; savedAt?: unknown };
    const { search, savedAt } = entry ?? {};
    if (
      typeof savedAt !== "number" ||
      Date.now() - savedAt > MAX_AGE_MS ||
      typeof search !== "string"
    ) {
      clearResetReturn();
      return null;
    }
    // Only a query string is ever appended to /login.
    return search === "" || search.startsWith("?") ? search : null;
  } catch {
    // Blocked storage, or an entry that is not ours.
    clearResetReturn();
    return null;
  }
};
