import { isAxiosError } from "axios";

interface CoreErrorBody {
  error?: string;
  error_description?: string;
}

const MESSAGES: Record<string, string> = {
  sso_only_domain:
    "A domain on this provider is SSO-only. Remove SSO-only from it or delete the domain first.",
  domain_taken: "Another provider already uses that domain.",
  not_org_assignable:
    "One of the default roles can't be given within an organization.",
  unknown_role: "One of the default roles no longer exists.",
  reserved_slug: "That slug is reserved. Choose another.",
  slug_taken: "Another provider already uses that slug.",
  slug_in_use:
    "Accounts are connected through this provider, so its slug can't change.",
  issuer_in_use:
    "Accounts are connected through this provider, so its issuer can't change. Add a new provider for the new issuer instead.",
  provider_unreachable:
    "Core could not reach the issuer's discovery document. Check the issuer URL.",
  invalid_provider_config:
    "The issuer's configuration is not valid for sign-in. Check the issuer URL.",
  last_sign_in_method:
    "That is the only way this account can sign in. Connect another provider first, or ask an administrator.",
  sso_required:
    "This account's domain requires the provider, so it can't be disconnected.",
};

/** A readable message for core's `{ error, error_description }`. */
export const identityErrorMessage = (
  error: unknown,
  fallback: string
): string => {
  if (!isAxiosError<CoreErrorBody>(error)) return fallback;
  const body = error.response?.data;
  return (
    (body?.error && MESSAGES[body.error]) || body?.error_description || fallback
  );
};
