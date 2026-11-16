import { readJson, removeKey, writeJson } from "./storage.js";
import { activeConfig } from "./config.js";
import { readTokens } from "./tokens.js";

export const markSignedIn = (): void =>
  writeJson(activeConfig().keys.signedIn, "1");

export const clearSignedIn = (): void =>
  removeKey(activeConfig().keys.signedIn);

// Set by an explicit sign-out and cleared only by the next interactive login
// (the code exchange). While it is set no session is assumed: if the revoke
// call failed, the refresh cookie may still be valid, and a silent refresh
// would sign the user straight back in.
export const markLoggedOut = (): void =>
  writeJson(activeConfig().keys.loggedOut, "1");

export const clearLoggedOut = (): void =>
  removeKey(activeConfig().keys.loggedOut);

export const isLoggedOut = (): boolean =>
  readJson(activeConfig().keys.loggedOut) !== null;

export const hasSession = (): boolean =>
  !isLoggedOut() &&
  (readJson(activeConfig().keys.signedIn) !== null || readTokens() !== null);
