const UPSTREAM_ERROR_MESSAGES: Record<string, string> = {
  upstream_cancelled: "Sign-in was cancelled at the identity provider.",
  upstream_failed:
    "The identity provider could not sign you in. Try again, or use another way to sign in.",
  session_expired: "That sign-in took too long. Please try again.",
  provider_inactive: "This identity provider is turned off.",
  no_account:
    "There's no account for this sign-in. Ask an administrator for an invite.",
  account_exists:
    "An account with this email already exists. Sign in with your password, then connect the provider from My Account.",
  email_unverified:
    "The identity provider has not verified your email address, so it can't be used to sign in.",
  account_mismatch:
    "The account you chose at the identity provider isn't the one for your email. Sign in there with your work account and try again.",
  account_inactive:
    "This account is deactivated. Ask an administrator to reactivate it.",
  identity_in_use: "That sign-in is already connected to another account.",
  already_linked: "You have already connected an account from that provider.",
  sso_required:
    "Your organization requires you to sign in with its identity provider.",
  reauth_required: "Please sign in again to confirm this change.",
  last_sign_in_method:
    "This is your only way to sign in. Connect another provider first, or ask an administrator.",
  too_many_attempts:
    "Too many failed sign-in attempts. Please wait a few minutes and try again.",
};

/** A message for an upstream sign-in error code; null for any other code. */
export const upstreamErrorMessage = (code: string): string | null =>
  UPSTREAM_ERROR_MESSAGES[code] ?? null;
