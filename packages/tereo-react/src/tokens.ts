import { readJson, removeKey, writeJson } from "./storage.js";
import { activeConfig } from "./config.js";

export interface StoredTokens {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
  expiresAt: number;
}

// Read from storage rather than hook state: mutation closures can hold a
// stale render's value.
export const readTokens = (): StoredTokens | null =>
  readJson<StoredTokens>(activeConfig().keys.tokens);

export const writeTokens = (t: StoredTokens | null): void => {
  const { tokens } = activeConfig().keys;
  if (t === null) removeKey(tokens);
  else writeJson(tokens, t);
};

/** Reads a JWT's claims without verifying it. */
export const decodeJwt = (token: string): Record<string, unknown> | null => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const binary = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
};
