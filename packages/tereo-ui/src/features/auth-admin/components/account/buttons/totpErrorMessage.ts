import { isAxiosError } from "axios";

export const totpErrorMessage = (error: unknown, fallback: string): string =>
  (isAxiosError<{ error_description?: string }>(error) &&
    error.response?.data?.error_description) ||
  fallback;
