## 0.6.0 (2026-10-21)

### 🩹 Fixes

- Enabling two-factor authentication from the account page shows the recovery codes again. The page used to swap the enable button for the regenerate and disable buttons as soon as verification succeeded, which closed the dialog holding the codes before the user could see them. ([#22](https://github.com/tereo-io/tereo/pull/22))
- Archiving an organization or a role from its own page returns to the list again; the page header now keys its actions by the action rather than its position, so a button whose mutation removes the actions before it is no longer remounted mid-request. File Storage and Audit Log send a user without `file-service.buckets.read` or `audit-logs.read` to their account, as the other sections do, rather than showing an empty page. ([#22](https://github.com/tereo-io/tereo/pull/22))
- The admin UI uses `@kosmeo-ui/react` 1.0.1. Its bucket, object, permission, share and event-type lists pass a failed load's error on to the list, as the library's own lists do. Pressing Escape in a multi-select inside a dialog (such as a webhook endpoint's event types) now closes only the list, not the dialog and the form in it, and dialogs are announced by their title. ([#22](https://github.com/tereo-io/tereo/pull/22))

### ⚠️  Breaking Changes

- A triage of the file service. Bucket management follows an active grant: a bucket has an owner (`ownerId`, migration `bucket_owner`, backfilled from `createdBy`), who manages it only while holding a grant, and `PUT /v1/files/buckets/:name/owner` (`file-service.admin`) transfers it, emitting `file-service.bucket.owner-changed`. Presigned and archive URLs re-check their signer's access on every use, and a share stops serving once its creator is deactivated (`creator_inactive`). Removing an organization member revokes their grants on its buckets. Signed URLs answer HEAD without spending a capped share's nonce, spend it only once the body is ready, sign their filename, honour conditional requests and write access-log rows. Error responses drop download headers and are `no-store`. HEAD by key honours `versionId` and `thumbnail`; every download follows RFC 9110 preconditions; verified small-blob reads share a byte budget (`FILE_SERVICE_VERIFIED_READ_BUDGET_MB`, `FILE_SERVICE_VERIFIED_READ_WAIT_SECONDS`, `503` when busy); an archive lists unreadable blobs in `MISSING_FILES.txt` instead of aborting. Idempotency records commit with the upload; content-blob refcounts carry a `CHECK (ref_count >= 0)` and orphan cleanup refuses a blob still referenced; staged multipart parts are bound to their upload and part number (migration `files_write_integrity`; parts staged before the deploy still complete); quota counts active multipart reservations and refuses early. Lifecycle `purgeSoftDeletedAfterDays: 0` purges, version expiry counts from when a version was replaced (migration `object_version_noncurrent_since`), and a `bucket-cleanup-reconcile` job releases deleted buckets whose cleanup never ran. Buckets of a service dropped from provisioning become deletable. ([#21](https://github.com/tereo-io/tereo/pull/21))

  Breaking changes:

  - A bucket owner whose grant was revoked no longer manages the bucket and cannot re-grant it; only `file-service.admin` can.
  - Presigned and archive URLs stop working when their signer is deactivated or loses access; a `?filename=` not covered by the signature is ignored.
  - Setting `deleteAfter` takes delete access; managing shares on a public bucket takes a grant.
  - On a public bucket, callers without a grant no longer see deleted objects, non-current versions or `createdBy`.
  - Weak `If-Match` tags never match; `If-None-Match` with tags is honoured on PUT.
  - `file-service.objects.bulk-deleted` and `file-service.objects.versions.purged` fire once per batch, with `batchIndex` and no `truncated`.
  - A missing archive's signed URL is `403`, not `404`; the loser of racing bucket deletes or an update to a deleted bucket gets `404`; `requestCost > maxTokens` is `400`.
  - Part uploads racing a complete get `409 multipart_complete_in_progress`, after it `400 upload_not_active`; a part that fails its MD5 at complete is `422 part_integrity_mismatch`.

### ❤️ Thank You

- Aaron Leman
- Cameron Perera

## 0.5.0 (2026-10-19)

### ⚠️  Breaking Changes

- App services can read what core knows about them, and core is safer to run alongside others. `GET /v1/account/service` returns the calling service's row, the provisioning document's version and hash core last applied, when, and its access, with no permission needed. A service can read the audit entries it wrote (its slug as `source`, its account as writer) across every organization, through the new requestable core role `audit_reader` or the `audit_writer` it already holds. `REDIS_DB` selects the Redis database and `REDIS_KEY_PREFIX` prefixes every key, channel, BullMQ queue and socket.io key, so several cores can share one Redis; the chart gains `redis.db` and `redis.keyPrefix`, plus `provisioning.job.enabled` and `provisioning.job.annotations` to turn off or annotate the provisioning Job. Every process, whatever its `ROLE`, and the provisioning Job create today's and tomorrow's partitions before their first audited write, so a start or a Job no longer fails when they are missing. Client, role, service and integration responses show `unprovisionedAt`, and dropping one from the provisioning documents, or bringing it back, emits its update event carrying it. A client keeps the hashes of every secret it retired (migration `retired_secret_hashes`), and provisioning refuses any of them. Credential resets, deactivation, session revokes and direct grants or removals of a user's roles are serialized per user, so a concurrent grant of a stronger role to that user can no longer slip past an admin's check. Editing a role's permissions or restoring a role is not, so a change to a role the user already holds can still race it. ([#19](https://github.com/tereo-io/tereo/pull/19))

  Breaking changes:

  - A service's client may write only audit entries whose `source` is its own slug; any other is `422 source_mismatch`, naming the slug, and refuses the whole batch.
  - The slugs `core` and `tereo` are reserved for services and integrations, in provisioning documents and through the admin API.
  - Provisioning refuses any retired client secret, whether rotated away, revoked or replaced, for that client and every other. A deploy that reuses one fails at start; generate a fresh secret.
  - Client, role, service and integration responses, and their events, gain `unprovisionedAt`. `core.service.updated` always carries it, and dropping an integration or a custom role from the documents now emits `core.integration.updated` or `auth.role.updated`.
  - Some admin errors come in a different order: `DELETE /v1/admin/users/:id/sessions` naming a session that does not exist answers `404` before a `403`.

### ❤️ Thank You

- Aaron Leman

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