import { logger } from "./logger.js";

export type AuditEventType =
  | "http_request"
  | "auth_success"
  | "auth_failure"
  | "password_failure"
  | "token_issued"
  | "token_refreshed"
  | "token_revoked"
  | "token_introspected"
  | "auth_code_reuse"
  | "refresh_token_reuse"
  | "auth_code_validation_failure"
  | "client_auth_failure"
  | "client_created"
  | "client_updated"
  | "client_deleted"
  | "user_created"
  | "user_updated";

export interface AuditLogEntry {
  event: AuditEventType;
  timestamp?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  duration?: number;
  ip?: string;
  userAgent?: string;
  clientId?: string;
  userId?: string;
  scopes?: string[];
  grantType?: string;
  tokenType?: "access_token" | "refresh_token";
  jti?: string;
  error?: string;
  errorDescription?: string;
  details?: Record<string, unknown>;
}

// Failures and reuse detections (a replayed code or refresh token suggests
// theft) at warn; per-request and introspection lines, which every resource
// server call produces, at debug; everything else, the successes, at info.
const WARN_EVENTS: ReadonlySet<AuditEventType> = new Set([
  "auth_failure",
  "password_failure",
  "auth_code_reuse",
  "refresh_token_reuse",
  "auth_code_validation_failure",
  "client_auth_failure",
]);
const DEBUG_EVENTS: ReadonlySet<AuditEventType> = new Set([
  "http_request",
  "token_introspected",
]);

const authLogLevel = (event: AuditEventType): "warn" | "info" | "debug" =>
  WARN_EVENTS.has(event) ? "warn" : DEBUG_EVENTS.has(event) ? "debug" : "info";

export const authLog = (entry: AuditLogEntry): void => {
  const { event, ...meta } = entry;
  logger[authLogLevel(event)]({ audit: true, ...meta }, event);
};

export const logAuthFailure = (
  clientId: string | undefined,
  error: string,
  errorDescription: string,
  ip?: string
): void => {
  authLog({
    event: "auth_failure",
    clientId,
    error,
    errorDescription,
    ip,
  });
};

/** A wrong password; `userId` is absent for an email no account has. */
export const logPasswordFailure = (entry: {
  check: "login" | "password_change";
  reason: string;
  userId?: string;
  clientId?: string;
  ip?: string;
  consecutiveFailures?: number;
}): void => {
  const { check, reason, userId, clientId, ip, consecutiveFailures } = entry;
  authLog({
    event: "password_failure",
    userId,
    clientId,
    ip,
    error: "invalid_credentials",
    details: { check, reason, consecutiveFailures },
  });
};

export const logTokenIssued = (
  clientId: string,
  userId: string | undefined,
  grantType: string,
  scopes: string[],
  jti: string
): void => {
  authLog({
    event: "token_issued",
    clientId,
    userId,
    grantType,
    scopes,
    jti,
    tokenType: "access_token",
  });
};

export const logTokenRefreshed = (
  clientId: string,
  userId: string,
  scopes: string[],
  jti: string
): void => {
  authLog({
    event: "token_refreshed",
    clientId,
    userId,
    scopes,
    jti,
    tokenType: "access_token",
  });
};

export const logTokenRevoked = (
  tokenType: "access_token" | "refresh_token",
  jti?: string,
  ip?: string
): void => {
  authLog({
    event: "token_revoked",
    tokenType,
    jti,
    ip,
  });
};

export const logTokenIntrospected = (
  clientId: string,
  tokenActive: boolean,
  ip?: string
): void => {
  authLog({
    event: "token_introspected",
    clientId,
    details: { tokenActive },
    ip,
  });
};

export const logAuthCodeReuse = (
  clientId: string,
  userId: string,
  codeId: string,
  ip?: string
): void => {
  authLog({
    event: "auth_code_reuse",
    clientId,
    userId,
    ip,
    details: {
      codeId,
      severity: "critical",
      action: "tokens_revoked",
    },
  });
};

export const logRefreshTokenReuse = (
  clientId: string,
  userId: string,
  ip?: string
): void => {
  authLog({
    event: "refresh_token_reuse",
    clientId,
    userId,
    ip,
    details: {
      severity: "critical",
      action: "token_family_revoked",
    },
  });
};

export const logAuthCodeValidationFailure = (
  clientId: string | undefined,
  reason: string,
  codePrefix?: string,
  ip?: string
): void => {
  authLog({
    event: "auth_code_validation_failure",
    clientId,
    error: "invalid_grant",
    errorDescription: reason,
    ip,
    details: {
      codePrefix: codePrefix ? codePrefix.substring(0, 8) + "..." : undefined,
    },
  });
};

export const logClientAuthFailure = (
  clientId: string | undefined,
  reason: string,
  grantType: string,
  ip?: string
): void => {
  authLog({
    event: "client_auth_failure",
    clientId,
    grantType,
    error: "invalid_client",
    errorDescription: reason,
    ip,
  });
};
