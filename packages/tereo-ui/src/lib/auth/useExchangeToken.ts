import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocalStorage } from "@kosmeo-ui/react";
import { usePublicAxios } from "./axiosContext";
import { clearLoggedOut } from "./logoutMarker";
import { clearPKCE, readPKCE } from "./pkce";
import type { StoredTokens } from "./types";
import { decodeIdToken } from "./jwt";
import { debugLog } from "./logger";
import env from "./config";

type TokenResponse = Omit<StoredTokens, "expiresAt">;

const useExchangeToken = () => {
  const [, setToken] = useLocalStorage<StoredTokens>(env.TOKEN_KEY, null);
  const queryClient = useQueryClient();
  const axios = usePublicAxios("auth");

  const mutationFn = async (data: { code: string; state: string }) => {
    const pkce = readPKCE();
    if (!pkce || pkce.state !== data.state) {
      throw new Error(
        "This sign-in link does not match the one this tab started. Please sign in again."
      );
    }
    // The verifier is single-use: a failed exchange cannot be retried.
    clearPKCE();

    const res = await axios.post<TokenResponse>(
      `/oauth/token`,
      new URLSearchParams({
        grant_type: "authorization_code",
        code: data.code,
        redirect_uri: env.REDIRECT_URI,
        client_id: env.CLIENT_ID,
        code_verifier: pkce.codeVerifier,
        refresh_token_response_mode: "cookie",
      }),
      {
        withCredentials: true,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const tokens = res.data;
    // Received straight from the token endpoint over TLS, so the signature
    // need not be checked (OIDC Core 3.1.3.7); the nonce and audience must.
    const idToken = tokens.id_token ? decodeIdToken(tokens.id_token) : null;
    if (!idToken || idToken.nonce !== pkce.nonce) {
      throw new Error("ID token nonce validation failed");
    }
    if (idToken.aud !== env.CLIENT_ID) {
      throw new Error("ID token was issued to a different client");
    }

    setToken({ ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 });
    clearLoggedOut();
  };

  return useMutation({
    mutationFn,
    onSuccess: () => {
      debugLog("Token exchanged successfully");
      queryClient.invalidateQueries({ queryKey: ["userInfo"] });
    },
  });
};

export default useExchangeToken;
