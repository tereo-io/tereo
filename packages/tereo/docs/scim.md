# SCIM users

An identity provider (Okta, Entra) can create, update and deactivate core's users over SCIM 2.0, so
that removing someone in the directory ends their access in core. This page covers **Users** only;
SCIM Groups are not built (see [groups.md](groups.md#scim-later)). The admin routes that configure a
connection are in the OpenAPI spec (`openapi/`); the `/scim/v2` protocol endpoints are documented
here, not there.

## Model

One **SCIM connection** belongs to one identity provider (`auth.scim_connections`, `provider_id`
unique). It holds up to two live **tokens** (`auth.scim_tokens`) and one **link** per managed user
(`auth.scim_users`). A link existing is what "managed" means.

| Table | Holds |
|-------|-------|
| `scim_connections` | `provider_id`, `is_active`, `last_used_at` (updated at most once a minute), `created_by` |
| `scim_tokens` | SHA-256 `hash` of the token (the token itself is never stored), `created_by`, `last_used_at`, `revoked_at`. No expiry |
| `scim_users` | `connection_id`, `user_id` (unique: one connection manages a user), `external_id`, `user_name`, `idp_active` (the IdP's last word on `active`), `admin_hold`, `deleted_at` |

`external_id` is unique per connection where not null, and `user_name` is unique per connection,
compared case-insensitively. The SCIM `id` of a user is the core user id.

A connection is configured in the admin API and UI on the provider, not in a provisioning document.
Deactivating the provider leaves its connection in place: SCIM calls answer `401` while the provider
or the connection is inactive.

## Admin routes

All under `/v1/admin/identity-providers/{id}/scim`. Reading needs `identity-providers.read`;
changing needs `identity-providers.write`.

| Route | Does |
|-------|------|
| `GET …/scim` | The connection: `baseUrl` (`${PUBLIC_URL}/scim/v2`), `isActive`, `lastUsedAt`, `managedUserCount`, and every token's `id`, `createdAt`, `lastUsedAt`, `revokedAt` (never its value). `404` when there is no connection |
| `PUT …/scim` `{ isActive }` | Creates the connection (`201`) or sets `isActive` (`200`). `409 scim_connection_exists` if two creates race |
| `DELETE …/scim` | Removes it (`204`). `409 scim_users_exist` while it manages any user (including deleted resources: unlink them first) |
| `POST …/scim/tokens` | Mints a token (`201`, `{ id, token, createdAt }`); the value (`scim_…`) is in this response only. `409 scim_token_limit` at two unrevoked tokens |
| `DELETE …/scim/tokens/{tokenId}` | Revokes one (`204`). `404` if unknown or already revoked |
| `DELETE /v1/admin/users/{id}/scim` | Unlinks a user (`users.write`, `204`). The user keeps their state, inactive included, and is managed locally from then on. `404` if not managed |

Creating a connection, setting `isActive: true` and minting a token also need `admin` held through a
global role (`403` otherwise), on top of `identity-providers.write`: see [Trust](#trust). Switching a
connection off, revoking a token and deleting a connection do not. Each change is audited
(`ScimConnection`, `ScimToken`; no new event types).

The admin user response's `managedBy` is `{ kind: "scim", id: <provider id>, name: <provider display
name> }` for a managed user. A link whose `deleted_at` is set still counts as managed, for `managedBy`
and for the guard below, until an admin unlinks the user.

## The `/scim/v2` endpoints

| Path | Methods |
|------|---------|
| `/scim/v2/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | `GET` |
| `/scim/v2/Users` | `GET` (list, `filter`, `startIndex`, `count`), `POST` |
| `/scim/v2/Users/{id}` | `GET`, `PUT`, `PATCH`, `DELETE` |

`/scim` is a reserved prefix, so the admin UI never takes it.

### Authentication, limits, order

Send the connection's token as `Authorization: Bearer scim_…`. A missing, unknown or revoked token,
an inactive connection and an inactive provider all answer `401` with `WWW-Authenticate: Bearer`;
the discovery endpoints need it too. Calls act as the system user and every audit entry carries
`scimConnectionId` and `providerId`.

Middleware runs in this order: a per-IP pre-auth rate limit, token authentication, a per-connection
rate limit, then body parsing. Nothing is parsed before the token is known, so a bad body without a
valid token is a `401`. The per-connection limit uses the internal tier's value
(`RATE_LIMIT_INTERNAL_PER_SECOND`, default 1000 per second), sized for an initial sync; there is no
SCIM-specific variable. Bodies are `application/scim+json` or `application/json`, at most 1 MB.

### Errors

Errors are SCIM error bodies (`schemas`, `status`, `scimType`, `detail`) with
`application/scim+json`, not core's `{ error, error_description }` shape.

| Status | `scimType` | When |
|--------|-----------|------|
| 400 | `invalidValue` | Validation, a value longer than its column (refused, never clipped), an email outside the provider's domains, an archived or inactive domain organization |
| 400 | `invalidFilter` | An unsupported filter |
| 400 | `invalidSyntax` | Invalid JSON, an unsupported PATCH `op` |
| 400 | `invalidPath` | PATCH `remove` without a path |
| 401 | | See above |
| 404 | | The user does not exist or is not visible to the connection; also an unknown path |
| 409 | `uniqueness` | See [Create](#create-post) |
| 409 | | A deactivation the last-admin check refuses (`idp_active` is left unchanged, so the IdP's retry means the same thing), or a write that lost a race three times |
| 413, 429 | | Body too large, rate limited |

### Capabilities

`ServiceProviderConfig` declares `patch` supported; `filter` supported with `maxResults` 200; `bulk`,
`sort`, `etag` and `changePassword` not supported; authentication scheme `oauthbearertoken`.
`Schemas` and `ResourceTypes` are generated from one list of resource definitions (`utils/scim/resources.ts`)
so they cannot drift from what the routes accept. The enterprise-user extension is not supported.

### Filter

`eq` only, on `userName`, `externalId` and `emails.value` (also `emails[type eq "work"].value`),
optionally joined by `and`. Attribute names and the operator are case-insensitive. `userName` and
email values compare as literal text, case-insensitively: `%` and `_` are not wildcards. Anything
else answers `400 invalidFilter`. No filter lists every user the connection can see.

### Pagination

`startIndex` (1-based, default 1) and `count` (default 100, at most 200), ordered by user id, with
`totalResults`, `startIndex` and `itemsPerPage` in the `ListResponse`.

## The User resource

| SCIM | Core |
|------|------|
| `userName` | `scim_users.user_name`; also the email when no `emails` are given |
| primary `emails[].value` (else the first) | `users.email`, normalized |
| `name.givenName`, `name.familyName` | `first_name`, `last_name` |
| `displayName`, else `name.formatted`, else given + family | `name` |
| `active` | `idp_active`, then `is_active` ([below](#active-state)) |
| `externalId` | `external_id` |
| `meta` | `resourceType`, `created`, `lastModified`, `location` |

`password` and every other attribute, and unknown schemas, are accepted and ignored: SCIM never
accepts a password. A `userName` that is not an email (an Entra UPN, say) needs an `emails` entry.
`PUT` replaces the profile: a name attribute left out is cleared. `PATCH` changes only what it names.

Quirks accepted from real clients: PATCH `op` in any case (`"Replace"`); booleans as strings
(`"False"`); a PATCH with a `path`, or with a value object and no `path`; `emails` as a path,
a filtered path or a list.

### Who a connection can see

- Human users the connection manages whose link has `deleted_at` null. A managed user stays visible
  if their domain later leaves the provider, so the IdP can still deactivate them.
- Unmanaged human users whose email domain is one of the provider's domains.

Guests, service accounts, the system user, users managed by another connection and every account
outside the provider's domains do not exist as far as SCIM can tell: lookups return nothing and
`GET /Users/{id}` answers `404`.

### Create (`POST`)

In one transaction, by what already exists:

- **No account has the email**: the user is created without a password, added to the domain's
  organization as `member` with the domain's live default roles (whether or not the domain has
  `autoAccept`), with the same audit entries and events sign-in provisioning writes, and linked.
  `201`. The `User`, `OrganizationMember` and role audit entries all carry `scimConnectionId`.
- **An unmanaged, visible account has the email**: it is adopted and the body applied as a `PUT`.
  `201` with the existing user id.
- **This connection's own link for that user has `deleted_at` set**: it is revived (`deleted_at`
  cleared) and the body applied as a `PUT`; a body without `active` means active. `201`.
- **The connection already manages a live user with that `userName`, `externalId` or email**:
  `409 uniqueness`.

An email outside the provider's domains answers `400 invalidValue` **whether or not an account has
that address**, so SCIM gives no existence signal outside the provider's domains. A user the
connection cannot see inside its domains (a guest, a service account, one managed elsewhere) answers
`409 uniqueness` with one fixed body. If the domain's organization is archived or inactive, `400
invalidValue`.

### Adoption

The first write (`POST`, `PUT`, `PATCH` or `DELETE`) naming an unmanaged, visible user inserts the
link, with an `UPDATE` audit entry on the `User` (`action: "scim_adopted"`). `GET` and list never
write. Adoption changes nothing else: organization membership, roles, password and identities stay.
It re-checks the user's email under the user's row lock. `idp_active` starts as the user's
`is_active`; a user who is **inactive when adopted** was deactivated by an admin, so the link starts
with `admin_hold` true and the IdP's first sync does not bring them back.

### Update

An email change inside the provider's domains follows the admin path: uniqueness check
(`409 uniqueness`), `email_verified_at` cleared, outstanding identity invites and password and
verification links retired, a verification link issued when email is configured. Profile changes
write the usual `auth.user.updated` audit entry and event. A write that keeps losing a race with a
concurrent change to the same user is retried, and answers `409` after three attempts.

### Active state

`users.is_active` of a managed user is `idp_active AND NOT admin_hold`.

| Event | Effect |
|-------|--------|
| SCIM `active:false` | `idp_active` false; the shared deactivation runs if the user was active |
| SCIM `DELETE` | As `active:false`, and `deleted_at` set; also audited as `scim_deleted`. `204`. The resource then answers `404` |
| SCIM `active:true` | `idp_active` true; reactivates unless `admin_hold`. The response reports the real `active` |
| Admin deactivates a managed user | `admin_hold` true; shared deactivation |
| Admin `isActive:false` on an already inactive managed user | Sets the hold too: a link-only write with a `scim_admin_hold` audit entry, no event, a no-op if already held |
| Admin reactivates a managed user | Allowed only when `idp_active` is true (else `409 managed_by_scim`); clears `admin_hold` |
| Admin changes `email` or `name` of a managed user | `409 managed_by_scim` |

While a hold stands, an IdP `active:true` is recorded but does not reactivate. The shared
deactivation is the admin path's: the last-admin check, session and token revocation, link
retirement, audit, event. Users are never deleted. The admin route has no `firstName` / `lastName`
fields, and the account API has no profile-update route, so nothing else needs the guard.

## Sign-in linking

A managed user may have no identity at the provider yet, and sign-in never matches by email. So a
first provider sign-in **claims** the managed user (`claimScimUser` in
`utils/identityProviders/resolve.ts`), after the linked-identity check and before invites, when
exactly one row of the provider's connection matches:

1. **Entra `oid`**: the id token's `oid` equals the link's `external_id`. Only when the provider's
   issuer is exactly `https://login.microsoftonline.com/<tenant-guid>/v2.0`; for any other issuer
   `oid` is ignored, since such an issuer could send any value. No verified-email claim is needed.
2. **Verified email**: the provider's email, trusted by the invite rule (`hd` included for Google),
   equals the managed user's email.

Conditions: the provider and connection are active, the link is not deleted, and the user has no
identity at this provider. A user the provider's `ssoOnly` domain pins elsewhere gets
`sso_required`. Several matches claim none. A deactivated or expired user is refused and **not**
linked. An unverified email with no `oid` falls through to the existing answers (`no_account`, or
`email_unverified` on an auto-accept domain). A claim links the identity in one transaction, audited
with `via: "scim"` and `scimConnectionId`; sign-in then continues through TOTP, organization
selection and consent. See [auth.md](auth.md#no-matching-by-email).

## Trust

Enabling SCIM lets the provider sign in as any user it adopts in its domains, a platform admin
included: the same power `ssoOnly` grants. So creating or re-enabling a connection and minting a
token need `admin` through a global role (`assertMayGrantScim`) as well as
`identity-providers.write`. Treat a SCIM token like the provider's own credentials: two live tokens
at most, revoke one when it may have leaked, and only add domains to a provider whose directory you
control.

## Setup checklists

Create the connection first: `PUT /v1/admin/identity-providers/{id}/scim` with `{ "isActive": true }`
(or the SCIM panel on the provider page), then `POST …/scim/tokens` and copy the token. The provider
needs its domains set. **Tenant / base URL** is the connection's `baseUrl`, `${PUBLIC_URL}/scim/v2`.

### Okta

Verified against Okta's documentation:
[Build a SCIM provisioning integration](https://developer.okta.com/docs/guides/scim-provisioning-integration-prepare/main/)
and the [SCIM 2.0 reference](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/)
(read 2026-11-12).

1. Add a SCIM 2.0 app integration in Okta, enable provisioning, and use the HTTP header
   authentication mode with the token as the credential. Okta lists the supported modes as OAuth 2.0
   authorization code, basic authentication and an HTTP authorization header.
2. Set the base URL to `baseUrl` and the unique identifier field to `userName`. Okta documents that
   it stores the user ID as `userName` and keeps it distinct from the email; core wants an email
   either as `userName` or in `emails`.
3. Okta checks whether a user exists with a `GET` filtered on `userName` before creating, which core
   supports (`userName eq "…"`). Okta stores the `id` core returns as the Okta user's external
   identifier.
4. Okta deactivates by setting `active` to `false`: a `PATCH` for new OIN integrations and a `PUT`
   for custom integrations built with the App Integration Wizard. Core handles both.
5. Enable create, update and deactivate; leave password sync off (core ignores it).
6. Test the connection; core's `ServiceProviderConfig` and a `GET /Users` must answer `200`.

Not verified: the exact `externalId` Okta sends in a `POST`, and the full set of attributes in the
default Okta mapping; the documentation pages above do not state them. Record them in the manual run.

### Entra

Sources:
[Develop and plan provisioning for a SCIM endpoint](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups)
and [Customize attribute mappings](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/customize-application-attributes)
(read 2026-11-12).

1. In Enterprise apps, create a **non-gallery** application, open **Provisioning**, set the mode to
   automatic, enter the **Tenant URL** (`baseUrl`) and the token as the **Secret Token**. Entra
   documents the Secret Token as the long-lived bearer token for endpoints that do not take an Entra
   token.
2. Under **Provisioning > Attribute Mapping**, open the Users mapping.
3. **externalId.** Microsoft's tutorial shows `mailNickname` mapped to `externalId` in its example
   table of user attributes, and builds its sample matching query on `externalId` equal to the
   user's `mailNickname`. The pages say that example "is an example only" and that the matching
   attribute "is configurable"; they do not say this is the default mapping of a custom
   (non-gallery) app. **Check the Source Attribute of the `externalId` row in your tenant.**
4. **Map `externalId` to `objectId`.** In the same table, select the pencil on the `externalId` row
   and set the source attribute to `objectId` (mapping type Direct). Microsoft's page describes
   editing a mapping this way (pencil icon, Edit Attribute screen) but gives no `objectId` recipe:
   that this makes Entra send the user's object id is **not verified against Microsoft's
   documentation**, only inferred from its group example (`objectId` to `externalId`). Without this
   mapping the `oid` claim at sign-in matches nothing and Entra users are claimed only by a verified
   email, which needs the provider to send one (see [auth.md](auth.md#no-matching-by-email)).
5. Keep `userPrincipalName` mapped to `userName`, `mail` to `emails[type eq "work"].value`, and
   `IsSoftDeleted` to `active`. Entra's `userName` is often a UPN, which core accepts when `emails`
   carries the address. Microsoft's page says matching attributes are set per mapping
   (**Match objects using this attribute**, with a precedence) and that the target must support
   filtering on them; core filters on `userName`, `externalId` and `emails.value`.
6. Microsoft's examples send PATCH `op` capitalized (`"Add"`, `"Replace"`), and Entra is known to send
   booleans as `"True"`/`"False"` strings (not verified in the pages above); core accepts both.
7. **Test connection**, set the scope (assigned users and groups), turn provisioning on.
8. The provider's issuer must be `https://login.microsoftonline.com/<tenant-guid>/v2.0` for `oid`
   claiming to apply.

Entra's scope setting is about assigned users; a user falling out of scope is sent as `active:false`
(Microsoft documents `IsSoftDeleted` becoming true for unassigned or out-of-scope users).

## Quirks accepted and limits

- No Groups, bulk, sorting, ETags, enterprise-user attributes or password handling.
- A user's SCIM `userName` and `externalId` are the IdP's; core never rewrites them.
- Test the real IdPs once before release: what each sends beyond the fixtures in
  `src/tests/fixtures/scim/` is recorded there.
