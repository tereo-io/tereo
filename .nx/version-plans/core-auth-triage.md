---
core: major
---

A triage of authentication. Cookie-authenticated `/oauth` requests are bound to their client: a page may use only the cookies of a client with a redirect URI at its origin (core's own origin and the admin UI's excepted), and credentialed CORS is sent only on the API, never on `GET /oauth/authorize` or the UI. Credential cookies use the `__Host-` prefix when Secure and `COOKIE_DOMAIN` is unset. Changes that open a new way into existing accounts — SSO-only domains and repointing a provider that has one — and relaxing the 2FA policy need a global `admin`; credential resets and reactivation of an organization owner or admin need `organizations.write`; tightening 2FA requirements revokes affected access tokens. An SSO-only domain's provider is the only way in, provider sign-ins forward `prompt=login`/`max_age` and use the provider's `auth_time`, and a forced link commits only after the second factor (migration `pending_identity_links`). Deactivated services and integrations can no longer authenticate at introspect, revoke or check-permission; `immediate` key rotation retires the old key at once; the plaintext refresh-token prefix is dropped (migration `drop_refresh_token_prefix`). Sign-out everywhere also ends account-page TOTP setups, pending links and unexchanged codes; login 2FA uses a 24-hour backoff; passwords use a self-describing scrypt format, rehashed at login; SSO sessions end after `USER_SESSION_IDLE_TTL` (default 3 days) without use (migration `user_session_idle`). `ISSUER` and production CORS origins are validated, and authorize errors after a valid `redirect_uri` redirect to the client.

Breaking changes:

- Every browser is signed out once (renamed cookies).
- Cookie-mode refresh, login and consent from an origin outside the client's redirect URIs are refused, even when CORS-listed.
- `/oauth/introspect` refuses public clients; discovery advertises `client_secret_basic` only.
- Authorize errors are redirects to the client, not JSON 400s; `GET /oauth/end-session` with a hint and no `post_logout_redirect_uri` redirects.
- Users at an SSO-only domain cannot sign in, link or claim invites through any other provider.
- Integrations and other non-app-service accounts can no longer write audit entries, emit events or send notifications without an organization; audit `source` values of core or another service are refused (`422 source_reserved`).
- Production refuses `http://` CORS origins other than loopback and a non-https or malformed `ISSUER`.
