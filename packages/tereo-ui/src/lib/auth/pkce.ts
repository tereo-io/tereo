import { signIn } from "@tereo-io/react";

/**
 * Redirects to core's authorize endpoint. `returnTo` is an in-app path to
 * land on after the callback, instead of "/".
 */
export const startLogin = (
  extraParams: Record<string, string> = {},
  returnTo?: string
): Promise<void> => signIn({ params: extraParams, returnTo });
