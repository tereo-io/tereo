import type { AxiosError } from "axios";

export interface FieldIssue {
  /** Dotted path to the field; empty for the object itself. */
  path: string;
  message: string;
}

interface CoreErrorBody {
  error?: string;
  error_description?: string;
  issues?: FieldIssue[];
}

/** Core's error body is `{ error, error_description, issues? }`. */
export type CoreError = AxiosError<CoreErrorBody>;

/** The per-field problems of a validation refusal (`invalid_request`, `invalid_settings`, …). */
export const issuesOf = (error: unknown): FieldIssue[] =>
  (error as CoreError | null | undefined)?.response?.data?.issues ?? [];

export const errorCodeOf = (error: unknown): string | undefined =>
  (error as CoreError | null | undefined)?.response?.data?.error;

export const errorDescriptionOf = (error: unknown, fallback: string) =>
  (error as CoreError | null | undefined)?.response?.data?.error_description ||
  fallback;
