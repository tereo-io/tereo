import type { AuthorizeRequestParams } from "../../../utils/authorization.js";
import { NotFoundError, OAuth2Error } from "../../../utils/errors.js";
import type { AuthorizeRequest, AuthorizeSubmit } from "./schemas.js";
import db from "../../../utils/db/index.js";

/**
 * RFC 6749 section 4.1.2.1: with an unknown client_id the redirect URI cannot
 * be trusted, so the error goes back to the caller rather than to it.
 */
export const getClientForAuthorize = async (clientId: string) =>
  db.clients.getByClientId(clientId).catch((err) => {
    if (err instanceof NotFoundError) {
      throw new OAuth2Error("invalid_request", "Unknown client_id");
    }
    throw err;
  });

export const authorizeRequestParams = (
  request: AuthorizeRequest | AuthorizeSubmit
): AuthorizeRequestParams => ({
  clientId: request.client_id,
  redirectUri: request.redirect_uri,
  scopes: request.scope ? request.scope.split(" ") : [],
  state: request.state ?? null,
  codeChallenge: request.code_challenge,
  codeChallengeMethod: request.code_challenge_method,
  nonce: request.nonce || null,
  maxAge: request.max_age ?? null,
  acrValues: request.acr_values || null,
  prompt: request.prompt || null,
});
