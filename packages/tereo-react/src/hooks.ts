import { type AuthState, ApiContext, AuthContext } from "./provider.js";
import { useCallback, useContext, useRef, useState } from "react";
import { completeSignIn } from "./signIn.js";
import type { TereoUser } from "./config.js";
import type { AxiosInstance } from "axios";

export const useAuth = <U extends TereoUser = TereoUser>(): AuthState<U> => {
  const state = useContext(AuthContext);
  if (!state) throw new Error("useAuth must be used within TereoAuthProvider");
  return state as unknown as AuthState<U>;
};

const useClient = (
  name: string,
  kind: "authed" | "open",
  hook: string
): AxiosInstance => {
  const clients = useContext(ApiContext);
  if (!clients)
    throw new Error(`${hook} must be used within TereoAuthProvider`);
  const client = clients[kind][name];
  if (!client) throw new Error(`No API named "${name}" in the Tereo config`);
  return client;
};

/** The named API's client, sending the user's access token. */
export const useApi = (name: string): AxiosInstance =>
  useClient(name, "authed", "useApi");

/** The named API's client with no token, for cookies or open endpoints. */
export const usePublicApi = (name: string): AxiosInstance =>
  useClient(name, "open", "usePublicApi");

/**
 * Finishes sign-in on the callback route. The exchange runs once per mount,
 * however often `complete` is called (React StrictMode runs effects twice,
 * and the PKCE verifier is single-use).
 */
export const useCompleteSignIn = (): {
  complete: (search: URLSearchParams) => Promise<{ returnTo: string | null }>;
  error: Error | null;
  isPending: boolean;
} => {
  const started = useRef<Promise<{ returnTo: string | null }> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(false);

  const complete = useCallback((search: URLSearchParams) => {
    if (!started.current) {
      setIsPending(true);
      started.current = completeSignIn(search)
        .catch((e: unknown) => {
          setError(e instanceof Error ? e : new Error(String(e)));
          throw e;
        })
        .finally(() => setIsPending(false));
    }
    return started.current;
  }, []);

  return { complete, error, isPending };
};
