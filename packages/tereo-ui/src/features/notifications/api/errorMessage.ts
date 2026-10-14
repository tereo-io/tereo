import type { FieldIssue } from "./types";
import type { AxiosError } from "axios";

interface CoreErrorBody {
  error?: string;
  error_description?: string;
  issues?: FieldIssue[];
}

/** Core's error body is `{ error, error_description, issues? }`. */
export type CoreError = AxiosError<CoreErrorBody>;

const KNOWN: Record<string, string> = {
  slug_taken: "A connection with this slug already exists on this channel.",
  connection_in_use:
    "Notifications or deliveries still use this connection. Disable it instead.",
  secrets_required:
    "Enter the password again: changing the host, port, security or username needs it.",
};

export const errorMessage = (error: CoreError, fallback: string) => {
  const body = error.response?.data;
  return (
    (body?.error && KNOWN[body.error]) || body?.error_description || fallback
  );
};

/** The per-field problems of an `invalid_settings` / `invalid_secrets` refusal. */
export const issuesOf = (error: CoreError | null | undefined): FieldIssue[] =>
  error?.response?.data?.issues ?? [];
