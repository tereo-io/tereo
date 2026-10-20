## 0.4.0 (2026-10-19)

### ⚠️  Breaking Changes

- `core.auth.getService()` (`requests.auth.getOwnService()`) returns this service as core knows it, from `GET /v1/account/service`: the provisioning document's version and hash core last applied, when, and its access, so a service can check at start that its deploy's document was applied. `auth.introspectionCacheTtlSeconds` bounds how long an active introspection is cached (default 60, `0` turns caching off). `createCoreClient({ channelPrefix })` takes core's `REDIS_KEY_PREFIX`, so the file cache hears a prefixed core's invalidations. `NotFoundError` is exported. The outbox dead-letters an audit entry whose `source` is not the service's slug at once (core's `422 source_mismatch`), and a row's `last_error` and retry warnings now carry core's status, error code and description. Needs the `core` release with `GET /v1/account/service`. ([#19](https://github.com/tereo-io/tereo/pull/19))

  Breaking changes:

  - `validateOrganization` throws `NotFoundError` (`404`) when the resource belongs to another organization, instead of a `403` that confirmed it exists.
  - `getServiceAccessToken` sends no scope unless given scopes. The old default, `openid`, was refused for service and integration clients, which hold none; pass it explicitly if a client needs it.

### ❤️ Thank You

- Aaron Leman

## 0.3.0 (2026-10-16)

### 🚀 Features

- `recipients` on `EmitEventParams` addresses an event to named services or integrations (`core.webhooks.emit`, `core.outbox.emit`), and the provisioning types gain `internalHost`, `trustedCoreScopes` and an `integrations` section (`IntegrationProvisioning`). Test tokens can name a client (`|client=<id>`), and `createCoreClient({ testServiceUserId })` makes the `service` test user a real UUID. Needs the `core` release with addressed events. ([#14](https://github.com/tereo-io/tereo/pull/14))

### ⚠️  Breaking Changes

- The SDK no longer registers services with core. `register()`, `isRegistered()`, `whenRegistered()` and `getRegistration()` are removed, along with registration's retry logic and its part in readiness. The SDK now exports the types of a provisioning document (`ProvisioningDocument`, `ServiceProvisioning`, and the rest) and its JSON Schema, so a service's build writes its own document with `JSON.stringify` from a typed object and the deploy hands it to core. ([#12](https://github.com/tereo-io/tereo/pull/12))

  Migration checklist:

  1. Move the declaration passed to `register()` into the service's provisioning document (`service.permissions`, `systemRoles`, `buckets`, `eventTypes`), and `requestedAccess` into `service.access`.
  2. Delete the `register()`, `isRegistered()`, `whenRegistered()` and `getRegistration()` calls. Calls to core are accepted as soon as the document is applied, and the outbox no longer waits for registration.
  3. Needs core with provisioning (the `core` release that removes `POST /v1/registry/declaration`).

### ❤️ Thank You

- Aaron Leman

## 0.2.0 (2026-10-15)

### 🩹 Fixes

- Dependencies updated within their ranges: `axios` 1.20, `zod` 4.6, `pino` 10.4, `express` 5.3 and `form-data` 4.0.6, among others. ([#1](https://github.com/tereo-io/tereo/pull/1))
- The package ships its TypeScript sources beside `dist/`, so its source maps and declaration maps resolve: a debugger steps into the SDK's own code, and an editor's go-to-definition opens it. ([#1](https://github.com/tereo-io/tereo/pull/1))

### ⚠️  Breaking Changes

- The SDK now uses `ioredis` 6. The `redis` client passed to `createCoreClient` must be an `ioredis` 6 client: upgrade the app's own `ioredis` to `^6.0.0`, which needs Node.js 20 or later. ([#1](https://github.com/tereo-io/tereo/pull/1))

### ❤️ Thank You

- Aaron Leman