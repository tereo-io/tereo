import { isAxiosError } from "axios";

interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

const oauthErrorCode = (error: unknown): string | undefined =>
  isAxiosError<OAuthErrorBody>(error) ? error.response?.data?.error : undefined;

/** Core's `{ error, error_description }`, else the error's own message. */
export const oauthErrorMessage = (error: unknown, fallback: string): string => {
  if (isAxiosError<OAuthErrorBody>(error)) {
    const body = error.response?.data;
    return body?.error_description || body?.error || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
};

// The login flow's session is gone: retrying the form cannot succeed, only
// starting over from sign-in can.
const EXPIRED_FLOW_ERRORS = new Set([
  "invalid_session",
  "session_expired",
  "invalid_setup_grant",
  "invalid_setup_token",
  "setup_expired",
]);

export const isExpiredFlowError = (error: unknown): boolean =>
  EXPIRED_FLOW_ERRORS.has(oauthErrorCode(error) ?? "");
