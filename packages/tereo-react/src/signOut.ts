import { decodeJwt, readTokens, writeTokens } from "./tokens.js";
import { clearSignedIn, markLoggedOut } from "./markers.js";
import { activeConfig } from "./config.js";
import { errorLog } from "./logger.js";
import axios from "axios";

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

// Core's ID_TOKEN_HINT_GRACE_SECONDS: it rejects a hint expired longer ago.
const ID_TOKEN_HINT_GRACE_SECONDS = 60 * 60;

/** The id token, unless core would reject it for having expired too long ago. */
const usableIdTokenHint = (idToken?: string): string | undefined => {
  if (!idToken) return undefined;
  const exp = decodeJwt(idToken)?.exp;
  if (typeof exp !== "number") return idToken;
  const now = Math.floor(Date.now() / 1000);
  return now - exp > ID_TOKEN_HINT_GRACE_SECONDS ? undefined : idToken;
};

/** Ends the session at core, clears local state and leaves the app. */
export const signOut = async (): Promise<void> => {
  const { coreUrl, clientId, requestTimeoutMs, signedOutPath, basePath } =
    activeConfig();
  const options = {
    withCredentials: true,
    timeout: requestTimeoutMs,
    headers: FORM_HEADERS,
  };

  // Set before any network call, so a failed or interrupted sign-out still
  // never refreshes silently on the next load.
  markLoggedOut();
  const hint = usableIdTokenHint(readTokens()?.id_token);

  // Revoke clears this client's refresh-token cookies; end-session ends the
  // SSO session, whose cookie would otherwise let authorize sign the user
  // straight back in. Each runs even if the other fails.
  const [revoked, ended] = await Promise.allSettled([
    axios.post(
      `${coreUrl}/oauth/revoke`,
      new URLSearchParams({
        client_id: clientId,
        token_type_hint: "refresh_token",
      }),
      options
    ),
    hint
      ? axios.post(
          `${coreUrl}/oauth/end-session`,
          new URLSearchParams({ client_id: clientId, id_token_hint: hint }),
          options
        )
      : Promise.reject(new Error("No usable id_token_hint")),
  ]);

  if (revoked.status === "rejected") {
    errorLog("Token revocation request failed", revoked.reason);
  }
  if (ended.status === "rejected" && hint) {
    errorLog("End-session request failed", ended.reason);
  }

  writeTokens(null);
  clearSignedIn();

  // Without a hint core cannot tell this sign-out from one a cross-site page
  // triggered, so it asks the user to confirm on its own page.
  window.location.href =
    ended.status === "fulfilled"
      ? `${basePath}${signedOutPath}`
      : `${coreUrl}/oauth/end-session?${new URLSearchParams({ client_id: clientId })}`;
};
