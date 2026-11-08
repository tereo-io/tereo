const KEY = "tereo.resetReturnTo";

/** Remembers the login page's query so a finished reset can send the user back to it. */
export const rememberResetReturn = (search: string): void => {
  try {
    window.sessionStorage.setItem(KEY, search);
  } catch {
    // Storage can be blocked; the reset then ends at `/`.
  }
};

export const readResetReturn = (): string | null => {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const clearResetReturn = (): void => {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // See rememberResetReturn.
  }
};
