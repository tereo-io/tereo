## 0.4.0 (2026-10-16)

### 🚀 Features

- `PARTITION_DDL_LOCK_TIMEOUT_MS` (default `5000`, 100–60000) sets how long creating or dropping a partition of the audit, webhook-delivery or notification tables waits for its table's lock before giving up until the next run. It was fixed at 5 seconds, which stays the default. ([#17](https://github.com/tereo-io/tereo/pull/17))

### ⚠️  Breaking Changes

- Access tokens no longer carry a `permissions` claim. A token's size grew with every permission its holder's roles granted, so a broad role (57 permissions here) produced a token longer than `/oauth/introspect` and `/oauth/revoke` accepted, and the claim went stale the moment a role was revoked. Nothing in core, the SDK or the admin UI read it: core and introspection compute permissions live from the database on every request. `/oauth/introspect` and `/oauth/revoke` now accept tokens up to 8192 characters. ([#16](https://github.com/tereo-io/tereo/pull/16))

  Breaking changes:

  - A service that verifies core's access tokens itself (against the JWKS) and reads `permissions` from them gets none. Read them from `/oauth/introspect` (what the SDK's `requireAuth` already does) or ask `/oauth/check-permission`.

### ❤️ Thank You

- Aaron Leman

## 0.3.0 (2026-10-16)

### 🚀 Features

- Integrations, support access and a few gaps closed. An integration is a machine client for an external party (`/v1/admin/integrations`, an `integrations` section of a provisioning document), org-bound or platform, that holds roles, is audience-limited, and manages its own webhook endpoints. An event can be addressed to named services or integrations with `recipients` (up to 50 slugs; an unknown slug is `400 unknown_recipient`, or a dead letter from the outbox). A service's provisioning document can set `internalHost`, the one private address its own webhooks may reach; a provisioned login client can set `trustedCoreScopes` to skip consent for named core scopes. New core scopes `core:events` (the socket only) and `core:organizations` (with `GET /v1/account/organizations`), and a global-only permission `organizations.support-access`, held by roles that carry it and by root `admin`, lets its holders sign in into any active organization, audited and announced by `auth.organization.support-access`. Provisioning revokes a client's tokens when a role swaps one permission for another. ([#14](https://github.com/tereo-io/tereo/pull/14))

  Migration notes:

  - The migration adds `core.services.internal_host`, `auth.oauth_clients.trusted_core_scopes`, and the integrations model (`kind`, a nullable `namespace`, `organization_id`, two CHECK constraints). `integrations` becomes a reserved namespace.
  - `/v1/admin/services` lists app services only; integrations are under `/v1/admin/integrations`.
  - Webhook endpoint responses' `ownerService` gains `kind` (`service` or `integration`).
  - The 403 `insufficient_scope` message names the request path.

### ⚠️  Breaking Changes

- Declarative provisioning replaces service registration. A folder (or one file) of JSON provisioning documents declares each app service with its permissions, system roles, buckets, event types, access and webhook subscriptions, plus login clients and custom roles (with `requires2fa`). Core validates the whole set across documents, reports every problem naming its file, and applies it in one transaction at every start and with `npm run cli -- provision` (`--dry-run` writes nothing to the provisioned state; `provisioning-schema` prints the JSON Schema). Access listed in a document follows the role and is granted without an approval step; access removed from it is revoked, and an admin's revocation stays. Services can own webhook endpoints (`ownerService`, `provisioned`, all organizations with a null `organizationId`), and provisioned custom roles and endpoints are read-only through the admin API (`409 managed_by_provisioning`). The Helm chart renders the documents as a ConfigMap and runs `provision` as a post-install and post-upgrade Job. ([#12](https://github.com/tereo-io/tereo/pull/12))

  Breaking changes:

  - `PROVISIONING_FILE` (YAML) is now `PROVISIONING_PATH` (JSON file or directory of `*.json` files). An empty directory is an error.
  - Registration is removed: `POST /v1/registry/declaration` no longer exists, and neither does the `registry` scope area. Services stop calling the SDK's `register()`.
  - Helm: the `provisioning` value is now `provisioning.documents` (a map of file name to document) or `provisioning.existingConfigMap`; a provisioning change no longer rolls core's pods.
  - The admin UI's Access Requests page is removed, the `core.service.access-requested` event type is retired, and access requests left pending by registration are deleted by the migration.
  - Services that registered a declaration on 0.2.0 are adopted by the migration as provisioned. A service missing from the documents once provisioning runs is deactivated after `REGISTRY_RETIREMENT_GRACE_HOURS`.
  - A service's account does not hold its own permissions: a webhook on the service's own events needs a role in `access.roles` granting the event's read permission. Provisioned webhook URLs may not be `localhost` or a private or reserved IP literal.

  Migration checklist:

  1. Convert the YAML file to JSON documents (`{ "version": "…", "service": { … } }`, `clients`, `roles`) and set `PROVISIONING_PATH`; in Helm, move the `provisioning` value under `provisioning.documents`.
  2. Move each service's `register()` declaration into its document, with the same `slug`, `namespace` and `clientId`, and list the roles and audiences it requested under `access`. Every registered service needs a document, or it is deactivated after the grace period.
  3. Delete the `register()`, `isRegistered()`, `whenRegistered()` and `getRegistration()` calls from services.
  4. Run `npm run cli -- provision --dry-run` against the new documents before deploying; the CLI needs `REDIS_URL` as well as the database and the `secretFrom` variables.

### ❤️ Thank You

- Aaron Leman

## 0.2.1 (2026-10-15)

### 🩹 Fixes

- The admin UI uses `@kosmeo-ui/react` 0.2.0: WCAG AA contrast and accessible-name fixes throughout, and modals now also close when the backdrop is clicked, as well as on Escape. ([#10](https://github.com/tereo-io/tereo/pull/10))

### ❤️ Thank You

- Aaron Leman

## 0.2.0 (2026-10-15)

### 🚀 Features

- The Helm chart takes `service.annotations`, for sticky sessions when running more than one API pod (socket.io's long-polling fallback needs every request of a session on one pod). API pods get a `preStop` delay (`preStopSleepSeconds`, default 5) so the ingress stops routing to a pod before it shuts down, with the grace period extended by the same amount. ([#6](https://github.com/tereo-io/tereo/pull/6))

### 🩹 Fixes

- The admin UI uses the Tereo mark: its favicons (now including an SVG favicon), home-screen and touch icons, and the mark beside the name in the top bar. ([#8](https://github.com/tereo-io/tereo/pull/8))

### ⚠️  Breaking Changes

- Client secrets must now use the `tereo_sk_` format (core-generated ones switch to it, and secrets supplied by a deploy must pass its strength rules); app services can no longer request core admin roles (`admin`, `platform_admin`, `*_admin`), only the roles marked requestable, named bare (`core/<name>` is refused); and core's own login client and clients with `consentRequired: false` no longer show the consent screen after a password login, though a `consentRequired: false` client asking for any `core:*` scope always gets it. ([#7](https://github.com/tereo-io/tereo/pull/7))

  A deploy can declare its app services and login clients in a provisioning file (`PROVISIONING_FILE`, or the chart's `provisioning` value). Core applies it at every start, all or nothing, with secrets read from the environment and access pre-approved; its rows are read-only through the admin API (`409 managed_by_provisioning`), except that a service's secret overlap can still be ended early. Login clients gain an admin-set `audience` and a `consentRequired` flag, `SETUP_TOKEN` lets first-boot setup run unattended, and `npm run cli -- generate-secret` makes a secret in the new format.

### ❤️ Thank You

- Aaron Leman

## 0.1.1 (2026-10-15)

### 🩹 Fixes

- Linted with ESLint 10. An SMTP host that fails to resolve now keeps the resolver's error as the `cause` of the one core logs; the delivery still records only "The SMTP host did not resolve". ([#1](https://github.com/tereo-io/tereo/pull/1))
- A Helm chart, `oci://ghcr.io/tereo-io/charts/tereo`, released with the image at the same version. It reads Postgres, Redis and `CORE_KEK` from a Secret you provide or one External Secrets builds, runs migrations as a pre-install and pre-upgrade hook, and refuses to render a configuration core would refuse at start. ([#2](https://github.com/tereo-io/tereo/pull/2))
- OpenTelemetry moves to `sdk-node` 0.223 and `auto-instrumentations-node` 0.81, which clears every moderate `npm audit` finding. ([#1](https://github.com/tereo-io/tereo/pull/1))
- The Prisma CLI in the image uses `mysql2` 3.24 and `deepmerge-ts` 8 in place of the versions Prisma pins, which carry open advisories. `npm audit` reports no vulnerabilities. ([#1](https://github.com/tereo-io/tereo/pull/1))
- `sharp` moves to 0.35, which brings a libvips with fixes for CVE-2026-33327, CVE-2026-33328, CVE-2026-35590 and CVE-2026-35591, and `dotenv` to 18. ([#1](https://github.com/tereo-io/tereo/pull/1))
- Two concurrent first sign-ins with one email, through an invite or a domain, again end as one user and an `account_exists` for the other. Since Prisma 7.10 a unique violation names only its index, which the race handling did not read. ([#1](https://github.com/tereo-io/tereo/pull/1))
- Background jobs run on BullMQ 6 and `ioredis` 6. Stopping a worker while Redis is unreachable still drops BullMQ's blocking connection rather than leaving it reconnecting. ([#1](https://github.com/tereo-io/tereo/pull/1))
- Dependencies updated within their ranges, among them Prisma 7.10, `multer` 2.4, `undici` 6.29, `socket.io` 4.8.4 and Vite 8.3, which clears the `npm audit` findings those ranges could fix. ([#1](https://github.com/tereo-io/tereo/pull/1))

### ❤️ Thank You

- Aaron Leman