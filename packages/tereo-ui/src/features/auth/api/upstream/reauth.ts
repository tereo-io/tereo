import { startLogin } from "@/lib/auth/pkce";
import { isAxiosError } from "axios";

/** True when core refused because the sign-in is too old for this change. */
export const isReauthRequired = (error: unknown): boolean =>
  isAxiosError<{ error?: string }>(error) &&
  error.response?.status === 403 &&
  error.response.data?.error === "reauth_required";

/** Signs in again, now, and comes back to `returnTo`. */
export const restartLoginFresh = (returnTo: string): Promise<void> =>
  startLogin({ max_age: "0" }, returnTo);
