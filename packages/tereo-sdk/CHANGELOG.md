## 0.5.2 (2026-11-13)

### 🚀 Features

- `CoreClient` carries `url`: core's base URL as the client reaches it (the `url` option, else `CORE_URL`), without a trailing slash. ([#59](https://github.com/tereo-io/tereo/pull/59))
- `core.auth.listUserGroups(userId, { includeArchived })` returns a user's groups and `core.auth.getGroup(id)` a group, each `null` when core answers 404 and otherwise rejecting with the `RequestError` (`httpStatus` set to core's answer). Neither is cached. In `testMode`, `listUserGroups` returns no groups and `getGroup` a stub for any id. ([#59](https://github.com/tereo-io/tereo/pull/59))

### 🩹 Fixes

- The SDK's cache commands (introspection, user, organization and file metadata caches) give up after one second and fall through to core, as on a Redis error. With the `maxRetriesPerRequest: null` the SDK asks for, ioredis holds a command while it reconnects until Redis is back, so during an outage a cache read held the request that made it. A Redis that answers within a second behaves as before. The README describes what else waits on Redis during an outage. ([#59](https://github.com/tereo-io/tereo/pull/59))
- The docs say how `req.auth` is typed in a project that imports `@modelcontextprotocol/express` itself, which declares `req.auth` as its own `AuthInfo`: read the context with `core.auth.validateUser(req)`, typed `AuthContext`, rather than casting. `@tereo-io/mcp` does not load that declaration and exports its own host and origin validation, so an app using it needs no such import. ([#59](https://github.com/tereo-io/tereo/pull/59))

### ❤️ Thank You

- Aaron Leman

## 0.5.1 (2026-11-13)

### 🚀 Features

- The SDK exports `authContextFromIntrospection`, which builds the `AuthContext` that `requireAuth` sets from an active introspection response, and `hasPermission`, the hierarchical permission check. ([#55](https://github.com/tereo-io/tereo/pull/55))
- `core.files.uploadObject` now takes a `Buffer` or a `Readable`, and switches to a multipart upload on its own above `multipartThresholdBytes` (64 MiB by default), sending parts concurrently and aborting the upload if anything fails. Tune it with `createCoreClient({ files: { multipartThresholdBytes, partSizeBytes, partConcurrency } })`. `initiateMultipart` and `completeMultipart` accept `ifMatch` and `ifNoneMatch`. `UploadObjectInput.file` is now `Buffer | Readable`, so code that reads `input.file` as a Buffer needs a type narrowing. ([#46](https://github.com/tereo-io/tereo/pull/46))
- `AuthServiceClient` gains `invalidateToken(token)`, `invalidateUser(...userIds)` and `invalidateOrganization(...ids)`, which drop the cached introspection result, user or organization for every replica of the service, so an app that learns of a revocation need not wait out the cache TTL. Defaults are unchanged; the README and `docs/auth.md` now state how stale each cache can be. ([#52](https://github.com/tereo-io/tereo/pull/52))

  `uploadObject` takes an optional `expectedSize` for a stream body, sent when the multipart upload is initiated; core now requires it in a bucket with a quota. The notification send types gain `sensitive`.

- The provisioning document types gain the `branding` block: `BrandingProvisioning` (`default` and per-client `clients`, keyed by `clientId`), `BrandingProfileProvisioning` (the text, `layout`, `footerLinks`, `applyToConsole` and image path slots, every one optional) and `BrandingColorVariable`, the list of colour variables a profile may set. `provisioning.schema.json` carries the block, limiting colour keys to those variables and footer link URLs to ones starting `https://` with no space or control character. The files types gain the bucket fields core now returns: `Bucket.coreManaged`, and `MyBucketPermissions.canRevokeShares`, `canPurgeVersions` and `coreManaged` (a core bucket is read-only through the files API, but for revoking and an admin's old-version purge); the test-mode mocks set them. ([#49](https://github.com/tereo-io/tereo/pull/49))
- Email verification in the SDK: users carry `emailVerified` and `emailVerifiedAt`, and `core.auth.users.sendVerificationEmail(id)` asks core to email a user a verification link (`409 already_verified`, `user_not_verifiable`, `email_not_configured`); `UsersClient` is exported from the package root. In `testMode`, `getUser` returns a verified user and `users.sendVerificationEmail` resolves without calling core. ([#51](https://github.com/tereo-io/tereo/pull/51))
- Group requests (`listGroups`, `getGroup`, `createGroup`, `updateGroup`, `archiveGroup`, `restoreGroup`, `listGroupMembers`, `addGroupMembers`, `removeGroupMember`, `setGroupRoles`, `listGroupRoles`, `listUserGroups`; lists take `includeArchived`) and their types, and `groups` in the provisioning document types. `AuthServiceUserRole` now carries `via`, and the user-roles response type `AuthServiceUserRolesResponse` has `groupRoles` (`AuthServiceUserGroupRole`) and `orgGroupRoles` (`AuthServiceUserOrgGroupRole`, with `organization`) beside `roles`. `listUserGroups` returns `UserGroup`s, each with its `organization` (null for a global group). ([#50](https://github.com/tereo-io/tereo/pull/50))
- `core.guests` invites a guest user (`invite`), extends one or renames it (`extend`), issues a password-setup link (`issuePasswordSetupLink`), reads one (`get`), lists them (`list`) and reads what an invitation may use (`options`: the guest-assignable roles, the defaults and the longest expiry). The provisioning document types gain `guestAssignable` on custom roles and the top-level `guests` section. `AuthServiceUser` now always carries `expiresAt` (`string | null`) and `status`, as core returns them for every user. ([#48](https://github.com/tereo-io/tereo/pull/48))
- Provisioning documents accept `rateLimitPerSecond` on `service` and on each of `integrations`, an integer from 1 to 100000 that replaces the account's default request limit; omitting it clears the value. The types and `provisioning.schema.json` carry it. ([#45](https://github.com/tereo-io/tereo/pull/45))
- `Group.definitionSource` and `membershipSource` (and the `definitionSource` filter of `ListGroupsQuery`) can be `"scim"`; `Group` gains `managedBy` and `skippedMemberCount` ([#57](https://github.com/tereo-io/tereo/pull/57))

### ❤️ Thank You

- Aaron Leman

## 0.5.0 (2026-11-02)

### 🩹 Fixes

- `provisioning.schema.json` matches core's again: provisioning webhook `events` are capped at 100 and ids are checked as GUIDs, as core has validated them since the server audit. ([#44](https://github.com/tereo-io/tereo/pull/44))

### ⚠️  Breaking Changes

- The audit outbox validates entries like core: `changes` and `metadata` up to 64 KiB, ids as GUIDs. Docs cover the new event and bucket-permission limits. ([#31](https://github.com/tereo-io/tereo/pull/31))

  Breaking changes:

  - `FileServiceHealth` no longer has `version`.

- `req.auth` carries the token's `clientId`, `scope` and `audience`; `requireScope(...scopes)` refuses a token missing any of them (`403 insufficient_scope`), and `auth.allowedClients` limits which clients' tokens `requireAuth` accepts. `oauthClientId` is deprecated in favour of `clientId`. ([#26](https://github.com/tereo-io/tereo/pull/26))

  Breaking changes:

  - `testMode` throws unless `NODE_ENV` is `test` or `development`.
  - `introspectionCacheTtlSeconds` must be between 0 and 300.
  - `AuthContext` gains required fields `clientId`, `scope` and `audience`; hand-built contexts must set them.

### ❤️ Thank You

- Aaron Leman

## 0.4.1 (2026-10-21)

### 🚀 Features

- `files.transferBucketOwnership(name, userId)` (`requests.files.transferBucketOwnership`) calls `PUT /v1/files/buckets/:name/owner`. `Bucket` gains `ownerId` and `owner`. `listObjects` takes `deleted: true` to list a versioned bucket's deleted objects. `ShareStatus` gains `creator_inactive`. A provisioning document's bucket `storageQuotaBytes` may be a digit string, capped at 1 TiB like the bucket API. Needs the `core` release with the bucket owner endpoint. ([#21](https://github.com/tereo-io/tereo/pull/21))

### ❤️ Thank You

- Aaron Leman

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