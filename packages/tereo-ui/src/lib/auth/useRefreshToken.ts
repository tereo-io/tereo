import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isLoggedOut, readStoredTokens } from "./logoutMarker";
import { isRefreshRejected } from "./refreshTokenManager";
import { useLocalStorage } from "@kosmeo-ui/react";
import type { StoredTokens } from "./types";
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

// Uses axiosBase directly instead of usePublicAxios because this hook is
// called from inside AxiosProvider — the context isn't available yet to its
// own children's render bodies.
const useRefreshToken = () => {
  const [, setTokens] = useLocalStorage<StoredTokens>(env.TOKEN_KEY);
  const queryClient = useQueryClient();

  const mutationFn = async (): Promise<StoredTokens> => {
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
