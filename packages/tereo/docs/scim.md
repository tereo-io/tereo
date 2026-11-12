# SCIM

An identity provider (Okta, Entra) can create, update and deactivate core's users over SCIM 2.0, so
that removing someone in the directory ends their access in core, and can push groups and their
members, so that who is in a core group follows the directory ([Groups](#groups)). The admin routes
that configure a connection are in the OpenAPI spec (`openapi/`); the `/scim/v2` protocol endpoints
are documented here, not there.

## Model

One **SCIM connection** belongs to one identity provider (`auth.scim_connections`, `provider_id`
unique). It holds up to two live **tokens** (`auth.scim_tokens`) and one **link** per managed user
(`auth.scim_users`). A link existing is what "managed" means.

| Table | Holds |
|-------|-------|
| `scim_connections` | `provider_id`, `is_active`, `last_used_at` (updated at most once a minute), `created_by` |
| `scim_tokens` | SHA-256 `hash` of the token (the token itself is never stored), `created_by`, `last_used_at`, `revoked_at`. No expiry |
| `scim_users` | `connection_id`, `user_id` (unique: one connection manages a user), `external_id`, `user_name`, `user_name_key` (`user_name` lower-cased), `idp_active` (the IdP's last word on `active`), `admin_hold`, `deleted_at`, `unlinked_at` |

`external_id` is unique per connection where not null, and `user_name_key` is unique per
connection, so user names compare case-insensitively. Both stay reserved after a SCIM `DELETE`: an
IdP that re-creates the person with the same `externalId` (or `userName`) but a different email gets
`409 uniqueness` until an admin unlinks the old resource. Unlinking frees the `externalId` only:
the `userName` stays reserved by the unlinked row until an admin releases the user
([Unlink and release](#unlink-and-release)) or the connection is deleted. The SCIM `id` of a user is the core user
id. A row with `unlinked_at` set is not a link but an **exclusion** ([Unlink](#unlink-and-release)).

Lookups compare with plain equality on indexed columns: emails against `users.email` (stored
lower-cased, `users_email_lowercase`) after normalising the value, user names against
`user_name_key`. The domain rule is applied in code to the user found.

A connection also holds a **groups target** (`groups_target`, with `groups_organization_id` for an
organization) and one link per pushed group (`auth.scim_groups`, with `auth.scim_group_skipped_members`
for members core could not add): see [Groups](#groups).

A connection is configured in the admin API and UI on the provider, not in a provisioning document.
Deactivating the provider leaves its connection in place: SCIM calls answer `401` while the provider
or the connection is inactive.

## Admin routes

All under `/v1/admin/identity-providers/{id}/scim`. Reading needs `identity-providers.read`;
changing needs `identity-providers.write`.

| Route | Does |
|-------|------|
| `GET …/scim` | The connection: `baseUrl` (`${PUBLIC_URL}/scim/v2`), `isActive`, `lastUsedAt`, `managedUserCount` (deleted resources included, unlinked users not), and every token's `id`, `createdAt`, `lastUsedAt`, `revokedAt` (never its value). `404` when there is no connection |
| `PUT …/scim` `{ isActive, groupsTarget? }` | Creates the connection (`201`) or sets `isActive` and the [groups target](#groups-target) (`200`). `409 scim_connection_exists` if two creates race, `409 scim_groups_exist` for a target the linked groups forbid |
| `DELETE …/scim` | Removes it (`204`), with the exclusions of users unlinked from it, and makes its pushed groups local ([Delete and unlink](#delete-and-unlink)). `409 scim_users_exist` while it manages any user (including deleted resources: unlink them first) |
| `POST …/scim/tokens` | Mints a token (`201`, `{ id, token, createdAt }`); the value (`scim_…`) is in this response only. `409 scim_token_limit` at two unrevoked tokens |
| `DELETE …/scim/tokens/{tokenId}` | Revokes one (`204`). `404` if unknown or already revoked |
| `DELETE /v1/admin/users/{id}/scim` | Unlinks a user (`users.write`, `204`): see [Unlink and release](#unlink-and-release). `404` if not managed or already unlinked |
| `PUT /v1/admin/users/{id}/scim/release` | Ends an unlinked user's exclusion (`users.write` and global `admin`, `204`). `404` if the user has no exclusion |

Creating a connection, setting `isActive: true` and minting a token also need `admin` held through a
global role (`403` otherwise), on top of `identity-providers.write`: see [Trust](#trust). Switching a
connection off, revoking a token and deleting a connection do not. So do the provider changes listed
under [Trust](#trust), once the provider has a connection. Each change is audited
(`ScimConnection`, `ScimToken`; no new event types).

`GET` and `PUT …/scim` also return `groupsTarget` (`{ kind: "none" | "global" | "organization", organizationId? }`) and `managedGroupCount` (linked groups, archived ones included).

The admin user response's `managedBy` is `{ kind: "scim", id: <provider id>, name: <provider display
name> }` for a managed user. A link whose `deleted_at` is set still counts as managed, for `managedBy`,
`managedUserCount` and the guard below, until an admin unlinks the user. An unlinked user is not
managed; the response's `scimExcluded` is then `{ id: <provider id>, name: <provider display name> }`
(otherwise `null`).

## The `/scim/v2` endpoints

| Path | Methods |
|------|---------|
| `/scim/v2/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | `GET` |
| `/scim/v2/Users` | `GET` (list, `filter`, `startIndex`, `count`), `POST` |
| `/scim/v2/Users/{id}` | `GET`, `PUT`, `PATCH`, `DELETE` |
| `/scim/v2/Groups` | `GET` (list, `filter`, `startIndex`, `count`), `POST` |
| `/scim/v2/Groups/{id}` | `GET`, `PUT`, `PATCH`, `DELETE` |

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
| 400 | `invalidValue` | Validation, a value longer than its column (refused, never clipped), an email outside the provider's domains (but see [Create](#create-post)), an archived or inactive domain organization |
| 400 | `invalidFilter` | An unsupported filter |
| 400 | `invalidSyntax` | Invalid JSON, an unsupported PATCH `op` |
| 400 | `invalidPath` | PATCH `remove` without a path; a Groups PATCH path core does not support |
| 400 | `tooMany` | A Groups request over the [limits](#limits) |
| 401 | | See above |
| 403 | | Any `/Groups` request while the connection's groups target is `none` |
| 404 | | The user does not exist or is not visible to the connection; also an unknown path |
| 409 | `uniqueness` | See [Create](#create-post) |
| 409 | (none) | A deactivation the last-admin check refuses (`idp_active` is left unchanged, so the IdP's retry means the same thing), a Groups write whose member removal the last-admin check refuses, or a write that lost a race three times. None carries a `scimType` |
| 413, 429 | | Body too large, rate limited |

### Capabilities

`ServiceProviderConfig` declares `patch` supported; `filter` supported with `maxResults` 200; `bulk`,
`sort`, `etag` and `changePassword` not supported; authentication scheme `oauthbearertoken`.
`Schemas` and `ResourceTypes` are generated from one list of resource definitions (`utils/scim/resources.ts`)
so they cannot drift from what the routes accept. The enterprise-user extension is not supported.

### Filter

On Users: `eq` only, on `userName`, `externalId` and `emails.value` (also `emails[type eq "work"].value`),
optionally joined by `and`. Attribute names and the operator are case-insensitive. `userName` and
email values compare as literal text, case-insensitively: `%` and `_` are not wildcards. Anything
else answers `400 invalidFilter`. Without a filter the list holds only the connection's managed users
(live links); an unmanaged user in the provider's domains appears only through a filter. A
`userName` filter matches a managed user by their link's `userName`, and an unmanaged one by their
email (they have no `userName` yet).

### Pagination

`startIndex` (1-based, default 1) and `count` (default 100, at most 200), ordered by user id (group id on `/Groups`), with
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
`PUT` replaces the profile: a name attribute or `externalId` left out is cleared. `PATCH` changes
only what it names.

Quirks accepted from real clients: PATCH `op` in any case (`"Replace"`); booleans as strings
(`"False"`); a PATCH with a `path`, or with a value object and no `path`; `emails` as a path or a
list.

A PATCH writes the core email only from `emails` (a list: the primary, else the first),
`emails.value`, `emails[type eq "work"].value` or `emails[primary eq true].value`. Any other selector
(`emails[type eq "home"].value`, say) is ignored like an unknown attribute, so an Entra PATCH that
carries `active: "False"` and a personal address outside the provider's domains still deactivates the
user.

### Who a connection can see

- Human users the connection manages whose link has `deleted_at` and `unlinked_at` null.
- Unmanaged human users (no row at all) whose email domain is one of the provider's domains.

A managed user stays managed by the old connection when their domain leaves the provider, or moves
to another provider: the connection can still rename and deactivate them (an email change answers
`400 invalidValue`, the new address being outside its domains), and its provider's sign-in can still
claim them. Unlink them to end that.

Guests, service accounts, the system user, users managed by another connection, users an admin
unlinked and every account outside the provider's domains do not exist as far as SCIM can tell:
lookups return nothing and `GET`, `PUT`, `PATCH` and `DELETE /Users/{id}` answer `404`.

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
that address**, so SCIM gives no existence signal outside the provider's domains, with two
exceptions that concern the connection's own users: its live link with that email answers `409
uniqueness`, and its own deleted link is revived. A user the connection cannot see inside its
domains (a guest, a service account, one managed elsewhere, one an admin unlinked) answers `409
uniqueness` with one fixed body. If the domain's organization is archived or inactive, `400
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
| SCIM `DELETE` | As `active:false`, and `deleted_at` set; also audited as `scim_deleted`. The user also leaves the connection's pushed groups ([Delete and unlink](#delete-and-unlink)). `204`. The resource then answers `404` |
| SCIM `active:true` | `idp_active` true; reactivates unless `admin_hold`. The response reports the real `active` |
| Admin deactivates a managed user | `admin_hold` true; shared deactivation |
| Admin `isActive:false` on an already inactive managed user | Sets the hold too: a link-only write with a `scim_admin_hold` audit entry, no event, a no-op if already held |
| Admin reactivates a managed user | Allowed only when `idp_active` is true (else `409 managed_by_scim`: "reactivate them there", or, for a deleted resource, "re-assign them there or unlink them here"); clears `admin_hold` |
| Admin changes `email` or `name` of a managed user | `409 managed_by_scim` |

While a hold stands, an IdP `active:true` is recorded but does not reactivate. The shared
deactivation is the admin path's: the last-admin check, session and token revocation, link
retirement, audit, event. Users are never deleted. The admin route has no `firstName` / `lastName`
fields, and the account API has no profile-update route, so nothing else needs the guard.

### Unlink and release

`DELETE /v1/admin/users/{id}/scim` (`users.write`) ends SCIM's management of a user without
deleting anything: the row stays with `unlinked_at` set and `external_id` cleared, and the same
`scim_unlinked` audit entry is written. The user also leaves every group the connection pushed. The user keeps their state, inactive included, and is managed
locally: `managedBy` is `null`, no `managed_by_scim` refusals, no admin hold. Until released they are
**excluded from SCIM**: every connection answers `404` for them, filters do not return them, a `POST`
with their email answers the fixed `409 uniqueness` (`400 invalidValue` outside the provider's
domains, as for any address there), they are never adopted or revived, and sign-in never claims
them. The IdP's later writes (a profile push, or the deactivation it sends when the person is
unassigned) therefore cannot override the admin.

`PUT /v1/admin/users/{id}/scim/release` deletes the exclusion (`scim_released` audit entry). The
IdP's next write naming the user adopts them under the normal adoption rules, which gives the
provider's sign-in power over the account back, so it needs a global `admin` as enabling SCIM does.

## Groups

A connection can push groups and their members, so that who is in a core group follows the
directory. A pushed group is an ordinary core [group](groups.md) with `definitionSource` and
`membershipSource` both `scim`. SCIM never writes roles: a pushed group grants only the roles an admin
attaches to it, under the usual [grant checks](groups.md#authorization).

### Groups target

The connection's groups target says where pushed groups are created: `none` (the default), `global`,
or one organization. It is set with `groupsTarget` on `PUT …/scim`, also when the connection is
created. Setting it, including to `none`, needs `admin` through a global role, as enabling SCIM does,
and an organization target must be live (`400 unknown_organization`).

While the connection has linked groups, archived ones included, the target may only be `none` or the
scope those groups are in (they share one); anything else is `409 scim_groups_exist`. `none` freezes
them: they stay linked with their members unchanged, and every `/scim/v2/Groups` request answers
`403` (the Users endpoints are unaffected). Setting the target back to their scope resumes them.
`ResourceTypes` and `Schemas` list Group whatever the target.

### Ownership

| Change | Directory (SCIM) | Admin API |
|--------|------------------|-----------|
| `name` | Yes (`displayName`) | `409 managed_by_scim` |
| Members | Yes | `409 managed_by_scim` (add and remove) |
| Roles | Never | Yes, the usual rules |
| `slug`, `description` | Never | Yes |
| Archive, restore | `DELETE` archives; never restores | Yes, the usual rules |
| Unlink | No | Yes |

The directory owns a group's name, members and existence. An admin's `PATCH /v1/admin/groups/{id}`
can still change `slug` and `description`, but not `name`.

A pushed group never adopts an existing one: whatever its name, `POST /Groups` creates a new group
with no roles, so a clash with a local group's name touches nothing. Its `slug` is derived once from
the first `displayName`: lower-cased, runs of anything outside `[a-z0-9]` become `-`, trimmed of `-`
and cut to fit, `group` when nothing is left; then `-2`, `-3`, … until free in the target scope
(archived groups hold their slugs). A later rename in the directory changes `name` only, because apps
read the slug from the `groups` claim. A `displayName` is 1 to 255 characters after trimming and need
not be unique; an `externalId` is at most 255 (blank clears it).

The SCIM `id` of a group is the core group id. A connection sees a group only through its own link:
local groups, another connection's groups and malformed ids answer `404`. Archived pushed groups stay
visible, and the directory may still rename them and change their members, so a group is in sync when
an admin restores it. An archived group grants nothing.

### Who can be a member

A member value is a SCIM user id: the core user id.

| Value | Result |
|-------|--------|
| A managed user with a live link on this connection | Added |
| A managed user who is not a member of the target organization | Skipped and recorded (`not_org_member`) |
| A guest, a service account or the system user | Left out; not an error |
| An unknown or malformed id, or a user without a live link on this connection (another connection's, unlinked, SCIM-deleted) | Ignored |

Nobody is added to the organization automatically. The audit entry of a change counts what was
skipped and what was left out.

### Skipped members

A recorded skip is shown to admins (`skippedMemberCount` on every admin group response, and
`GET /v1/admin/groups/{id}/scim/skipped-members`, `{ data, limit, hasMore, nextCursor }`, each entry
`{ userId, email, name, reason, skippedAt }`; `nextCursor` is opaque, pass it back as `cursor`). A
user the directory pushed who is later removed from the target organization is recorded the same way,
so the difference from the directory stays visible.

Core does not add a skipped user when they join the organization. Recorded skips are retried on any
later request that changes the group's members, but only within what is left of the [limits](#limits)
after that request's own changes; the rest stay recorded. A skip is deleted when the user is added,
when the directory removes them (a `remove` naming them, or a `PUT` or `replace` without them), when
the user leaves the connection's groups, and when the group is unlinked.

### Resource

`schemas`, `id`, `externalId` (when set), `displayName`, `members` (`[{ value, display, $ref }]`,
`display` the user's name and `$ref` the user's SCIM URL) and `meta` (`resourceType: "Group"`,
`created`, `lastModified`, `location`). `members` lists only users actually in the group. It is in
`GET /Groups/{id}`, `POST`, `PUT` and `PATCH` responses, left out of the list, and left out of a
single read with `excludedAttributes=members`; other `attributes` and `excludedAttributes` values are
ignored. `meta.lastModified` moves on a name or member change.

### Endpoints

| Route | Does |
|-------|------|
| `GET /Groups` | `ListResponse`; `filter` is `displayName eq "…"` or `externalId eq "…"` (also joined by `and`; exact, `displayName` case-insensitive; anything else `400 invalidFilter`) |
| `POST /Groups` | `displayName` required; `externalId` and `members` optional. `201` with `Location` |
| `GET /Groups/{id}` | The group with its members |
| `PUT /Groups/{id}` | Replaces `displayName`, `externalId` and the whole member set |
| `PATCH /Groups/{id}` | The operations below, in one transaction. `200` with the resource |
| `DELETE /Groups/{id}` | See [Delete and unlink](#delete-and-unlink). `204` |

PATCH operation names are case-insensitive:

| `op` | `path` | `value` |
|------|--------|---------|
| `add` | `members` | `[{ value }]` |
| `remove` | `members` | `[{ value }]` (Entra), or none: clears the group |
| `remove` | `members[value eq "<id>"]` | none (Okta) |
| `replace` | `members` | `[{ value }]`: the whole set |
| `replace` or `add` | `displayName`, `externalId` | a string (`add` is accepted as `replace`) |
| `remove` | `externalId` | none: clears it (`displayName` cannot be removed) |
| `add` or `replace` | none | an object with any of `displayName`, `externalId`, `members` (`add` appends members, `replace` sets them) |

Any other path is `400 invalidPath`; a bad value `400 invalidValue`. Removing a user who is not a
member does nothing. A `path` may carry the `urn:…:Group:` schema prefix.

A request that changes nothing writes no audit entry, emits no event and does not move
`meta.lastModified`. A change of `externalId` alone is not audited. A removal that would leave core
with no administrator fails the whole request with `409`.

### Limits

- A group holds at most **5,000** members, and a request names at most 5,000.
- One request changes at most **1,000** memberships, counted on the de-duplicated difference it makes
  against the current members: a `PUT` naming 1,500 current members and 10 new ones is 10 changes. A
  `POST` with more than 1,000 members is refused.
- Over either limit the answer is `400` with `scimType: "tooMany"` and nothing is applied.

Each change takes one database authority lock, and the cap keeps one request well inside Postgres's
shared lock table. How Okta and Entra send a group with more than 1,000 members, in one request or in
batches, is not verified: see the checklists.

### Delete and unlink

- **SCIM `DELETE /Groups/{id}`** archives the group, deletes its link and skipped records, and makes
  it local: both sources become `local`, and an archived local group remains with its members and
  roles. The directory creating the group again makes a **new** group with no roles; nothing is
  revived, so roles never come back without an admin. An admin may restore the old group as a local
  one.
- **Admin unlink** (`DELETE /v1/admin/groups/{id}/scim`, `204`; `404` when the group is not pushed)
  makes the group local the same way but keeps its archive state. Audit `scim_unlinked`, event
  `auth.group.updated`. The directory cannot adopt a group, so its next push creates a new one.
- **Deleting the connection** unlinks every group it holds, in the same transaction.
- **A user leaves all of the connection's pushed groups**, archived ones included, when the directory
  deletes them (`DELETE /Users/{id}`) or an admin unlinks them
  (`DELETE /v1/admin/users/{id}/scim`): without this nobody could remove them, since an admin cannot
  edit a pushed group's members. Deactivation (`active: false`, or an admin hold) keeps memberships,
  which grant nothing while the user is inactive, as for every group.

### Audit and events

Entries are on entity `Group` with the system user as actor and `scimConnectionId` in the metadata.
Events are the existing `auth.group.*` ones; their `definitionSource` and `membershipSource` can now
be `scim`. A group-members entry is written only when someone is added or removed; a request that
only changes what is recorded as skipped writes a `members_skipped` entry.

## Sign-in linking

A managed user may have no identity at the provider yet, and sign-in never matches by email. So a
first provider sign-in **claims** the managed user (`claimScimUser` in
`utils/identityProviders/resolve.ts`), after the linked-identity check and before invites, when
exactly one row of the provider's connection matches:

1. **Entra `oid`**: the id token's `oid` equals the link's `external_id`. Only when the provider's
   issuer is exactly `https://login.microsoftonline.com/<tenant-guid>/v2.0`, the tenant GUID in lower
   case (`[0-9a-f-]{36}`); for any other issuer
   `oid` is ignored, since such an issuer could send any value. No verified-email claim is needed.
2. **Verified email**: the provider's email, trusted by the invite rule (`hd` included for Google),
   equals the managed user's email.

Conditions: the provider and connection are active, the link is neither deleted nor unlinked, and the
user has no identity at this provider. They are checked, and then checked again in the linking
transaction under the user's row lock (which SCIM writes and unlink take), so a deactivation, `DELETE`,
unlink or pause that commits in between links nothing. A user the provider's `ssoOnly` domain pins elsewhere gets
`sso_required`. Several matches claim none. A deactivated or expired user is refused and **not**
linked. An unverified email with no `oid` falls through to the existing answers (`no_account`, or
`email_unverified` on an auto-accept domain). A claim links the identity in one transaction, audited
with `via: "scim"` and `scimConnectionId`; sign-in then continues through TOTP, organization
selection and consent. See [auth.md](auth.md#no-matching-by-email).

## Trust

Enabling SCIM lets the provider sign in as any user it adopts in its domains, a platform admin
included: the same power `ssoOnly` grants. So creating or re-enabling a connection and minting a
token need `admin` through a global role (`assertMayGrantScim`) as well as
`identity-providers.write`.

Once a provider has a connection (active or not), the same power changes hands through the provider
itself, so these also need a global `admin` (`assertMayRedirectScim`, decided under the provider's
row lock):

- `PATCH /v1/admin/identity-providers/{id}` changing `issuer` or `clientId`, or sending a
  `clientSecret`: whoever runs the new issuer or client would sign in as the managed users;
- adding a domain, or changing a domain's `domain`: the connection adopts and signs in users there
  (deleting a domain does not need it);
- `POST …/activate`: an inactive provider is a paused connection, and resuming it is enabling it.

An issuer change is also refused (`409 provider_has_invites`) while the connection has a live link
whose user has no identity at the provider: like a pending invite, their first sign-in would claim
the account for whoever the new issuer vouches for. Treat a SCIM token like the provider's own credentials: two live tokens
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
2. Set the base URL to `baseUrl` and the unique identifier field to `userName`. Okta's guide lists
   `userName` as the "User ID" attribute a SCIM server must store and recommends keeping the user ID
   distinct from the email address
   ([Build a SCIM provisioning integration](https://developer.okta.com/docs/guides/scim-provisioning-integration-prepare/main/),
   read 2026-11-12). That is advice to the server; what value Okta itself sends as `userName` by
   default is **not verified against Okta's documentation** (its SCIM 2.0 reference examples send
   the email as both). Core accepts either, and wants an email in `userName` or in `emails`.
3. Okta checks whether a user exists with a `GET` filtered on `userName` before creating, which core
   supports (`userName eq "…"`). Okta stores the `id` core returns as the Okta user's external
   identifier.
4. Okta deactivates by setting `active` to `false`: a `PATCH` for new OIN integrations and a `PUT`
   for custom integrations built with the App Integration Wizard. Core handles both.
5. Enable create, update and deactivate; leave password sync off (core ignores it).
6. Test the connection; core's `ServiceProviderConfig` and a `GET /Users` must answer `200`.
7. To push groups, first set the connection's [groups target](#groups-target) (`groupsTarget` on
   `PUT …/scim`; with `none` every `/Groups` request answers `403`). Then in Okta enable group
   pushing for the app and push the groups you want. Core creates each as a new group with no roles;
   attach roles in the admin UI.
8. Push users before their groups: a member core has no link for yet is ignored, not recorded. If the
   target is an organization, the pushed users must be members of it, or they are
   [skipped](#skipped-members).

Not verified: the exact `externalId` Okta sends in a `POST`, and the full set of attributes in the
default Okta mapping; the documentation pages above do not state them. Record them in the manual run.

Not verified, for the manual run: how Okta sends a group with more than 1,000 members (one request
or batches; core refuses a request that changes more than 1,000), what `externalId` it sends for a
group, and whether it reads `members` back.

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
5. Map `userPrincipalName` to `userName`, `mail` to `emails[type eq "work"].value`, and
   `IsSoftDeleted` to `active`. Microsoft's tutorial shows these rows in its example tables of user
   attributes, which it calls "only a reference on how attributes in Microsoft Entra ID are often
   mapped"; that they are the default mapping of a non-gallery app is **not verified against
   Microsoft's documentation**, so check them in your tenant. Entra's `userName` is often a UPN,
   which core accepts when `emails` carries the address. Microsoft's page says matching attributes are set per mapping
   (**Match objects using this attribute**, with a precedence) and that the target must support
   filtering on them; core filters on `userName`, `externalId` and `emails.value`.
6. Microsoft's examples send PATCH `op` capitalized (`"Add"`, `"Replace"`), and Entra is known to send
   booleans as `"True"`/`"False"` strings (not verified in the pages above); core accepts both.
7. **Test connection**, set the scope (assigned users and groups), turn provisioning on.
8. The provider's issuer must be `https://login.microsoftonline.com/<tenant-guid>/v2.0` for `oid`
   claiming to apply.
9. To push groups, set the connection's [groups target](#groups-target) first (with `none` every
   `/Groups` request answers `403`). Under **Provisioning > Attribute Mapping**, enable the Groups
   mapping and add the groups to the application's scope. Core creates each as a new group with no
   roles; attach roles in the admin UI. Assign the users before their groups, and make them members of
   the target organization if the target is one ([Skipped members](#skipped-members)).

Not verified, for the manual run: how Entra sends a group with more than 1,000 members (one request
or batches; core refuses a request that changes more than 1,000), what `externalId` it sends for a
group (Microsoft's example maps `objectId` to it), and whether it reads `members` back.

Entra's scope setting is about assigned users. Microsoft documents that a user who is unassigned,
goes out of scope, or is soft-deleted or blocked from sign-in in Entra is disabled "via an update",
that for SCIM applications a disable "is a request to set the *active* property to false", and that
`IsSoftDeleted` in the mappings decides whether to send it; a hard-deleted user is sent a `DELETE`
([How provisioning works](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/how-provisioning-works),
read 2026-11-12).

## Quirks accepted and limits

- No bulk, sorting, ETags, nested groups, enterprise-user attributes, a `groups` attribute on the User resource or password handling. Groups are pushed only to a connection's own new groups: existing groups are never adopted.
- A user's SCIM `userName` and `externalId` are the IdP's; core never rewrites them.
- Test the real IdPs once before release: what each sends beyond the fixtures in
  `src/tests/fixtures/scim/` is recorded there.
