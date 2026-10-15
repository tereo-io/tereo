# Services and registration

An app service — a billing service, a reporting service — reaches core with one OAuth client, and tells
core on every start what it owns. Core does the same for itself, in-process.

## Adding a service

An admin with `services.write` adds it:

```http
POST /v1/admin/services
{ "name": "Product Service" }
```

```jsonc
// 201
{
  "id": "…", "slug": "product-service", "namespace": "product",
  "credentials": { "clientId": "…", "clientSecret": "…" }   // shown once, stored hashed
}
```

- `slug` defaults to the name, hyphenated; `namespace` to the slug without `-service`. Both can be
  given. A namespace may not equal or hyphen-extend another service's, nor one core reserves
  (`users`, `roles`, `file-service`, `webhooks`, `auth`, … — `definitions/coreService.ts`): `409`.
  Nor may it be the prefix of a live bucket an admin created (`<namespace>-…`, owned by no service),
  which the service could never declare: `409` naming the buckets. A deleted bucket frees its name, so
  it blocks neither the namespace nor a declaration of that name. Namespace claims and bucket creation
  share a lock, so the two can't race.
- The service gets a confidential client (`client_credentials` only) and a service-account user it
  acts as. `/v1/admin/clients` makes login clients only and refuses to touch a service's client.
- Configure the service with `CORE_URL`, `CORE_CLIENT_ID`, `CORE_CLIENT_SECRET`.

| Route | Permission | Does |
|-------|------------|------|
| `GET /v1/admin/services` | `services.read` | List; each row carries `pendingAccessCount` |
| `GET /v1/admin/services/access` | `services.read` | Access requests across every service, each with its `service` (`id`, `slug`, `name`) — the approval inbox. Filter `status`, `kind`, `serviceId`, `target` (`?filter[status]=pending`); sort `requestedAt` (default, newest first) or `id` |
| `GET /v1/admin/services/:id` | `services.read` | One service with everything it declared (retired included), its access requests, and `settings` |
| `PATCH /v1/admin/services/:id` `{ name?, isActive? }` | `services.write` | Rename; deactivate (its tokens stop at once) or reactivate |
| `POST /v1/admin/services/:id/regenerate-secret` | `services.write` | New secret, shown once. The old one keeps working for `SERVICE_SECRET_OVERLAP_HOURS` (24) |
| `POST /v1/admin/services/:id/revoke-previous-secret` | `services.write` | End that overlap now |
| `POST /v1/admin/services/:id/access/approve` `{ ids }` | `services.approve` | Grant requested roles and audiences |
| `POST /v1/admin/services/:id/access/revoke` `{ ids }` | `services.approve` | Take them away; the service's tokens are revoked |

Services are never deleted. Core's own row is not managed through this API.

Access rows, on the detail and in the list, name who last decided them: `decidedBy` (the user id) plus
`decider` (`{ id, email, name }`), `decidedByEmail` and `decidedByName`, all `null` until the first
decision. A request for another service's role also carries `approvedPermissions` and
`pendingPermissions` ([below](#another-services-role)); both are `null` on other rows. The detail's `settings` states
`secretOverlapHours` (`SERVICE_SECRET_OVERLAP_HOURS`) and `retirementGraceHours`
(`REGISTRY_RETIREMENT_GRACE_HOURS`) as this deployment has them, so the admin UI can say what a
regeneration or a dropped item will actually do.

## Registering

On every start. With [`@tereo-io/sdk`](../../tereo-sdk/README.md) that is
`core.register(declaration)`, which retries as described below; over plain HTTP, with a token from
`POST /oauth/token` (`grant_type=client_credentials`):

```jsonc
POST /v1/registry/declaration
{
  "version": "1.4.0",                              // the release's semver
  "permissions": [{ "name": "product.items.read", "displayName": "Read items", "description": "…",
                    "orgAssignable": true }],
  "systemRoles": [{ "name": "product_reader", "displayName": "Product reader",
                    "permissions": ["product.items.read"] }],
  "buckets":     [{ "bucketName": "product-images", "policy": "private" }],
  "eventTypes":  [{ "eventType": "product.item.created", "description": "Item created",
                    "readPermission": "product.items.read" }],
  "requestedAccess": {
    "roles": ["file_user", "webhook_publisher"],   // core's; "<slug>/<name>" for another service's
    "audiences": ["reporting-service"]                   // services allowed to introspect our tokens
  }
}
```

```jsonc
// 200
{ "service": "product-service", "applied": true, "changed": true,
  "access": [{ "id": "…", "kind": "role", "target": "file_user", "status": "pending" }, …] }
```

- **Namespaced.** Permissions and event types are `<namespace>` or `<namespace>.…`; buckets are
  `<namespace>-…`; system roles are `<namespace>_<name>` (`product_reader`), or the declaration is
  a `400 invalid_role_name` and nothing is applied. A system role may grant only permissions the
  same declaration lists, and may not share a name with one of core's (`user_resolver`, which the
  namespace `user` could spell). An event type's optional `readPermission` must be one the
  declaration lists or one of core's: a webhook endpoint is sent the event only while its creator
  holds it ([webhooks.md](webhooks.md)). Anything else is a `422` listing every problem, and nothing
  is applied.
- **Versioned.** `version` is required: the release's semver, `MAJOR.MINOR.PATCH` with an optional
  `-prerelease` (else `400`). Core stores the version it applied beside the hash. A declaration
  older than that is ignored — `200` with `applied: false`, nothing written, and a warning logged
  with the service and both versions — so a replica of an earlier release cannot undo a rollout.
  An equal or newer one is applied (`applied: true`) as below.
- **Idempotent.** The declaration is hashed (order-insensitive; `version` is not part of it).
  Unchanged since last time: `changed: false`, nothing written but a newer version. Copies starting
  together apply it once.
- **Org-assignable.** `orgAssignable` (default false) marks a permission a role assigned within an
  organization may grant. Set it only where every use of the permission stays inside the caller's
  organization; an org-scoped role grants nothing else ([auth.md](auth.md#organizations-roles-members-activation)).
- **What is updated.** Permissions: display text and `orgAssignable`. Event types: display text and `readPermission`. System roles: display text and
  permissions. Buckets: the description; policy and quota are set only when the bucket is created.
  The service gets a read/write/delete grant on each, restored whenever a changed declaration is
  applied (an unchanged one writes nothing; admins can't revoke the grant anyway).
- **Retry until accepted**, with backoff, and report not-ready meanwhile. A request for a role that
  does not exist yet (another service has not registered) is a `422` until it does.

## Declared buckets

The declaring service owns a bucket's name and existence; admins tune the rest.

| Who | May |
|-----|-----|
| `file-service.admin` (or anything that includes it) | Change policy, quota, versioning, thumbnails, CORS and rate limit; grant and revoke other users' access |
| The service (the bucket's creator) | The same, through its own token |
| Anyone | Not delete it, retired or not: `409 bucket_declared` |

Two edits are refused with `409 bucket_declared` because the next registration would undo them:
changing the description, and revoking the service's own grant. Everything else an admin sets is
kept — the declaration never re-applies it. Bucket responses carry `createdBy`, `serviceId`,
`serviceName`, `missingSince` and `retiredAt`.

## Access needs approval

`requestedAccess` is a request. New items are `pending` until an admin approves them; until then the
service's calls that need them get `403`. Approving a role assigns it to the service account;
approving an audience adds it to the client's `audience`, which appears in tokens issued afterwards.

Requests are additive. Dropping an item from a later declaration leaves its approval in place — a
rolling deploy alternating old and new declarations must not make access flap. Removing access is
the admin's `revoke`. A revoked item stays revoked when requested again; an admin can approve it.

### Another service's role

Approving `<slug>/<name>` records the permissions the role grants at that moment
(`approvedPermissions`), and the service holds only those through it. When the role's own service
later declares more permissions for it, the request returns to `pending`, naming the additions in
`pendingPermissions`, and `core.service.access-requested` fires for the consuming service with
them. The service keeps what was approved meanwhile; the additions grant nothing until an admin
approves the request again, which records the role's current permissions and requires the approver
to hold the added ones. A role that loses permissions grants less at once, and if it drops what was
pending, the request is `approved` again. Revoking clears the record: a later approval starts over.

Core's own roles are not recorded this way. They change only with core's code, so an approved core
role grants whatever core's current version gives it.

Core's roles for app services. Only these can be requested; any other core role (`admin`, `platform_admin`, `*_admin`) is refused with `422 invalid_requested_access`. `tenant_resolver` and `user_resolver` are requestable too.

| Role | Grants |
|------|--------|
| `file_user` | `file-service.buckets.read` and `file-service.objects.read/write/delete` — on buckets the service holds a grant on (its own) |
| `webhook_publisher` | `webhooks.emit` — only for event types the service declares |
| `audit_writer` | `audit-logs.write` |
| `notification_sender` | `notifications.send` |

## Retirement

An item a declaration stops listing gets `missingSince`; re-declaring clears it. The worker's hourly
`registry-retirement` job retires anything missing for longer than `REGISTRY_RETIREMENT_GRACE_HOURS`
(24) — long enough for a rolling deploy to finish.

A declaration is applied whole whenever its hash differs from the stored one and its version is not
older than the stored one. A replica of an older release that restarts after a rollout is therefore
ignored. Two builds declaring the same version, though, still take turns: give every release that
changes its declaration a new version.

| Retired | Effect |
|---------|--------|
| Permission | Grants nothing. Stays on custom roles, flagged `retired` |
| System role | Grants nothing; cannot be assigned or requested |
| Event type | New events are refused (`400 event_type_retired`); endpoints still subscribed list it in `retiredEventTypes`; new subscriptions are refused |
| Bucket | Read-only: uploads, copies, multipart and new versions get `409 bucket_retired`. Reads, downloads, shares and deletes still work. No data is touched |

Nothing is deleted. Re-declaring an item brings it back.

## Core

Core's declaration is `CORE_DECLARATION` (`definitions/declaration.ts`), versioned with core's
`package.json`, registered on every start by `registerCore()` before the server listens, as the
system user. Its names keep their historical
prefixes, all reserved for it, and its roles are exempt from the `<namespace>_` rule. To add a permission, role, bucket or event type to core, add it under
`definitions/`; to remove one, delete it there and it retires a day after the deploy.
