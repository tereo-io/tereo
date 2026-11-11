import { isLoggedOut, markLoggedOut, readStoredTokens } from "./logoutMarker";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isRefreshRejected } from "./refreshTokenManager";
import { useLocalStorage } from "@kosmeo-ui/react";
import type { StoredTokens } from "./types";
import { decodeAccessToken } from "./jwt";
import { errorLog } from "./logger";
import axiosBase from "axios";
import env from "./config";

interface TokenResponse {
  access_token: string;
  id_token?: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

const subjectOf = (accessToken: string | undefined) =>
  accessToken ? (decodeAccessToken(accessToken)?.sub ?? null) : null;

// Uses axiosBase directly instead of usePublicAxios because this hook is
// called from inside AxiosProvider — the context isn't available yet to its
// own children's render bodies.
const useRefreshToken = () => {
  const [, setTokens] = useLocalStorage<StoredTokens>(env.TOKEN_KEY);
  const queryClient = useQueryClient();

  const mutationFn = async (): Promise<StoredTokens> => {
    // Who the tab is signed in as; nobody on a load with no stored token.
    const signedInAs = subjectOf(readStoredTokens()?.access_token);

    const res = await axiosBase.post<TokenResponse>(
      `${env.AUTH_SERVER_URL}/oauth/token`,
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.CLIENT_ID,
        refresh_token_response_mode: "cookie",
      }),
      {
        withCredentials: true,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    // Signed out in another tab while this refresh was in flight.
    if (isLoggedOut()) throw new Error("Signed out during token refresh");

    // The refresh cookie is not this user's: something outside the UI put
    // it there. Marked signed out so that it is not refreshed from again,
    // with nothing stored to compare against; clearing the tokens sends the
    // tab to the login page (AuthProvider).
    if (signedInAs && subjectOf(res.data.access_token) !== signedInAs) {
      markLoggedOut();
      setTokens(null);
      throw new Error("Token refresh answered for another user");
    }

    // A refresh returns a fresh id_token for the same login, which logout
    // sends as the end-session id_token_hint; keep the stored one if not.
    const idToken = res.data.id_token ?? readStoredTokens()?.id_token;
    const newTokens: StoredTokens = {
      ...res.data,
      ...(idToken && { id_token: idToken }),
      expiresAt: Date.now() + res.data.expires_in * 1000,
    };

    setTokens(newTokens);
    return newTokens;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["userInfo"] });
    },
    onError: (error) => {
      errorLog("Token refresh failed:", error);
      if (isRefreshRejected(error)) setTokens(null);
    },
  });
};

export default useRefreshToken;
