# Groups

A **group** is a named set of users that carries roles. A user in a group holds the group's roles
wherever permissions are checked, exactly as if assigned directly; removing them takes the roles
away the same way. Groups are visible to app services (SDK, events, the userinfo `groups` claim)
and can be declared, with roles but without members, in [provisioning documents](provisioning.md#groups).

Admin API under `/v1/admin/groups`; in the admin UI under Groups, on a user's page (Groups, and each
role marked *direct* or *via group*) and on an organization's page (Groups tab).

## Model

Tables in the `auth` schema: `groups`, `group_members`, `group_roles`.

| Field | Notes |
|---|---|
| `organizationId` | Null = a **global** group; otherwise an **organization** group. Fixed once created. The organization must exist and not be archived (400 `unknown_organization`) |
| `slug` | `[a-z0-9-]`, 1-100. Unique within its scope (globally, or within the organization). An archived group keeps its slug, so a new group cannot reuse it (409 `group_slug_taken`) |
| `name`, `description` | max 255, max 500 (nullable) |
| `definitionSource` | `local` (made by an admin) or `provisioned` (made by a provisioning document) |
| `membershipSource` | `local` today; reserved for SCIM ([below](#scim-later)) |
| `unprovisionedAt` | Set while a provisioned group is missing from the documents |
| `archivedAt` | Groups are archived and restored, never deleted |

Members are users; `group_members` records who added them. Roles are held through `group_roles`.

### Who may be a member

- A **guest**, a **service account** (a service's or an integration's) and the **system user** never
  join a group: 409 `guest_not_allowed`, `service_account_not_allowed`, `system_user_not_allowed`.
- Members of an organization group must already be members of that organization: 409
  `not_org_member`. Nobody is added to the organization automatically.
- Removing a user from an organization also removes them from that organization's groups, in the
  same transaction, with an audit entry.
- A deactivated user keeps their memberships; they grant nothing, as direct roles do not.
- Adding members to an **archived** group is refused (409 `resource_archived`); restore it first.

### Which roles a group may hold

- A **global** group may hold any live role, custom or a service's system role.
- An **organization** group holds only **custom, org-assignable** roles. A system role is refused
  (403 `System roles cannot be assigned within an organization`), and a custom role with a
  permission that is not org-assignable is refused (400 `role_not_org_assignable`).
- Unknown, archived or retired roles are refused (400 `unknown_role`).

## How the roles reach permission checks

Group roles are resolved at read time and merged with the user's direct assignments, deduplicated by
role and organization. Nothing is copied into `user_roles`. Every place that reads a user's roles
counts both: permission checks, `roles` in userinfo and `GET /v1/account/me`, the two-factor
requirement of a role, the "last admin" checks, and the token revocations and notifications sent
when a role changes. Service access, integrations and the organization role editor stay direct-only
(service accounts cannot be members; the editor lists group roles separately), and a role's list of
holders (`GET /roles/:id/users`) lists the groups holding it apart from its direct holders.

A group role counts only when all of these hold:

- the role is active, not archived and not retired;
- the group is not archived;
- the user is active (as for direct roles);
- for an **organization group**: the user is still a member of the organization, and, for a check
  scoped to that organization, the organization is active and not archived. Only org-assignable
  permissions take effect, as for a direct org-scoped assignment.

The guest permission floor still applies to anything that reaches a guest.

An inactive organization is the one place the two differ: for a read scoped to it by id, the user's
direct roles in it still count (as before groups), while its groups' roles do not. Tokens naming the
organization are revoked when it is deactivated, so request-time checks rarely see it; the reads
that do are an admin with `organizations.write` acting on the inactive organization (what they hold
there bounds what they may grant or take away) and the delivery of a notification accepted before
the deactivation (its attachments are checked in the sender's organization). The `memberships` scope
(two-factor at sign-in) drops both kinds for an inactive organization, and the `anywhere` scope (who
may act on an account) keeps both.

An archived group grants nothing and is left out of claims, but keeps its members and roles so a
restore brings them back.

## Authorization

Core declares `groups.read`, `groups.write`, `groups.archive` and `groups.admin` (hierarchical:
`write` includes `read`, `archive` includes `write`, `admin` includes all; not org-assignable;
global roles only). A caller needs:

| Action | Permission |
|---|---|
| List, read, list members and roles | `groups.read` |
| Create, edit, add or remove members, set roles | `groups.write` |
| Archive, restore | `groups.archive` |

Without the permission, an **admin or owner of the group's organization** may do the same for that
organization's groups, including reading them (and listing them with `?organizationId=<their org>`).
So may a holder of the platform `organizations.write`, which covers every organization as it does on
the organization routes (`requireOrgRole`). A **deactivated** organization's admins and owners may
still read its groups, members and roles, but not change them; an **archived** organization's admins
no longer reach its groups. A delegated token acts as an org admin
only if its scopes allow `organizations.write`. A global group always needs `groups.<need>`;
`organizations.write` does not reach it.

A caller without the permission gets one and the same 403 (`The following permission is required:
groups.<need>`) for a missing group and for any group they may not act on (a global group, another
organization's, one where they are a plain member, a deactivated organization's for a change), so ids
cannot be probed. Adding members to an organization group checks organization membership first: an
id outside the organization is `409 not_org_member` whatever it names, so an org admin learns nothing
of users elsewhere.

An org admin cannot add or remove an organization **owner** in the organization's groups (403);
owners and the platform can. The platform means any holder of `groups.write` or `organizations.write`:
platform permissions come from global roles granted by platform admins and override the org tiers, as
`organizations.write` does for org roles, so a `groups.write` holder may change an owner's membership
of an org group (still only granting and taking away what they hold in that organization).

The caller may only grant and take away what they hold, as elsewhere ([Granting](auth.md#granting-only-what-you-hold)):
adding members, restoring and changing roles check the caller can grant every role the group holds
or changes; archiving checks they can take away every role the group holds. Removing members from a
**global** group checks they may disempower each removed user (hold every permission the user holds,
as for removing a global role); from an **organization** group, that they can take away the group's
roles with what they hold in that organization, as for removing an org-scoped role. The grant
check on add-members and restore counts **every** role the group holds, inactive or archived roles
included. Restoring an organization group is refused (`400 role_not_org_assignable`) if a role it
holds gained a permission that is not org-assignable while the group was archived; change the group's
roles first. The change may not remove the last admin (`assertAdminRemains`, counting group roles).

A group with a role that requires two-factor authentication revokes the password-only tokens of
users gaining it (new members, or all members when the role is added), so their next refresh meets
the step-up.

## API

All under `/v1/admin`. Lists are cursor-paginated (`limit` 1-100, default 50; `nextCursor`).

| Route | Purpose |
|---|---|
| `GET /groups` | List. Filters: `organizationId` (a UUID or `global`), `definitionSource`, `includeArchived` (archived groups are left out unless `true`), `q` |
| `POST /groups` | Create. Body: `slug`, `name`, `description?`, `organizationId?`, `roleIds?` (max 100). 201 |
| `GET /groups/:id` | Read, with `memberCount` |
| `PATCH /groups/:id` | Edit `slug`, `name`, `description`. Not on an archived group |
| `POST /groups/:id/archive`, `POST /groups/:id/restore` | Archive keeps members and roles |
| `GET /groups/:id/members` | `{ data: [{ userId, email, name, isActive, addedAt }], hasMore, nextCursor }` |
| `POST /groups/:id/members` | `{ userIds }` (1-500). Returns `{ added }`: users already in the group are skipped |
| `DELETE /groups/:id/members/:userId` | Remove. 204; 404 if not a member |
| `GET /groups/:id/roles` | The group's roles |
| `PUT /groups/:id/roles` | `{ roleIds }` replaces the set (max 100). Returns `{ roles, added, removed }` |
| `GET /roles/:id/users` | `{ roleId, users, groups }`: `users` are the role's **direct** holders (each `via: { kind: "direct" }`); `groups` are the unarchived groups holding it, each with `organization` and `memberCount` (list their members through `GET /groups/:id/members`) |
| `GET /users/:id/groups` | A user's groups, global and organization (`users.read`; `?includeArchived`) |
| `GET`/`PUT /organizations/:id/members/:userId/roles` | The same shape for one organization: `roles` are the member's **direct** roles there (each `via: { kind: "direct" }`); `groupRoles` the roles held through that **organization's** groups (not global ones'), each with `group`. They are listed only to a caller who may read the organization's groups (platform `groups.read`, an organization admin or owner, `organizations.write`) or who asks about themselves; anyone else gets an empty list. They are also empty while the organization is inactive or archived, as its groups' roles count for nothing then (`roles` still lists the direct ones). The role editor lists them apart; `PUT` replaces the direct ones only |
| `GET`/`PUT /users/:id/roles` | Return `{ roles, groupRoles }`: `roles` are the **direct** assignments (each `via: { kind: "direct" }`); `groupRoles` are the roles held through **global** groups, each with `group: { id, slug, name }` |

Bodies are strict: a key a route does not know is a 400, not ignored. Who may read or change an
inactive organization's groups is under [Authorization](#authorization).

A **provisioned** group answers `409 managed_by_provisioning` to `PATCH`, role changes, archive and
restore. Its members stay editable (`membershipSource` is `local`).

Errors (`code`): `unknown_organization`, `unknown_role`, `unknown_user`, `role_not_org_assignable`,
`group_slug_taken` (409), `not_org_member`, `guest_not_allowed`, `service_account_not_allowed`,
`system_user_not_allowed` (409), `managed_by_provisioning` (409), `already_archived` and
`not_archived` (409, archiving an archived group or restoring one that is not), and a conflict when
archiving or changing roles would leave no administrator. Archived groups answer 409
`resource_archived` to edits, role changes (also when archived while the request waited for the
group) and adding members.

Every change runs in one transaction that takes the affected users' authority locks first, then
locks the group, so concurrent changes, and a member being added while their organization membership
is removed, cannot interleave into an inconsistent state.

Lock order (the header of `utils/groups.ts` has the detail): the authority locks of the users whose
authority changes, ascending id (for role changes, archive and restore, every member); the group row;
for those group-wide changes, any member who joined in between; then organization owners and the
last-admin guard. A transaction changing several groups (provisioning's apply, and deleting a role
the groups hold) takes the authority locks of all their members first, ascending, then all the group
rows it may write, ascending id, before any group's last-admin guard. Provisioning archives dropped
groups one per transaction.

### Limits

Group-wide changes (setting roles, archive, restore) take one authority lock per member inside one
transaction. Very large groups (thousands of members) make those changes slow and can exhaust
Postgres's lock table (`max_locks_per_transaction` × `max_connections`). Provisioning skips a
group whose roles are unchanged, so an unchanged document takes no member locks at start.

## Events and audit

Audit entries use entity type `Group`, written in the mutation's transaction. Events go through
`core.outbox`. An organization group's events are emitted under its organization, a global group's
under the default organization. Readers need `groups.read` (`auth.group.*`), except that an
organization's admins and owners (and `organizations.write` holders) may subscribe to `auth.group.*`
in that organization and are sent its own groups' events, never a global group's or another
organization's ([webhooks](webhooks.md)).

| Event | `data` |
|---|---|
| `auth.group.created`, `updated`, `archived`, `restored` | `id`, `slug`, `name`, `organizationId`, `definitionSource`, `membershipSource`, `unprovisionedAt` |
| `auth.group.members-added`, `members-removed` | `groupId`, `organizationId`, `userIds`; one event per operation, in chunks of 1,000 ids |
| `auth.group.roles-changed` | `groupId`, `organizationId`, `roleIds`, `added`, `removed` |

Deleting a role (`DELETE /v1/admin/roles/:id`) takes it from every group holding it, archived ones
included: each gets the `roles_changed` audit entry (with `reason: "role_deleted"`) and the
`auth.group.roles-changed` event a role change would, with `removed` naming the role.

A change to a group's roles emits no per-member `auth.user.roles-changed`. Every change that alters
effective roles does push a permission change to each affected member's open sessions
([WebSocket](auth.md)).

## Userinfo and the SDK

`/oauth/userinfo` returns `groups: [{ id, slug, name, organizationId }]`: the user's active global
groups plus those of the token's organization while it is active and not archived and the user is
still a member of it (otherwise the global ones only, as `roles` leaves out its group roles too). It
goes to the UI, a service's client and a token with a core scope, as `roles` does; a delegated token
gets `groups` only with the `account` or `admin` area (an empty list otherwise) and an empty `roles`. It is never in
a token. Discovery lists `groups` in `claims_supported`. `groups` is an admin domain, so the
`core:admin` and `core:admin.read` ceilings cover `groups.*`.

`@tereo-io/sdk` offers the request functions `listGroups`, `getGroup`, `createGroup`, `updateGroup`,
`archiveGroup`, `restoreGroup`, `listGroupMembers`, `addGroupMembers`, `removeGroupMember`,
`listGroupRoles`, `setGroupRoles` (which replaces the whole set: read it with `listGroupRoles` first
to add or remove one role) and `listUserGroups` (`includeArchived` to include archived groups), sent
with the service account's permissions. They are reached
through the handler's `requests` once `createCoreClient()` has run
(`import { requests } from "@tereo-io/sdk/handler"`, then `requests.auth.listGroups(...)`); their
types (`Group`, `ListGroupsQuery`, …) come from `@tereo-io/sdk`. Their error codes start at
`AS_0107`.

## Provisioning

A document's `groups` section declares groups with roles and no members
([provisioning](provisioning.md#groups)). Core applies roles with the same two-factor revocation and
notifications as an admin change; the deploy is the authority, so the caller-grant checks do not
apply. A group dropped from the documents is marked (`unprovisionedAt`), archived after
`REGISTRY_RETIREMENT_GRACE_HOURS` with its members kept, and restored if it returns.

## SCIM (later)

Not built. SCIM Groups (Okta, Entra) are meant to slot in without reshaping this: add `scim` to the
two source enums, a `scim_group_links (connection_id, external_id, group_id)` table, and a `scim` mode
beside `admin` and `provisioning` in `utils/groups.ts`. A linked group's members become read-only in
the admin API (`409 managed_by_scim`); unlinking returns membership to `local`, keeping the members.
