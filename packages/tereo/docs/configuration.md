# Configuration

Every setting is an environment variable, validated at start by one Zod schema in
[`src/env.ts`](../src/env.ts); an invalid or missing required value stops the process with the
variable named. `.env` in this package is loaded too (`src/preload.ts`), for local runs.

## What production needs

With `NODE_ENV=production`, core refuses to start unless these are set:

| Variable | Why |
|----------|-----|
| `DATABASE_URL` | Postgres |
| `REDIS_URL`, or `REDIS_SENTINELS` + `REDIS_MASTER_NAME` | Redis — single node or Sentinel |
| `PUBLIC_URL` | Externally reachable `https://` URL of core, not localhost/127.0.0.1/[::1]. The OIDC issuer, share and presigned links, and the UI's default address are built from it |
| `CORS_ALLOWED_ORIGINS` | Browser origins allowed to call core's API with credentials; `*` is refused, and so is an `http://` origin other than loopback (`localhost`, `127.0.0.1`, `[::1]`). A security setting: a listed origin's pages can read core's API responses made with the user's credentials — list only origins you trust |
| `TRUST_PROXY` | The proxies in front of core (`1`, a CIDR list, …), or `loopback`/`false` when there are none. Left at the development default behind a load balancer, `req.ip` — rate-limit keys and audit IPs — would be the proxy's address, so it must be chosen, not inherited. `true` is refused: it trusts every `X-Forwarded-For` hop, so a client could pick its own address |
| `CORE_KEK` | Base64, 32 bytes. Encrypts the keys core keeps in `core.secrets`; keep it outside the database (a secret manager), since without it the stored keys cannot be read. See [Key encryption](#key-encryption) |

It also refuses, with no override, `COOKIE_SECURE=false` (or `0`), and a `UI_BASE_URL` or `ISSUER`
that is not `https://`. Development and test accept all of these.

Set these too, though core starts without them:

| Variable | Why |
|----------|-----|
| `FILE_SERVICE_STORAGE_PATH` | A persistent volume for blobs (the image sets `/app/storage`) |

Apart from `CORE_KEK`, no key needs to be supplied: core generates any that env leaves unset into
`core.secrets` on first start, encrypted with the KEK. A key set in env always wins and is never
stored.

## Process roles

`ROLE` picks what a process runs; every role reads the same configuration.

| `ROLE` | Runs |
|--------|------|
| `all` (default) | HTTP, WebSocket and the background workers in one process |
| `api` | HTTP and WebSocket only |
| `worker` | BullMQ workers and scheduled jobs only — webhook delivery, retention, file sweeps, thumbnails, registry retirement |

Run at least one process with `all` or `worker`, or nothing delivers webhooks or sweeps.

### Health checks

`all` and `api` answer `GET /health` on `PORT`: 200 with `status: "ok"` when Postgres and Redis
answer, 503 and `"degraded"` (naming `db` or `redis` as `"fail"`) when either does not. The
Postgres ping runs on a connection of its own, outside the request pool (one more connection per
process), so a busy pool does not read as Postgres being down. The probe result is shared for one
second, and requests are rate-limited per client IP (1000 a second from an internal network
address, 300 otherwise), so point probes at it directly rather than through a proxy that sets
`X-Forwarded-For`. It names no version; an admin finds core's as the core service's
`declarationVersion` (`GET /v1/admin/services`).

`GET /health/ready` is for readiness probes and load balancer health checks: 200 with
`status: "ok"` while core serves, 503 and `"draining"` from the moment shutdown starts. It does not
ping Postgres or Redis: a dependency that slows under load slows every replica at once, and a
readiness check that failed on it would take them all out of rotation together, turning slow
into down. Use `/health` for monitoring and alerts, and for a startup probe, which should wait
for the dependencies. The chart's probes are set up this way.

A `worker` serves no API, so it listens on `WORKER_HEALTH_PORT` (default `4002`) for `GET` (or `HEAD`)
`/health` alone. Besides the Postgres and Redis pings, it is degraded when no BullMQ worker is running or any is
closing or stopped; `workers.total` counts them and `workers.stopped` names the queues of those that
are not running. The image's `HEALTHCHECK` probes `PORT` or `WORKER_HEALTH_PORT` according to
`ROLE`; point a Kubernetes probe at the same port. It answers `/health/ready` too, as `PORT` does.

## HTTP limits

Once its headers are in, a client has 60 seconds to send the rest of a request; past that it gets
`408 request_timeout` and the connection is closed. The upload routes — an object `PUT`, a multipart
part `PUT`, a presigned `PUT` and `POST /v1/account/photo` — get 10 minutes instead (the server's
`requestTimeout`). Request headers must arrive within 66 seconds and fit in 200 KiB, and an idle
keep-alive connection is closed after 65 seconds. `HTTP_MAX_CONNECTIONS` caps open connections.

These bound what one slow client can hold, not a flood of them: run core behind a reverse proxy or
load balancer that buffers requests (and, ideally, limits connections per client) rather than
exposing it directly.

## The Docker image

Releases are published as `ghcr.io/tereo-io/tereo:<version>`, for amd64 and arm64; `<major>.<minor>`
and `latest` follow the newest release. The image sets `NODE_ENV=production`, so a container run from it gets the production checks above,
JSON logs, secure cookies and an exit on an uncaught error. `docker-compose.yml` sets
`NODE_ENV=development` on `core` and `migrate`: its stack runs on localhost, which the production
`PUBLIC_URL`, `TRUST_PROXY` and `CORS_ALLOWED_ORIGINS` checks refuse. A migrate job run in production
reads the same schema, so give it the same environment as core.

## Reference

Defaults are what core uses when the variable is unset. Numeric settings have bounds, given in the
notes as a range; a value outside its range stops core at startup with the variable's name.

### Process and network

| Variable | Default | Notes |
|----------|---------|-------|
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `LOG_LEVEL` | `info` | `fatal` … `trace`, or `silent` |
| `ROLE` | `all` | See [Process roles](#process-roles) |
| `PORT` | `4001` | 1–65535 |
| `HTTP_MAX_CONNECTIONS` | unlimited | 1–1000000. The most connections the HTTP server holds open at once, WebSockets included; past it, a new connection is closed at once. See [HTTP limits](#http-limits) |
| `SHUTDOWN_TIMEOUT_SECONDS` | `25` | 1–3600. On SIGTERM, how long in-flight HTTP requests and running background jobs get, side by side, before connections are forced closed and the jobs left to BullMQ (another worker takes each up once its lock lapses); closing Redis and the database follows. Keep it a few seconds under the time the orchestrator allows after SIGTERM: the chart gives 30 seconds after its `preStopSleepSeconds` |
| `WORKER_HEALTH_PORT` | `4002` | 0–65535. `ROLE=worker` only: its `/health` listener. See [Health checks](#health-checks) |
| `PUBLIC_URL` | `http://localhost:4001` outside production | Required in production, and `https://` there |
| `DATABASE_URL` | — | Required. Sessions run with `timezone=UTC` whatever the server default; an `options` parameter in the URL replaces that |
| `DB_POOL_MAX` | `20` | 1–1000. Postgres connections each process keeps at most. A `connection_limit` in `DATABASE_URL` has no effect. Every replica (and every `api` and `worker`) has its own pool, so keep replicas × `DB_POOL_MAX` under Postgres's `max_connections` (or the pooler's limit), with room for migrations and the seed |
| `DB_POOL_MIN` | `5` | 0–1000, at most `DB_POOL_MAX`. Connections kept open while idle |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | `10000` | 100–600000. How long a query waits for a free connection before it fails with a 500. Under load, a full pool shows as latency up to this long |
| `REDIS_URL` | — | Required unless Sentinel is configured |
| `REDIS_SENTINELS` | — | Comma-separated `host:port` (port defaults to 26379) |
| `REDIS_MASTER_NAME` | — | Sentinel master group |
| `REDIS_PASSWORD` | — | Sentinel connections only |
| `REDIS_DB` | URL's path, else `0` | 0–15. The database index, in URL, unix socket and Sentinel modes alike; set, it overrides a database in `REDIS_URL`'s path |
| `REDIS_KEY_PREFIX` | empty | Up to 64 of `A-Z a-z 0-9 : _ . -`, e.g. `app1:`. Put in front of every key, pub/sub channel, BullMQ prefix (`<prefix>bull`) and socket.io adapter key (`<prefix>socket.io`) core uses, so several cores can share one Redis database. Pub/sub channels span every database index, so cores that share a Redis server on different `REDIS_DB`s still need distinct prefixes. App services must pass the same value as `channelPrefix` to `createCoreClient` to hear core's cache invalidations. Changing it orphans existing keys and jobs: change it only on a fresh Redis or with core stopped and its queues drained |
| `TRUST_PROXY` | `loopback` outside production | Required in production. Express `trust proxy`: `loopback`, `linklocal`, `uniquelocal`, a hop count, a comma-separated IP/CIDR list, or `true`/`false`; `true` is refused in production |
| `CORS_ALLOWED_ORIGINS` | `UI_BASE_URL`'s origin outside production | Comma-separated. Required in production, `https://` or loopback only. The origins sent credentialed CORS headers on core's API (`/v1`, `/oauth` but for `GET /oauth/authorize`, `/.well-known`, `/health`); the admin UI's pages get none. It does not decide which pages may use the browser's cookies: an app's page may use only its own client's (see [auth.md](auth.md#browser-cookies)); list only origins you control |
| `SETUP_TOKEN` | generated and logged | 24 characters or more. Core accepts it as the first-boot setup token until setup completes, so setup can run unattended; it is never logged. Set it in production: a generated token is printed in core's log until setup completes, and logs are often shipped where more people can read them than should create the first admin. It replaces any other setup token, so changing or unsetting it before setup completes retires the old one. Compared case-insensitively, ignoring whitespace and hyphens |
| `PROVISIONING_PATH` | unset | Path of a JSON file, or a directory of `*.json` files, declaring the app services (with what they own and their access and webhooks), login clients and custom roles core applies at every start, as `provisioned` rows. Documents that cannot be applied stop core from starting. Secrets are read from environment variables the documents name, never from the documents. See [provisioning](provisioning.md) |
| `INTERNAL_NETWORK_CIDRS` | RFC 1918, loopback, `fc00::/7`, `fe80::/10` | Comma-separated CIDRs whose service-account callers, connecting directly (no proxy header), get the general rate limit's internal tier, keyed per client, instead of the external one. Read straight from the environment by `utils/rateLimit.ts`, outside the schema, so a bad entry is logged and skipped rather than refused |

### Keys

`CORE_KEK` is required in production. Every other key is optional; each is generated into
`core.secrets` when unset, encrypted with the KEK.

| Variable | Notes |
|----------|-------|
| `CORE_KEK` | Base64, 32 bytes (`openssl rand -base64 32`). Key-encryption key: AES-256-GCM over every value in `core.secrets`. **Required in production** — core refuses to start without it. Outside production, when unset, a fixed development KEK is used (public, protects nothing) and a warning is logged. Keep it outside the database; losing it makes the stored keys unreadable. See [Key encryption](#key-encryption) |
| `CORE_KEK_PREVIOUS` | Base64, 32 bytes. Only while rotating the KEK: rows still under it are re-encrypted under `CORE_KEK` on start. Needs `CORE_KEK`. See [Rotating the KEK](#rotating-the-kek) |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | Base64-encoded PEM, both or neither: an RSA key pair of at least 2048 bits (core refuses to start otherwise). When set, the only signing key: stored versions are ignored and `/v1/admin/signing-keys/rotate` refuses. See [JWT signing keys](#jwt-signing-keys) |
| `JWT_KEY_ID` | The kid of an env-supplied key pair; defaults to its JWK thumbprint. Generated keys always use their thumbprint |
| `AUTH_CODE_HMAC_KEY` | Base64, 32 bytes. Binds authorization codes to their client and keys the hash they are looked up by |
| `TOTP_ENCRYPTION_KEY` | 64 hex characters |
| `KNOWN_DEVICE_KEY` | Base64, 32 bytes. HMAC for the known-device login cookie; changing it forgets every known device |
| `CURSOR_SIGNING_KEY_V1`, `CURSOR_SIGNING_KEY_V2` | Base64, 32 bytes. HMAC for list cursors |
| `CURSOR_ACTIVE_SIGNING_KEY_VERSION` | `1` |
| `FILE_SERVICE_SIGNING_KEY_V1`, `FILE_SERVICE_SIGNING_KEY_V2` | Base64, 32 bytes. HMAC for presigned and share URLs |
| `FILE_SERVICE_ACTIVE_SIGNING_KEY_VERSION` | `1` |
| `FILE_SERVICE_MASTER_KEY_V{n}` | Base64, 32 bytes. Wraps each blob's data key; read and then removed from `process.env` at start |
| `FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION` | `1`. After changing it, `npm run cli -- rewrap-master-key` re-wraps existing keys |

#### Key encryption

Every value in `core.secrets` is stored as `kek1:<kek id>:<AES-256-GCM payload>`, with the row's name
as associated data, so a value cannot be moved to another row. The KEK id is a hash of `CORE_KEK`
(`env-…`), or `dev` for the development KEK.

- **Development and test** need no KEK. The fallback is derived from a constant rather than generated
  into a file: a file lost or out of step with the database would leave the dev database's keys
  unreadable, while a constant needs no state and behaves the same under `npm run dev`, the compose
  stack and `docker/test`. It is public, so it protects nothing; core logs a warning on every start.
- **Outside production**, a plaintext row or one under the development KEK is decrypted and
  re-encrypted with `CORE_KEK` in place when set. Each update applies only if the row still holds what
  was read, so replicas starting together are safe; it is a no-op once done.
- **In production** such a row is refused, naming it — so nobody with write access to the table can
  plant a key every replica adopts. Delete the row (core regenerates the keys it generates) or seal it
  under `CORE_KEK`. Column-sealed secrets (below) follow the same rule.
- **A row under neither `CORE_KEK` nor `CORE_KEK_PREVIOUS`** (nor the dev KEK) stops the start, naming
  the KEK ids involved.
- **Secrets kept in a table's own column** use the same envelope, with the row as the name: identity
  provider client secrets, notification connection secrets and webhook signing secrets. Those are
  re-sealed under `CORE_KEK` when next opened; webhook signing secrets are also re-sealed on start,
  except a previous signing secret past its overlap, which signs nothing and is cleared instead.
- **KMS**: wrapping sits behind the `KeyEncryptionKey` interface in `utils/kek.ts` (async `wrap` /
  `unwrap`). A KMS-backed provider belongs in dianemo-plugins; only the env provider ships here.

#### Rotating the KEK

1. Generate the new key and deploy with `CORE_KEK=<new>` and `CORE_KEK_PREVIOUS=<old>`.
2. On start, every row still under the old KEK — `core.secrets`, and the secrets kept in table columns
   (identity providers' client secrets, notification connections' secrets, webhook endpoints' signing
   secrets, apart from expired previous ones, which are cleared) — is decrypted with it and
   re-encrypted under the new one, in place. As with the plaintext
   migration, each update applies only if the row still holds what was read, so replicas starting
   together are safe, and once done a start changes nothing. A replica still running the old KEK
   alone would refuse to start against re-encrypted rows, so roll every process onto the pair.
3. Once every process has started with the pair, and no start has logged "Some sealed row secrets
   could not be opened", "Could not seal a webhook endpoint's signing secret" or "Sealing webhook
   signing secrets failed", remove `CORE_KEK_PREVIOUS`. The old key can then be destroyed.

`CORE_KEK_PREVIOUS` without `CORE_KEK` is refused: the rows would be re-encrypted under the public dev
KEK.

#### JWT signing keys

Generated signing keys are versions, `JWT_SIGNING_KEY_V{n}` in `core.secrets`, each with an
activation time (the row's `created_at`). The highest activated version signs, chosen by the clock at
each signing, so every process switches at the same moment; each token carries its key's `kid` (the
JWK thumbprint) and is verified with the key that `kid` names — a token without a `kid`, or with an
unknown one, is refused. A version is retired when the next activates, and keeps verifying, and stays
in `/.well-known/jwks.json`, for `JWT_ACCESS_TOKEN_TTL` plus the one-hour `id_token_hint` grace; past
that it is dropped (and deleted on the next rotation).

Rotate with `POST /v1/admin/signing-keys/rotate` (`settings.write`); `GET /v1/admin/signing-keys` lists the
keys (`settings.read`). A new key is published in the JWKS at once and starts signing 150 seconds later
(`activatesAt` in the response): two of the per-minute refreshes every core process runs, plus a
margin, so every process and every app service that refetches the JWKS knows the key before a token
carries its `kid`. The previous key signs until then. `{ "immediate": true }`, for a compromised key,
activates the new key at once and deletes every older version, a pending one included: tokens they
signed, ID tokens sent as `id_token_hint` included, are refused from that moment, they leave the
JWKS, and signed-in users get tokens from the new key on their next refresh (their refresh tokens are
opaque, not signed). The rotating process broadcasts the change over Redis so every other process
re-reads its keys at once; without Redis they do so at their next per-minute refresh, or on the first
token carrying the new `kid`. The rotation is audited and emits `core.signing-key.rotated` (the new
`kid` and its `activatesAt`, and the retired `kid` with its expiry; no key material), so app services
caching the JWKS can refetch it. A key pair supplied in env is the only key and is rotated by changing
env (no overlap).

### Auth

| Variable | Default | Notes |
|----------|---------|-------|
| `ISSUER` | `PUBLIC_URL` | A URL with no query or fragment, `https://` in production; a trailing slash is dropped. Changing it invalidates every outstanding token. Discovery's endpoint URLs are built from `PUBLIC_URL`, where core is reached |
| `JWT_ACCESS_TOKEN_TTL` | `3600` | Seconds, 1–86400 (24 h) |
| `WEBSOCKET_REVALIDATE_INTERVAL_SECONDS` | `60` | Seconds, 0–3600. How often each core process checks the tokens of its connected sockets again and closes those no longer active (a session rotated away, a token or user revoked by a path that closes no socket); `0` turns it off. See [auth.md](auth.md#session-lifetimes) |
| `JWT_REFRESH_TOKEN_TTL` | `2592000` | Seconds, absolute from the code exchange; at most 31536000 (365 d) |
| `USER_SESSION_TTL` | `604800` | Seconds, absolute from login; at most 31536000 (365 d) |
| `USER_SESSION_IDLE_TTL` | `259200`, or `USER_SESSION_TTL` when shorter | Seconds an SSO session may go without issuing a code before it counts as expired; at most `USER_SESSION_TTL` |
| `AUTHORIZATION_CODE_TTL` | `120` | Seconds, 1–600; authorization codes only |
| `LOGIN_FLOW_TTL` | `900` | Seconds (1–3600) a login flow stays usable: the login, consent and org-select steps, their cookies and sessions |
| `UI_BASE_URL` | `PUBLIC_URL` in production, `http://localhost:4000` otherwise | Login, consent and org-select redirects; the login client's `${UI_BASE_URL}/callback`. Must be `https://` in production |
| `UI_DIST_PATH` | `packages/tereo-ui/dist` | The admin UI's build, served at the root when present |
| `COOKIE_DOMAIN` | — | Shares core's cookies with every subdomain of this domain. Unset, they are host-only and, when Secure, `__Host-` cookies (path `/`, refused by the browser from another host or over http). Set, **every subdomain is trusted with them** — any of its pages can read the session indicator and overwrite the credential cookies — and the prefix is off |
| `COOKIE_SECURE` | `true` in production, `false` otherwise | `false` is refused in production |
| `TOTP_ISSUER` | `Tereo` | Shown in authenticator apps |
| `TOTP_VERIFICATION_TTL` | `300` | Seconds, 1–3600 |
| `TOTP_SETUP_TTL` | `600` | Seconds, 1–3600 |
| `PROFILE_PHOTO_MAX_SIZE_MB` | `5` | Above 0, at most 100 |
| `OIDC_ALLOW_PRIVATE_ISSUERS` | `false` | Lets an identity provider's issuer be private, loopback or plain `http` — tests and local development only. **Refused in production** |

### App services

| Variable | Default | Notes |
|----------|---------|-------|
| `REGISTRY_RETIREMENT_GRACE_HOURS` | `24` | 0–8760. How long an item may be missing from a declaration before it retires, and how long a service, login client or custom role dropped from the [provisioning documents](provisioning.md) lasts before it is deactivated, deleted or archived |
| `SERVICE_SECRET_OVERLAP_HOURS` | `24` | 0–8760. How long a replaced service secret keeps working |

### Files

| Variable | Default | Notes |
|----------|---------|-------|
| `FILE_SERVICE_STORAGE_PATH` | `./storage` | Blobs live under `blobs/` |
| `FILE_SERVICE_TEMP_PATH` | `./storage/temp` | multer spools single-request uploads here unencrypted while they are processed, so put it on an encrypted volume or a tmpfs. See [files.md](files.md#multipart-uploads) |
| `FILE_SERVICE_PUBLIC_BASE_URL` | `${PUBLIC_URL}/v1/files` | Base of presigned and share URLs; not localhost in production |
| `FILE_SERVICE_SHARE_UI_BASE_URL` | `UI_BASE_URL` | Where password-protected shares send browsers to unlock |
| `FILE_SERVICE_MAX_UPLOAD_SIZE_MB` | `100` | Above 0, at most 10240. Single-request uploads; larger files use multipart |
| `FILE_SERVICE_VERIFIED_READ_BUDGET_MB` | `256` | 16–65536. Plaintext all downloads together may hold in memory: a blob up to 16 MiB is decrypted and verified whole before it is sent, and waits for room in this budget. See [files.md](files.md#range-requests) |
| `FILE_SERVICE_VERIFIED_READ_WAIT_SECONDS` | `30` | 1–600. How long such a download waits for room before `503 temporarily_unavailable` |
| `FILE_SERVICE_MIN_PART_SIZE_MB` | `5` | Above 0, at most 5120 |
| `FILE_SERVICE_MAX_MULTIPART_PARTS` | `10000` | 1–100000 |
| `FILE_SERVICE_MAX_ACTIVE_MULTIPART_UPLOADS` | `100` | 1–100000. Multipart uploads one user may have in progress in a bucket |
| `FILE_SERVICE_MULTIPART_UPLOAD_TTL_HOURS` | `24` | 1–8760 |
| `FILE_SERVICE_PRESIGN_CLOCK_SKEW_SECONDS` | `30` | 0–3600 |
| `FILE_SERVICE_MAX_PRESIGN_TTL_SECONDS` | `604800` | 1–31536000 (365 d) |
| `FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS` | `300` | 0–2592000 (30 d) |
| `FILE_SERVICE_MAX_ARCHIVE_OBJECTS` | `10000` | 1–10000000 |
| `FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES` | 50 GiB | |
| `FILE_SERVICE_MAX_SHARE_TTL_SECONDS` | `31536000` | 1–315360000 (10 years) |
| `FILE_SERVICE_SHARE_SIGNED_URL_TTL_SECONDS` | `60` | 1–3600 |
| `FILE_SERVICE_SHARE_UNLOCK_MAX_ATTEMPTS` | `5` | 1–1000 |
| `FILE_SERVICE_SHARE_UNLOCK_WINDOW_SECONDS` | `900` | 1–86400 |
| `FILE_SERVICE_SHARE_DEFAULT_TOKEN_BYTES` | `18` | 12–48 |
| `FILE_SERVICE_SHARE_RETENTION_DAYS` | `30` | 0–3650. Before a revoked or expired share, or an expired archive request, is hard-deleted |
| `FILE_SERVICE_EMIT_SHARE_ACCESS_EVENTS` | `false` | One `share.accessed` event per download |
| `ACCESS_LOG_RETENTION_DAYS` | `90` | 1–3650. How long a `files.access_logs` row is kept before the daily sweep deletes it |
| `FILE_SERVICE_SWEEP_TIME_BOX_SECONDS` | `60` | 1–3600 |
| `FILE_SERVICE_SWEEP_HEARTBEAT_SECONDS` | `5` | 1–3600 |
| `FILE_SERVICE_DISK_RECONCILIATION_MAX_FILES_PER_SHARD` | `10000` | 1–10000000 |

### Webhooks, outbox and audit

| Variable | Default | Notes |
|----------|---------|-------|
| `WEBHOOK_SECRET_OVERLAP_HOURS` | `24` | 0–8760. How long a rotated-out endpoint secret still signs |
| `WEBHOOK_STALE_DELIVERY_SECONDS` | `300` | 1–86400. Before an untouched, never-attempted pending delivery is queued again (an attempted one waits 24h) |
| `AUDIT_RETENTION_DAYS` | `90` | 1–3650 |
| `PARTITION_DDL_LOCK_TIMEOUT_MS` | `5000` | 100–60000. How long creating or dropping a partition of the audit, webhook-delivery or notification tables waits for its table's lock before giving up until the next run |
| `OUTBOX_DEAD_LETTER_RETENTION_DAYS` | `30` | 1–3650. How long a dead-lettered `core.outbox` row is kept for `npm run cli -- outbox-replay` before the daily sweep deletes it. See [webhooks.md](webhooks.md#dead-letters) |

### Notifications

| Variable | Default | Notes |
|----------|---------|-------|
| `NOTIFICATIONS_ALLOW_PRIVATE_HOSTS` | `false` | Lets a connection target a private or loopback host (a local mail catcher). Development and tests only; core refuses to start with it set in production |
| `ALLOW_PLAINTEXT_SMTP` | `false` | Allows SMTP connections with `security: "none"`, which send mail and the password in the clear. Off, such a connection is refused on create and update (`400 invalid_settings`), a stored one is `400 invalid_settings` on test and accept, and its deliveries fail with `invalid_settings`. `docker-compose.yml`, `.env.example` and the test suite set it for a local mail catcher |

### Telemetry

The `OTEL_*` variables and `DEPLOY_ENV` are read by the OpenTelemetry setup, not the schema; see
[telemetry.md](telemetry.md#environment-variables).
