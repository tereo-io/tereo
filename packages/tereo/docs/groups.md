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
requirement of a role, the "last admin" checks, a role's list of holders and the notifications sent
when a role changes. Service access, integrations and the organization role editor stay direct-only
(service accounts cannot be members; the editor lists group roles separately).

A group role counts only when all of these hold:

- the role is active, not archived and not retired;
- the group is not archived;
- the user is active (as for direct roles);
- for an **organization group**: the user is still a member of the organization, and, for a check
  scoped to that organization, the organization is active and not archived. Only org-assignable
  permissions take effect, as for a direct org-scoped assignment.

The guest permission floor still applies to anything that reaches a guest.

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
A global group always needs the platform permission. A caller without it gets 403 for a missing group
as for one they may not see, so ids cannot be probed. An org admin cannot add or remove an
organization **owner** in the organization's groups (403); owners and the platform can.

The caller may only grant and take away what they hold, as elsewhere ([Granting](auth.md#granting-only-what-you-hold)):
adding members, restoring and changing roles check the caller can grant every role the group holds
or changes; removing members and archiving check they may disempower each affected user. The grant
check on add-members and restore counts **every** role the group holds, inactive or archived roles
included. The change may not remove the last admin (`assertAdminRemains`, counting group roles).

A group with a role that requires two-factor authentication revokes the password-only tokens of
users gaining it (new members, or all members when the role is added), so their next refresh meets
the step-up.

## API

All under `/v1/admin`. Lists are cursor-paginated (`limit` 1-100, default 50; `nextCursor`).

| Route | Purpose |
|---|---|
| `GET /groups` | List. Filters: `organizationId` (a UUID or `global`), `definitionSource`, `archived`, `q` |
| `POST /groups` | Create. Body: `slug`, `name`, `description?`, `organizationId?`, `roleIds?` (max 100). 201 |
| `GET /groups/:id` | Read, with `memberCount` |
| `PATCH /groups/:id` | Edit `slug`, `name`, `description`. Not on an archived group |
| `POST /groups/:id/archive`, `POST /groups/:id/restore` | Archive keeps members and roles |
| `GET /groups/:id/members` | `{ data: [{ userId, email, name, isActive, addedAt }], hasMore, nextCursor }` |
| `POST /groups/:id/members` | `{ userIds }` (1-500). Returns `{ added }`: users already in the group are skipped |
| `DELETE /groups/:id/members/:userId` | Remove. 204; 404 if not a member |
| `GET /groups/:id/roles` | The group's roles |
| `PUT /groups/:id/roles` | `{ roleIds }` replaces the set (max 100). Returns `{ roles, added, removed }` |
| `GET /users/:id/groups` | A user's groups, global and organization (`users.read`; `?includeArchived`) |
| `GET`/`PUT /users/:id/roles` | Return `{ roles, groupRoles }`: `roles` are the **direct** assignments (each `via: { kind: "direct" }`); `groupRoles` are the roles held through **global** groups, each with `group: { id, slug, name }` |

A **provisioned** group answers `409 managed_by_provisioning` to `PATCH`, role changes, archive and
restore. Its members stay editable (`membershipSource` is `local`).

Errors (`code`): `unknown_organization`, `unknown_role`, `unknown_user`, `role_not_org_assignable`,
`group_slug_taken` (409), `not_org_member`, `guest_not_allowed`, `service_account_not_allowed`,
`system_user_not_allowed` (409), `managed_by_provisioning` (409). Archived groups answer 409 to edits
and to adding members.

Every change runs in one transaction that locks the group, then the affected users, so concurrent
changes, and a member being added while their organization membership is removed, cannot interleave
into an inconsistent state.

## Events and audit

Audit entries use entity type `Group`, written in the mutation's transaction. Events go through
`core.outbox`. An organization group's events are emitted under its organization, a global group's
under the default organization. Readers need `groups.read` (`auth.group.*`).

| Event | `data` |
|---|---|
| `auth.group.created`, `updated`, `archived`, `restored` | `id`, `slug`, `name`, `organizationId`, `definitionSource`, `membershipSource`, `unprovisionedAt` |
| `auth.group.members-added`, `members-removed` | `groupId`, `organizationId`, `userIds`; one event per operation, in chunks of 1,000 ids |
| `auth.group.roles-changed` | `groupId`, `organizationId`, `roleIds`, `added`, `removed` |

A change to a group's roles emits no per-member `auth.user.roles-changed`. Every change that alters
effective roles does push a permission change to each affected member's open sessions
([WebSocket](auth.md)).

## Userinfo and the SDK

`/oauth/userinfo` returns `groups: [{ id, slug, name, organizationId }]`: the user's active global
groups plus those of the token's organization. It goes to the same callers as `roles`; for a
delegated token only with the `account` or `admin` area, otherwise the list is empty. It is never in
a token. Discovery lists `groups` in `claims_supported`. `groups` is an admin domain, so the
`core:admin` and `core:admin.read` ceilings cover `groups.*`.

`@tereo-io/sdk` offers `list`, `get`, `listMembers`, `listUserGroups`, `create`, `update`, `archive`,
`restore`, `addMembers`, `removeMember` and `setRoles` on the core client's groups, with the service
account's permissions. Its error codes for these requests start at `AS_0107`.

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
