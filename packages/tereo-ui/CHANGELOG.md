## 0.8.1 (2026-11-13)

### 🚀 Features

- Core declares `group_resolver`, a role an app service may request in its provisioning document's `access.roles`. It grants `groups.read`: read-only, and global like the other resolver roles, so the service reads every group, global and in every organization. It can list and search them (archived ones too), read each group, its roles, its members with their names, emails and active flag, and its SCIM skipped members (names and emails), and its provisioned webhooks receive `auth.group.*` events (group fields, member user ids, role ids). It tells a missing group (404) from one that exists, which a service could not with `user_resolver` alone (403 for both). A provisioning set in which a service in a namespace named `group` declares a system role `group_resolver`, or a document defines a custom role of that name, now fails provisioning, since neither may share a name with one of core's roles. ([#59](https://github.com/tereo-io/tereo/pull/59))

### ❤️ Thank You

- Aaron Leman

## 0.8.0 (2026-11-13)

### 🚀 Features

- Client branding for sign-in pages. An admin brands `/login`, `/consent`, `/logout`, `/set-password` and the steps under `/login/*` per client, over an optional default profile and then stock Tereo, field by field: app name, headline, subtitle, sign-in label, notice, logo, dark logo, favicon, background image, `centered` or `split` layout, up to three `https:` footer links, and any of kosmeo's 51 `--k-*` colour variables for light and dark (a strict value grammar; nothing free-form reaches the page). Core injects the result into the app shell for the first paint — a `#tereo-branding` block that is always present on sign-in routes, `null` when unbranded — and `GET /oauth/branding?client_id=` serves the same value for a UI hosted apart. Images are stored once by content in the new `auth-service-branding` bucket (PNG, WebP, JPEG, SVG and ICO by slot, unsafe SVGs rejected, `BRANDING_IMAGE_MAX_SIZE_KB` and `BRANDING_BACKGROUND_MAX_SIZE_MB`), served from `/oauth/branding/assets/:file`, and unreferenced ones expire after 24 hours. New admin API under `/v1/admin/branding` (list, default, per-client profiles, grants, image upload), permissions `branding.read`, `branding.write` and `branding.admin`, and the events `auth.branding.updated`, `auth.branding.deleted`, `auth.branding.grant-added` and `auth.branding.grant-revoked`. A client's owner, or a user granted branding rights on it, may brand that client; the default and `tereo-ui`'s profile are `branding.admin`'s, and `tereo-ui` takes no grants. A provisioning document's `branding` block (default and per-client profiles, image paths inside `PROVISIONING_PATH`) is applied with the set and read-only through the API (`409 managed_by_provisioning` with `provisionedFrom`); removing it keeps the values and makes the profile editable. `applyToConsole` brands the admin console from `tereo-ui`'s profile, else the default, and the Branding page shows stock colours while open. The admin UI gains a Branding page with a live preview. ([#49](https://github.com/tereo-io/tereo/pull/49))
- Core's own buckets are read-only through the files API. `auth-service-user-photos` and `auth-service-branding` are written only by core's profile-photo and branding modules; through `/v1/files` every write — uploads (by key, signed URL, or presigning a write), object `PATCH` (including `deleteAfter`), object and version deletes, `bulk-delete`, `purge-non-current-versions` (except by `file-service.admin`), version restore, every multipart step, creating or editing a share, bucket update and delete, lifecycle changes, granting access and owner transfer — is now `409 bucket_managed_by_core`, `file-service.admin` included, after the usual permission check. Reads are unchanged, revoking a grant or a share still works, and `GET /buckets/:name/my-permissions` reports `canWrite` and `canDelete` false on these buckets. Since admins can no longer change them, every start resets each core bucket to its declared settings — policy, quota, versioning (only where no old versions exist; none are deleted, a warning is logged on each start while some remain, and a `file-service.admin` may purge them, after which the next start turns versioning off), auto-thumbnails, CORS, rate limit, lifecycle policy, and object `deleteAfter` on profile photos — keeping grants and shares. Bucket responses carry `coreManaged`, and `my-permissions` adds `coreManaged`, `canRevokeShares` and `canPurgeVersions`; the admin UI no longer offers sharing, share edits or new grants on these buckets, keeps share and grant revoke, and offers admins the old-version purge on a versioned one. ([#49](https://github.com/tereo-io/tereo/pull/49))
- Groups: a named set of users who all hold the group's roles. A global group's roles count everywhere; an organization's group's roles count only within that organization, for its members (custom, org-assignable roles only). Admins manage them under `/v1/admin/groups` (`groups.read`, `write`, `archive` and `admin`; an organization's admins and owners manage its own groups), provisioning documents declare them (`provisioned` groups change only there), and `GET /v1/admin/users/:id/groups` lists a user's. `GET` and `PUT /v1/admin/users/:id/roles` now return `{ roles, groupRoles, orgGroupRoles }`: `roles` are the direct assignments, each with `via: { kind: "direct" }`, `groupRoles` the roles held through global groups, and `orgGroupRoles` those held through organizations' groups, each with its `organization: { id, name }`. `GET /v1/admin/users/:id/groups` gives each group its `organization: { id, name }` (null for a global group). The OIDC userinfo response gains a `groups` claim (`id`, `slug`, `name`, `organizationId`: the global groups and the token's organization's) for core's UI and clients granted a core scope, and discovery lists it in `claims_supported`. The admin UI has a Groups page and shows groups on user and organization views. `GET /v1/admin/groups` and `GET /v1/admin/users/:id/groups` take `includeArchived`. `GET` and `PUT /v1/admin/organizations/:id/members/:userId/roles` return `groupRoles` too (the roles held through the organization's groups; empty unless the caller may read the organization's groups or asks about themselves, and while the organization is inactive or archived). `GET /v1/admin/roles/:id/users` now returns `{ roleId, users, groups }`: `users` are the direct holders only, and the groups holding the role are listed apart. Group request bodies are strict: an unknown key is a 400. An organization's admins and owners may subscribe to its `auth.group.*` events. Webhooks: before each send attempt, retries included, core checks again that the endpoint's creator may still receive the event; if not, the delivery is marked `FAILED` instead of sent (retry one is `403`). Deleting a role a group holds now writes that group's `roles_changed` audit entry (`reason: "role_deleted"`) and emits `auth.group.roles-changed` for it. ([#50](https://github.com/tereo-io/tereo/pull/50))

  The admin UI ships one stylesheet, so the sign-in pages are styled again (their component CSS had been bundled with the setup page only).

- Guest users: temporary logins for customers. A guest is an `auth.users` row with `userType = guest` and an `expiresAt` that is checked live on every sign-in and token path, a `member` of exactly one organization, and limited to org-scoped roles an admin or a provisioning document flagged `guestAssignable` (custom roles only) and, of core's permissions, to `file-service.objects.read` and `write`. `POST /v1/admin/guests` invites, extends and re-shares one account; `PATCH /v1/admin/guests/:id` changes the expiry; `POST /v1/admin/users/:id/promote` makes a guest a permanent user with the same id. A guest sets their first password from a one-time link (`/set-password`, token in the URL fragment, `POST /v1/password-setup`) or is created with a password they must change at first sign-in. New permissions `users.guests.read` and `users.guests.write`, the requestable role `guest_inviter`, a provisioning `guests.defaultRoles` section, `GUEST_MAX_TTL_SECONDS` and `PASSWORD_SETUP_TTL_SECONDS`, and the events `auth.guest.invited`, `auth.guest.extended`, `auth.guest.promoted`, `auth.user.password-setup-link-issued`, `auth.user.password-set` and `auth.role.guest-assignable-changed`. Notifications can be marked sensitive: their content is redacted from the admin log and a retry answers `409 content_redacted`. The guest endpoints reach only organizations the caller acts in (a member, or a service account whose client belongs to it) unless they hold `organizations.write` (`403 organization_not_permitted`; out-of-scope lookups are `404 not_a_guest`); `GET /v1/admin/guests/options` gives the invite form its roles and expiry cap without `roles.read`, and the admin UI has a Guests page for `users.guests.read`. Setup links and forced-change grants are retired on promotion, credential and email changes and deactivation; promotion needs a password the user chose (`409 password_not_user_set`); a new link for a guest who has a password needs the credential-reset rules (`403 guest_has_password`); for a user with TOTP the forced change comes after the second factor. ([#48](https://github.com/tereo-io/tereo/pull/48))
- Multipart uploads honour `If-Match` and `If-None-Match`. Initiate checks them early and answers `412` before creating an upload; complete enforces them authoritatively in the commit transaction, and a `412` there leaves the upload open until it is aborted or expires. ([#46](https://github.com/tereo-io/tereo/pull/46))
- SCIM 2.0 group push from identity providers: groups and their members follow the directory ([#57](https://github.com/tereo-io/tereo/pull/57))
- SCIM 2.0 user provisioning from identity providers ([#54](https://github.com/tereo-io/tereo/pull/54))
- Over-long request paths are refused first, with `414 uri_too_long`: a path over 8 KiB, counted in bytes as sent. Every route's longest legal path fits (an audit entity id or object key fully percent-encoded). The query string is not limited beyond Node's 200 KiB header limit. Trailing-slash trimming on request paths no longer takes time quadratic in a run of slashes, which an unauthenticated request could use to block the event loop. ([#49](https://github.com/tereo-io/tereo/pull/49))

### 🩹 Fixes

- File blob storage goes through one internal interface (`utils/blobStore`), with disk as its only implementation. Nothing changes for the API, the SDK, configuration or the files on disk. ([#53](https://github.com/tereo-io/tereo/pull/53))

### ⚠️  Breaking Changes

- Fixes from a security and correctness audit of auth, files, provisioning, webhooks and notifications. None needs a migration. ([#52](https://github.com/tereo-io/tereo/pull/52))

  **Authorization and admin.** A guest no longer passes the organization member-tier check: `GET /v1/admin/organizations/:id`, its members and a member's roles answer 403 for guests. Setting `guestAssignable: true` on a role is a grant and needs the caller to be able to grant every permission the role carries. `DELETE /v1/admin/roles/:id/users/:userId?organizationId=` applies the same take-away bound and archived-organization guard as the organization route. Changing a group's roles, archiving or restoring it respects the rule that an organization admin does not manage an owner's roles. Role permission changes, role deletion and identity-provider domain roles re-check their grant bounds under the row lock. Deactivating an identity provider is refused (409) when it would leave no administrator able to sign in, and once it commits a sweep ends the federated sessions and in-progress logins of users holding an identity at it (password sessions are kept; a user with identities at two providers loses the federated sessions from both). Creating an org-bound integration, turning `autoAccept` on for an identity-provider domain, or moving an auto-accept domain needs `organizations.write` or an admin or owner of that organization (`403 organization_not_permitted`). `POST /v1/admin/signing-keys/rotate` with `immediate: true` needs `admin` through a global role. The login client's `postLogoutRedirectUris` must stay on the `UI_BASE_URL` origin (409). Full core access goes only to a service client's `client_credentials` tokens, not to a user token issued to such a client. The admin UI's login client cannot lose a scope the UI requires.

  **OAuth and sign-in.** `/oauth/token` with `refresh_token_response_mode=cookie` applies the cookie origin rule and answers `403 access_denied` to other origins. `/oauth/authorize` and `/oauth/password-change` charge their failure limiters only for requests that carry a valid flow. Wrong current passwords on `POST /v1/account/password` count against the per-account sign-in backoff. The known-device TOTP allowance is refunded only by the attempt that spent it. Reactivating a user and unlinking a sign-in identity end the user's sessions. Code exchange and organization-bound `client_credentials` re-check the organization under the issuing lock. `/oauth/revoke` clears the refresh cookie only when it revoked that cookie's token. The token endpoint refuses a client whose service is inactive. The public link routes (`/v1/password-setup`, `/v1/email-verification`, their `inspect` routes and `/v1/password-reset`) answer 403 to a browser request from an origin that is not core's, the UI's or in `CORS_ALLOWED_ORIGINS`; requests without an `Origin` header are unaffected. The admin UI signs out rather than adopt a refreshed token for a different user.

  **Files.** UUIDs in path, query and body are lower-cased on validation, which fixes multipart parts staged under an upper-cased upload id never being cleaned up, the owner-removal lock and the admin verification-email limiter being keyed by letter case, and webhook secret rotation through an upper-cased id. A buffered download that the client stops reading is dropped after `FILE_SERVICE_VERIFIED_SEND_TIMEOUT_SECONDS` (new, default 120) and a ranged request holds only its range of the read budget. While a bucket's organization is deactivated or archived, share links, the signed URLs they mint and anonymous public-bucket reads answer 404; they serve again on reactivation. Rate-limited requests to `/v1/files/signed` and `/v1/files/shared` no longer write an access-log row. A share cannot pin a `versionId` in a non-versioned bucket (`400 versioning_disabled`). On the object list `filter[contentType]` works and `sort=sizeBytes` keeps its filters; a NUL character in a prefix, filter, metadata or tag is a 400; bulk-delete and archive prefixes escape LIKE wildcards; archive entry names no longer collide for a prefix without a trailing slash. A public bucket's version list shows uploader details only to grant holders. Blobs move across volumes when the temp path is on another filesystem. Multipart 404s are uniform, the thumbnail probe refuses SVG before parsing, multipart part and complete routes accept a trailing slash, and the token-less object routes match case-insensitively. In a bucket with a quota, initiating a multipart upload requires `expectedSize` (`400 expected_size_required`); parts no quota reservation bounds count against a cap per uploader across their uploads in progress, `FILE_SERVICE_MAX_STAGED_MULTIPART_BYTES_PER_USER` (new, default 100 GiB) or, for a service account, `FILE_SERVICE_MAX_STAGED_MULTIPART_BYTES_PER_SERVICE_ACCOUNT` (new, default 1 TiB), past which a part is `409 multipart_staged_bytes_exceeded`. An object stored with a JavaScript content type is downloaded as `text/plain; charset=utf-8`; its stored type and metadata are unchanged. A signed archive download whose client stops reading is aborted after the send timeout. A token-less request to a private bucket is no longer counted against the bucket's rate limit.

  **Provisioning and registry.** `npm run cli -- register-core --accept-older` applies the running release's declaration of core over a newer recorded one, for use after a rollback; a normal start still ignores an older declaration. An apply is refused when it would give `admin` to a role a hand-made integration holds, or leave no administrator; a retiring role that would do the latter is kept. Tokens are revoked in the transaction that narrows or removes the access. Row secrets that production cannot open report how to set them again.

  **Webhooks and notifications.** Changing an endpoint's `url` to another origin needs its custom header values supplied again (`400 masked_header_value` otherwise). A status-only PATCH on a provisioned endpoint may only set `ACTIVE`. The admin notification detail no longer returns `senderAccess`; delivery errors store the provider's reply or an error code, not the transport message; a notification whose organization is no longer active fails its attachment check. Dead-lettered outbox rows are logged without their payload. `POST /v1/notifications` accepts `sensitive: true`: content is redacted in the admin log, dropped once no delivery is pending and not retried from the log. `X-Organization-ID` on the webhook routes and `recipients[].userId` on a notification are lower-cased. The admin UI's endpoint form asks for custom header values again when the URL changes origin.

  **Pipeline and chart.** A malformed percent-escape in a path is `400 invalid_request`; errors that are not core's own no longer have their 5xx message returned. Redis commands on request paths give up after 2 seconds with `503 temporarily_unavailable` instead of hanging. An incoming `X-Request-ID` is kept only when the connection comes from a proxy `TRUST_PROXY` trusts; otherwise core generates the id. The chart gains an optional NetworkPolicy (`networkPolicy.enabled`, `networkPolicy.ingressFrom`), off by default.

  **Upgrading:** callers that relied on the old behaviour will see the new refusals above — in particular guests on the organization routes (403), cross-origin cookie-mode token requests (403), webhook endpoint origin changes without header values (400), share creation with `versionId` in a non-versioned bucket (400), shares or public buckets of an inactive organization (404), multipart initiates without `expectedSize` in a quota bucket (400; a stream of unknown size over the single-request limit cannot go to such a bucket), binding an integration or auto-accept domain as a plain organization member (403), and immediate key rotation without global `admin` (403). Pages on other origins that post to the public link routes need their origin in `CORS_ALLOWED_ORIGINS`. Services that sent their own `X-Request-ID` directly to core, not through a trusted proxy, now get core's generated id in logs and audit entries. Pages that loaded stored `.js` objects with `<script src>` no longer can. A new queue, `core-provider-deactivation-session-sweep`, runs on the worker. Clients slower than about 1 Mbit/s downloading a blob near 16 MiB are cut off at the default send timeout and can resume with `Range`; raise `FILE_SERVICE_VERIFIED_SEND_TIMEOUT_SECONDS` if that matters. Part files staged under an upper-cased upload id before this release remain under the storage path's `multipart/` directory and can be removed by hand.

- Password reset and email verification. `POST /v1/password-reset` (public, always `202` before any work is done so nothing about the account leaks through timing or errors; limited per hour to 10 requests per IP, 3 per address from one IP and 10 per address in all, every refusal a silent `202`) emails a one-time reset link (`PASSWORD_RESET_TTL_SECONDS`, 1 hour) that is redeemed on the existing `/v1/password-setup` routes, which now serve setup and reset links (the `auth.password_setup_tokens` table becomes `auth.user_link_tokens` with a `purpose`); `GET /v1/password-reset/status` tells the sign-in page whether it is enabled. Both link kinds are refused once the user's email domain is SSO-only, and a guest setup link is no longer issued for such an email (the invite with `initialAccess.type: "password_setup_link"` and `POST /v1/admin/guests/:id/password-setup-link` answer `409 sso_only_domain`; use `initialAccess.password`; re-inviting a guest already linked through the domain's forced link extends them and issues no link), and a redeemed reset also clears pending forced-password-change grants. Addresses now carry `email_verified_at` (existing human and guest accounts are marked verified by the migration): `email_verified` in userinfo, ID tokens and `/oauth/introspect` is real instead of always `true`, and users carry `emailVerified` and `emailVerifiedAt`. An address is proven by a verify link (`POST /v1/email-verification`, `EMAIL_VERIFICATION_TTL_SECONDS`, 3 days), a redeemed reset link, first-admin setup, or a provider that vouches for it on an ordinary linked sign-in, invite claim, autoAccept or account link (a forced SSO-required link does not verify); a redeemed setup link does not verify, since its URL is returned to the inviter. An admin changing a user's email unverifies it and sends a verify link (none for an inactive, expired or deactivated user, and the change succeeds without an email connection). `POST /v1/account/email-verification` and `POST /v1/admin/users/:id/email-verification` resend the link (409 `already_verified`, `user_not_verifiable` for service accounts, the system user, deactivated users and expired guests, `email_not_configured`; `429` past 1 per minute and 5 per hour per user for the first, 5 per hour per target user for the second). A redeemed reset clears the account's login backoff. New events `auth.user.password-reset-requested`, `auth.user.email-verification-sent` and `auth.user.email-verified`; `auth.user.password-set` gains `via`. The admin UI adds Forgot password, Verify email and verification status; core serves `/forgot-password` (with the sign-in's client) and `/verify-email` (the default profile) with sign-in branding injected. A finished reset does not resume the sign-in it was asked from (that may be on another device): a reset asked from another app says to go back to that app and sign in, with no way into the console, and one from the admin console offers a fresh sign-in. Fixed: the admin UI redirected signed-out visitors who opened `/set-password` (guest setup links) to `/`; `/set-password`, `/forgot-password` and `/verify-email` now open signed out. ([#51](https://github.com/tereo-io/tereo/pull/51))

  **Upgrading:** the migration renames `auth.password_setup_tokens` to `auth.user_link_tokens`, so during a rolling deploy pods still on the older image fail on their setup-link routes and in the hourly auth cleanup until replaced. Rolling the image back past this release needs the migration reversed first; the statements are in `packages/tereo/docs/auth.md` (Password links, "Rolling deploys and rollback"). Deployments without an email notification connection: users created after the upgrade (admin-created users, guests, and provider sign-ins whose provider does not vouch for the address), and existing users whose email an admin changes, stay `email_verified: false`, with no way to verify, until email is configured, and apps that require `email_verified` will reject them; admin-created users and guests get no verify email automatically either way.

- Request rate limits are configurable. `RATE_LIMIT_PER_SECOND`, `RATE_LIMIT_INTERNAL_PER_SECOND`, `RATE_LIMIT_PRE_AUTH_PER_SECOND` and `RATE_LIMIT_PRE_AUTH_INTERNAL_PER_SECOND` (and the chart's `rateLimits`) set the defaults, and a pre-auth value below its general counterpart stops core from starting. A person, service or integration can also carry its own `rateLimitPerSecond`, set in the admin API and UI, or in the provisioning document for provisioned ones; changes are audited and emitted as `auth.user.rate-limit-changed`. `GET /v1/admin/settings` reports the active limits, and `PATCH /v1/admin/settings` now answers 400 to an unknown key instead of ignoring it. ([#45](https://github.com/tereo-io/tereo/pull/45))

### ❤️ Thank You

- Aaron Leman

## 0.7.0 (2026-11-02)

### 🚀 Features

- Fixes for the open issues #27, #28, #30, #32, #33, #34 and #35. ([#40](https://github.com/tereo-io/tereo/pull/40), [#27](https://github.com/tereo-io/tereo/issues/27), [#28](https://github.com/tereo-io/tereo/issues/28), [#30](https://github.com/tereo-io/tereo/issues/30), [#32](https://github.com/tereo-io/tereo/issues/32), [#33](https://github.com/tereo-io/tereo/issues/33), [#34](https://github.com/tereo-io/tereo/issues/34), [#35](https://github.com/tereo-io/tereo/issues/35))

  - **Postgres pool settings (#27).** `DB_POOL_MAX` (default 20), `DB_POOL_MIN` (5) and `DB_POOL_CONNECTION_TIMEOUT_MS` (10000) size core's Postgres pool. A `connection_limit` in `DATABASE_URL` still has no effect.
  - **Readiness (#30).** `GET /health/ready`, also on the worker's health port, returns 200 while core serves and 503 `draining` once shutdown starts. It does not ping Postgres or Redis. The chart's readiness probe now uses it; the startup probe stays on `/health`. Point external load balancer health checks at it too. `/health` pings Postgres on a connection of its own, outside the request pool, which adds one connection per process.
  - **Managed users (#33).** `GET /v1/admin/users/{id}` returns `managedBy` (`{ kind: "system" }`, `{ kind: "service" | "integration", id, name }`, or `null`). The user page hides Edit, Manage Roles, the 2FA reset and identity invites for those accounts and says who manages them.
  - **Email port and security (#34).** Email connections refuse port 465 with `starttls` and port 587 with `tls`. A stored connection with either pair reads as `invalid_settings`, and its deliveries fail at once instead of retrying. The form's security follows the port until it is picked by hand, and warns about a mismatch. `GET /v1/admin/notifications/connections` gives each connection a `lastDeliveryError`, which the Connections list shows.
  - **Field-level validation errors (#32).** `invalid_request` errors list each failed check in `issues` (`{ path, message }`). The role form states the name rule and checks it before sending, and the organization form does the same for the slug. The role modals show core's refusal inside the modal instead of in a toast. Toasts now sit above modals.
  - **Narrow screens (#35).** At 768px and below, the top nav folds into a menu button and the section sidebar becomes a drawer that starts closed. The theme toggle and user menu stay in the top bar.
  - **Docs (#28).** `docs/integrations.md` has an "Order of creation" section for organizations, roles and integrations.


### 🩹 Fixes

- Dependency updates, with fixes for every advisory in core's runtime dependencies: multer 2.5 (a pending `fileFilter` after request teardown), body-parser 2.4 (trailing bytes after a compressed body), undici 6.29.1 (TLS options dropped by `Agent`, renegotiation and content-encoding denial of service), nodemailer 10.3.1 (address-parser recipient injection), follow-redirects, qs, fast-uri and systeminformation. OpenTelemetry moves to SDK 0.300 and resources 3. Installs resolve only versions published at least a day ago (`min-release-age=1` in `.npmrc`, npm 11.10 or later). ([#44](https://github.com/tereo-io/tereo/pull/44))
- Two concurrent first sign-ins of one subject through an invite (a double submit, or two tabs) both sign in. The one that looked up the invite after the other claimed it answered `no_account`. ([#44](https://github.com/tereo-io/tereo/pull/44))
- Admin UI on `@kosmeo-ui/react` 1.2.0 (#36). ([#41](https://github.com/tereo-io/tereo/pull/41), [#36](https://github.com/tereo-io/tereo/issues/36))

  - **List rows by keyboard.** A clickable list's primary cell is a real link or button, so keyboard and screen-reader users can open a record. Middle-click, open in new tab and copy link work on the links, and a link no longer navigates twice.
  - **Headings.** List pages have an `<h1>`.
  - **Lists load once.** List pages fetch once on load instead of twice.
  - **Forms.** Forms mark only the fields that fail, with a banner instead of a toast. The role name and organization slug are checked against core's rule before sending.
  - **Narrow screens.** Filter bars fold behind a "Filters" toggle.

- Admin UI's top bar and section layout now come from `@kosmeo-ui/react` (`AppTopBar`, `SectionLayout`, `useMediaQuery`), replacing tereo's own copies. ([#42](https://github.com/tereo-io/tereo/pull/42))

  - **Collapsed sidebar.** Collapsing a section's sidebar now shows its icons at full size, with the current page marked.
  - **Keyboard.** Escape on the narrow-screen menu or sidebar drawer returns focus to the button that opened it.
  - A sidebar collapsed before this release stays collapsed.

- Health probes are no longer traced. `/health` and `/health/ready` requests (any case, with or without a query) are skipped by the HTTP instrumentation, and their Prisma queries with them, so they no longer start traces. Load balancers and the kubelet probe every few seconds per pod, and those traces were most of an idle install's span volume. ([#43](https://github.com/tereo-io/tereo/pull/43))
- Admin UI polish (#37). Notification log entries (`GET /v1/admin/notifications` and `GET /v1/admin/notifications/{id}`) embed `sender` (`{ id, email, name }`) next to `senderUserId`, and the log shows the sender's name or email instead of a truncated ID. The log has order (newest or oldest first) and page-size controls, and its statuses are title case. Dates use one formatter app-wide (`Oct 22, 2026`, with the time on detail pages, and seconds in the audit log). Toasts follow the light or dark theme. The notification log and connections pages have an `<h1>`. ([#39](https://github.com/tereo-io/tereo/pull/39))

### ⚠️  Breaking Changes

- A triage of authentication. Cookie-authenticated `/oauth` requests are bound to their client: a page may use only the cookies of a client with a redirect URI at its origin (core's own origin and the admin UI's excepted), and credentialed CORS is sent only on the API, never on `GET /oauth/authorize` or the UI. Credential cookies use the `__Host-` prefix when Secure and `COOKIE_DOMAIN` is unset. Changes that open a new way into existing accounts — SSO-only domains and repointing a provider that has one — and relaxing the 2FA policy need a global `admin`; credential resets and reactivation of an organization owner or admin need `organizations.write`; tightening 2FA requirements revokes affected access tokens. An SSO-only domain's provider is the only way in, provider sign-ins forward `prompt=login`/`max_age` and use the provider's `auth_time`, and a forced link commits only after the second factor (migration `pending_identity_links`). Deactivated services and integrations can no longer authenticate at introspect, revoke or check-permission; `immediate` key rotation retires the old key at once; the plaintext refresh-token prefix is dropped (migration `drop_refresh_token_prefix`). Sign-out everywhere also ends account-page TOTP setups, pending links and unexchanged codes; login 2FA uses a 24-hour backoff; passwords use a self-describing scrypt format, rehashed at login; SSO sessions end after `USER_SESSION_IDLE_TTL` (default 3 days) without use (migration `user_session_idle`). `ISSUER` and production CORS origins are validated, and authorize errors after a valid `redirect_uri` redirect to the client. ([#26](https://github.com/tereo-io/tereo/pull/26))

  Breaking changes:

  - Every browser is signed out once (renamed cookies).
  - Cookie-mode refresh, login and consent from an origin outside the client's redirect URIs are refused, even when CORS-listed.
  - `/oauth/introspect` refuses public clients; discovery advertises `client_secret_basic` only.
  - Authorize errors are redirects to the client, not JSON 400s; `GET /oauth/end-session` with a hint and no `post_logout_redirect_uri` redirects.
  - Users at an SSO-only domain cannot sign in, link or claim invites through any other provider.
  - Integrations and other non-app-service accounts can no longer write audit entries, emit events or send notifications without an organization; audit `source` values of core or another service are refused (`422 source_reserved`).
  - Production refuses `http://` CORS origins other than loopback and a non-https or malformed `ISSUER`.

- An audit of the server and websocket. Sign-out everywhere (and password, TOTP and admin resets) also revokes the pre-refresh tokens of each ended login and closes their sockets; every node re-checks its sockets every `WEBSOCKET_REVALIDATE_INTERVAL_SECONDS` (default 60); sockets receive only the events their token reaches, the per-user cap is exact and pings are rate-limited. Token reuse, `/oauth/revoke`, end-session, repeated wrong passwords, TOTP setup starts, consents, registry retirement, the archive sweep, share expiry backfills, exhausted share unlocks and HTTP-emitted events are audited, and revocations run in their mutation's transaction. New event types `webhook.endpoint.*` (their `url`, like webhook audit entries', is the endpoint URL's origin only), `auth.identity-provider.domain-*` and `auth.user.identity-invite-*`; buckets without an organization (app-service buckets) emit file events to all-organizations endpoints and their service's endpoints. `DELETE` of a bucket grant or an organization member takes `revokeShares=true` to revoke that user's shares. Bodies are parsed after authentication (1 MB default), non-upload requests get 60s, unauthenticated `/v1/files` rejections write no access log, and access logs are kept for `ACCESS_LOG_RETENTION_DAYS` (default 90). New `HTTP_MAX_CONNECTIONS` and `SHUTDOWN_TIMEOUT_SECONDS` (migration `login_step_provider`). ([#31](https://github.com/tereo-io/tereo/pull/31))

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

### ❤️ Thank You

- Aaron Leman @aaron-leman0619
- Cameron Perera @cameronperera-vivo
- Garrett High @GarrettHighVIVO

## 0.6.1 (2026-10-21)

### 🩹 Fixes

- The admin UI's styles read `@kosmeo-ui/react`'s theme tokens by their `--k-` names. They used unprefixed names (`--primary-color`, `--text-color-light`, `--border-color` and others) that nothing defines, so the top bar, section sidebar, cards, borders and text fell back to browser defaults instead of the theme's colors. ([#24](https://github.com/tereo-io/tereo/pull/24))

### ❤️ Thank You

- Cameron Perera

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