---
core: major
---

An audit of the server and websocket. Sign-out everywhere (and password, TOTP and admin resets) also revokes the pre-refresh tokens of each ended login and closes their sockets; every node re-checks its sockets every `WEBSOCKET_REVALIDATE_INTERVAL_SECONDS` (default 60); sockets receive only the events their token reaches, the per-user cap is exact and pings are rate-limited. Token reuse, `/oauth/revoke`, end-session, repeated wrong passwords, TOTP setup starts, consents, registry retirement, the archive sweep, share expiry backfills, exhausted share unlocks and HTTP-emitted events are audited, and revocations run in their mutation's transaction. New event types `webhook.endpoint.*`, `auth.identity-provider.domain-*` and `auth.user.identity-invite-*`; buckets without an organization (app-service buckets) emit file events to all-organizations endpoints and their service's endpoints. `DELETE` of a bucket grant or an organization member takes `revokeShares=true` to revoke that user's shares. Bodies are parsed after authentication (1 MB default), non-upload requests get 60s, unauthenticated `/v1/files` rejections write no access log, and access logs are kept for `ACCESS_LOG_RETENTION_DAYS` (default 90). New `HTTP_MAX_CONNECTIONS` and `SHUTDOWN_TIMEOUT_SECONDS` (migration `login_step_provider`).

Breaking changes:

- Regenerating or revoking an integration's or service's secret needs every permission its account holds.
- Changing a webhook endpoint's `url` or `customHeaders` while it has `file-service.*` subscriptions, and retrying those deliveries, needs its creator or `webhooks.admin`.
- Loosening a share (password removed, download cap removed or raised, expiry extended) needs its creator, a bucket manager or `file-service.admin`; grants are capped at the granter's own grant; `GET …/my-permissions` without a grant on a private bucket is a 403.
- Org admins can only remove org roles they could grant; `GET /v1/admin/clients` lists only the caller's clients without `clients.admin`.
- `/oauth/userinfo` and `/oauth/introspect` cap a delegated token's permissions to its scopes (no roles; organizations only with an account or organizations scope); `/oauth/check-permission` answers 403 for an unknown user.
- A wrong code on the account TOTP routes is 400, not 401; duplicate slugs and names answer `slug_taken` / `name_taken` (organization codes `code_taken`) instead of `conflict`.
- New input limits (400): webhook `eventTypes` ≤ 100, event `entityId` ≤ 500 and `data` ≤ 256 KiB, audit `changes`/`metadata` ≤ 64 KiB, list filter values ≤ 500 and `in` lists ≤ 100, provisioning webhook `events` ≤ 100.
- `/health` no longer returns `version`; requests whose body takes over 60s answer 408 (uploads keep 10 minutes).
- Core events nobody subscribes to no longer write a "no matching endpoints" audit entry; a provider sign-in writes one `LOGIN` at code issue instead of one before the second factor.
