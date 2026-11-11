import type { AxiosError } from "axios";

/** Core's error body is `{ error, error_description }`. */
export type CoreError = AxiosError<{
  error?: string;
  error_description?: string;
}>;

export const errorMessage = (error: CoreError, fallback: string) =>
  error.response?.data?.error_description || fallback;
