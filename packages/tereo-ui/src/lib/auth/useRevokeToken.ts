import { markLoggedOut, readStoredTokens } from "./logoutMarker";
import { useMutation } from "@tanstack/react-query";
import { useLocalStorage } from "@kosmeo-ui/react";
import { usePublicAxios } from "./axiosContext";
import { debugLog, errorLog } from "./logger";
import { decodeIdToken } from "./jwt";
import env from "./config";

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

// Core's ID_TOKEN_HINT_GRACE_SECONDS: it rejects a hint expired longer ago.
const ID_TOKEN_HINT_GRACE_SECONDS = 60 * 60;

/** The id token, unless core would reject it for having expired too long ago. */
const usableIdTokenHint = (idToken?: string): string | undefined => {
  if (!idToken) return undefined;
  const exp = decodeIdToken(idToken)?.exp;
  if (typeof exp !== "number") return idToken;
  const now = Math.floor(Date.now() / 1000);
  return now - exp > ID_TOKEN_HINT_GRACE_SECONDS ? undefined : idToken;
};

const useRevokeToken = () => {
  const [, setToken] = useLocalStorage(env.TOKEN_KEY, null);
  const axios = usePublicAxios("auth");

  const endSession = async (idTokenHint?: string) => {
    if (!idTokenHint) throw new Error("No usable id_token_hint");
    return axios.post(
      `/oauth/end-session`,
      new URLSearchParams({
        client_id: env.CLIENT_ID,
        id_token_hint: idTokenHint,
      }),
      { withCredentials: true, headers: FORM_HEADERS }
    );
  };

  // Without a hint core cannot tell this logout from one a cross-site page
  // triggered, so it asks the user to confirm on its sign-out page; the
  // browser goes there instead of home.
  const confirmEndSessionUrl = () =>
    `${env.AUTH_SERVER_URL}/oauth/end-session?${new URLSearchParams({
      client_id: env.CLIENT_ID,
    }).toString()}`;

  const mutationFn = async () => {
    // Set before any network call, so a failed or interrupted logout still
    // never refreshes silently on the next load.
    markLoggedOut();
    const idToken = usableIdTokenHint(readStoredTokens()?.id_token);

    // Revoke clears this client's refresh-token cookies; end-session ends the
    // SSO session, whose cookie would otherwise let authorize sign the user
    // straight back in. Each runs even if the other fails.
    const [revoke, ended] = await Promise.allSettled([
      axios.post(
        `/oauth/revoke`,
        new URLSearchParams({
          client_id: env.CLIENT_ID,
          token_type_hint: "refresh_token",
        }),
        { withCredentials: true, headers: FORM_HEADERS }
      ),
      endSession(idToken),
    ]);

    if (revoke.status === "rejected") {
      errorLog("Token revocation request failed:", revoke.reason);
    }
    if (ended.status === "rejected") {
      errorLog("End-session request failed:", ended.reason);
    }
    debugLog("Logout requests settled");

    setToken(null);
    window.location.href =
      ended.status === "fulfilled"
        ? env.logoutRedirectPath
        : confirmEndSessionUrl();
  };

  return useMutation({
    mutationFn,
  });
};

export default useRevokeToken;
