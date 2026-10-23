import { CORE_SCOPES } from "../../../definitions/index.js";
import { CORE_URL } from "../coreUrl.js";

const envBaseUrl = process.env.BASE_URL;
export const BASE_URL = envBaseUrl?.startsWith("http") ? envBaseUrl : CORE_URL;

// Syntactically valid UUID (v7-shaped) used by tests as a sentinel for
// "this id is well-formed but does not exist in the DB". Use this where
// tests need to exercise NOT_FOUND paths after the route's strict UUID
// param/body validation introduced by the UUID v7 transition.
export const NON_EXISTENT_UUID = "00000000-0000-7000-8000-000000000000";

/**
 * Every core API scope. Test clients are granted them and test logins ask
 * for them, so a third-party token reaches all of core's API — capped, as
 * any delegated token is, at the scopes' ceilings.
 */
export const ALL_CORE_SCOPES = CORE_SCOPES.map((s) => s.name);

// HTTP Status Code Constants for consistent test assertions
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  FOUND: 302,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_SERVER_ERROR: 500,
} as const;

// OAuth Error Codes per RFC 6749 and OIDC Core
export const OAUTH_ERRORS = {
  INVALID_REQUEST: "invalid_request",
  INVALID_CLIENT: "invalid_client",
  INVALID_GRANT: "invalid_grant",
  INVALID_SCOPE: "invalid_scope",
  INVALID_TOKEN: "invalid_token",
  UNAUTHORIZED_CLIENT: "unauthorized_client",
  UNSUPPORTED_GRANT_TYPE: "unsupported_grant_type",
  UNSUPPORTED_RESPONSE_TYPE: "unsupported_response_type",
  ACCESS_DENIED: "access_denied",
  SERVER_ERROR: "server_error",
  LOGIN_REQUIRED: "login_required",
  CONSENT_REQUIRED: "consent_required",
  INTERACTION_REQUIRED: "interaction_required",
  INVALID_SESSION: "invalid_session",
  INVALID_SETUP_TOKEN: "invalid_setup_token",
  INVALID_SETUP_GRANT: "invalid_setup_grant",
  INVALID_TOTP: "invalid_totp",
  MFA_REQUIRED: "mfa_required",
} as const;
