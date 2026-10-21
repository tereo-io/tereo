import type { AuthorizeRequestParams } from "../../../utils/authorization.js";
import { authorizationResponseUrl } from "../../../utils/authorization.js";
import { NotFoundError, OAuth2Error } from "../../../utils/errors.js";
import type { AuthorizeRequest, AuthorizeSubmit } from "./schemas.js";
import { ErrorStateSchema } from "./schemas.js";
import db from "../../../utils/db/index.js";
import type { ZodError } from "zod";

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

/**
 * The redirect for an authorize request whose client and redirect URI check
 * out but whose other parameters do not (RFC 6749 section 4.1.2.1): a
 * `response_type` other than `code` is `unsupported_response_type`, the rest
 * `invalid_request`. The request's `state` goes back when it is usable.
 */
export const invalidAuthorizeRequestUrl = (
  redirectUri: string,
  rawQuery: Record<string, unknown>,
  error: ZodError
): string => {
  const unsupportedResponseType =
    rawQuery.response_type !== undefined &&
    error.issues.some((issue) => issue.path[0] === "response_type");
  const state = ErrorStateSchema.safeParse(rawQuery.state);
  return authorizationResponseUrl(redirectUri, {
    error: unsupportedResponseType
      ? "unsupported_response_type"
      : "invalid_request",
    error_description: unsupportedResponseType
      ? "Only response_type=code is supported"
      : error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(", "),
    state: state.success ? state.data : null,
  });
};
