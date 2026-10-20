# Services and declarations

An app service, a billing service or a reporting service, reaches core with one OAuth client. What it
owns (permissions, roles, buckets, event types), the access it has and the webhooks it receives are
declared by its [provisioning document](provisioning.md), which core applies at start and from the
CLI. Nothing registers over HTTP. Core declares its own items in-process.

## Adding a service

A service normally comes from a [provisioning document](provisioning.md), which also declares what
it owns. An admin with `services.write` can add one by hand, a service with a client and account that
declares nothing:

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
- A hand-made service has no permissions, roles, buckets or event types of its own, and no access
  until an admin approves some (below).

| Route | Permission | Does |
|-------|------------|------|
| `GET /v1/admin/services` | `services.read` | List |
| `GET /v1/admin/services/access` | `services.read` | Access rows across every service, each with its `service` (`id`, `slug`, `name`). Filter `status`, `kind`, `serviceId`, `target` (`?filter[status]=approved`); sort `requestedAt` (default, newest first) or `id` |
| `GET /v1/admin/services/:id` | `services.read` | One service with everything it declared (retired included), its access, and `settings` |
| `PATCH /v1/admin/services/:id` `{ name?, isActive? }` | `services.write` | Rename; deactivate (its tokens stop at once) or reactivate |
| `POST /v1/admin/services/:id/regenerate-secret` | `services.write` | New secret, shown once. The old one keeps working for `SERVICE_SECRET_OVERLAP_HOURS` (24) |
| `POST /v1/admin/services/:id/revoke-previous-secret` | `services.write` | End that overlap now. The secret is retired: provisioning never accepts it again |
| `POST /v1/admin/services/:id/access/approve` `{ ids }` | `services.approve` | Grant access rows, such as one an admin revoked |
| `POST /v1/admin/services/:id/access/revoke` `{ ids }` | `services.approve` | Take them away; the service's tokens are revoked |

Services are never deleted. Core's own row is not managed through this API.

Access rows, on the detail and in the list, name who last decided them: `decidedBy` (the user id) plus
`decider` (`{ id, email, name }`), `decidedByEmail` and `decidedByName`. A row for another
service's role also carries `approvedPermissions`, what the role granted when last decided
([below](#another-services-role)). The detail's `settings` states
`secretOverlapHours` (`SERVICE_SECRET_OVERLAP_HOURS`) and `retirementGraceHours`
(`REGISTRY_RETIREMENT_GRACE_HOURS`) as this deployment has them, so the admin UI can say what a
regeneration or a dropped item will actually do.

## What a declaration holds

A service's document carries its declaration (`permissions`, `systemRoles`, `buckets`,
`eventTypes`), applied when the service is created or the declaration changes:

- **Namespaced.** Permissions and event types are `<namespace>` or `<namespace>.…`; buckets are
  `<namespace>-…`; system roles are `<namespace>_<name>` (`product_reader`). A system role may grant
  only permissions the same declaration lists, and may not share a name with one of core's
  (`user_resolver`, which the namespace `user` could spell). An event type's optional
  `readPermission` must be one the declaration lists or one of core's: a webhook endpoint is sent
  the event only while its creator holds it ([webhooks.md](webhooks.md)). A violation is a
  provisioning problem naming the file, and nothing is applied.
- **Versioned.** The document's `version` is stored beside the declaration's hash. A lower version
  than stored is applied with a warning, since the documents are the deploy's intended state
  ([applying](provisioning.md#applying)). A service reads what core last applied for it — version,
  hash, `declaredAt` and its access — with `GET /v1/account/service`, which needs no permission.
- **Idempotent.** The declaration is hashed (order-insensitive; `version` is not part of it).
  Unchanged since last time, nothing is written but a newer version.
- **Org-assignable.** `orgAssignable` (default false) marks a permission a role assigned within an
  organization may grant. Set it only where every use of the permission stays inside the caller's
  organization; an org-scoped role grants nothing else ([auth.md](auth.md#organizations-roles-members-activation)).
- **What is updated.** Permissions: display text and `orgAssignable`. Event types: display text and
  `readPermission`. System roles: display text and permissions. Buckets: the description; policy and
  quota are set only when the bucket is created. `storageQuotaBytes` is limited as on the bucket API
  (at most 1 TiB, 2^40 bytes) and may be a number or a digit string. The service gets a read/write/delete grant on each,
  restored whenever a changed declaration is applied (admins can't revoke the grant anyway).

## Declared buckets

The declaring service owns a bucket's name and existence; admins tune the rest.

| Who | May |
|-----|-----|
| `file-service.admin` (or anything that includes it) | Change policy, quota, versioning, thumbnails, CORS and rate limit; grant and revoke other users' access |
| The service (the bucket's creator) | The same, through its own token |
| Anyone | Not delete it while it is declared: `409 bucket_declared` |

Two edits are refused with `409 bucket_declared` because the next apply would undo them:
changing the description, and revoking the service's own grant. Everything else an admin sets is
kept — the declaration never re-applies it. Bucket responses carry `createdBy`, `serviceId`,
`serviceName`, `missingSince` and `retiredAt`.

A declared bucket can be deleted, like any other, once it is no longer declared:

- **Dropped from its service's declaration.** It is retired after the grace period
  ([retirement](#retirement)); from then on `DELETE /v1/files/buckets/{name}` deletes it.
- **Its service dropped from the provisioning documents.** The service is deactivated after the
  grace period ([provisioned services](#provisioned-services)), and its buckets are marked missing
  then, to be retired one grace period later. From the deactivation on, the buckets can be deleted.

Deleting one is final: should the service declare the name again, it gets a new, empty bucket.

## Access

A service's `access.roles` and `access.audiences` are granted by provisioning, as core's system
user: there is no request and no approval queue. Granting a role assigns it to the service account;
an audience is added to the client's `audience`, which appears in tokens issued afterwards. Until
then the service's calls that need it get `403`.

Access removed from the document is revoked at the next apply, and granted again if listed again.
An admin with `services.approve` can still revoke a row, which stays revoked while the document lists
it, and approve it again ([provisioning](provisioning.md#applying)).

### Another service's role

`access.roles` may name `<slug>/<name>`, a system role of another service of the set. The row
records the permissions the role grants (`approvedPermissions`), and the service holds those. Access
follows the role: when the role's service adds permissions, the next apply extends the holder; a role
that loses permissions grants less at once. Because every reference is checked across the whole set
at load, two services can grant each other roles in the same deploy.

A service's account does not hold its own permissions. A webhook on the service's own events
therefore needs a role in `access.roles` that grants the event's `readPermission`.

Core's own roles are requestable by their bare name only; any other core role (`admin`,
`platform_admin`, `*_admin`) or a `core/<name>` spelling is refused at load. `tenant_resolver` and
`user_resolver` are requestable too.

| Role | Grants |
|------|--------|
| `file_user` | `file-service.buckets.read` and `file-service.objects.read/write/delete` — on buckets the service holds a grant on (its own) |
| `webhook_publisher` | `webhooks.emit` — only for event types the service declares |
| `audit_writer` | `audit-logs.write` — under the service's slug as `source`; covers reading its own entries |
| `audit_reader` | `audit-logs.read` — only the entries the service wrote ([audit.md](audit.md#organization-scope)) |
| `notification_sender` | `notifications.send` |

Core's roles change only with core's code, so a granted core role gives whatever core's current
version gives it.

## Retirement

An item a service's document stops declaring gets `missingSince`; declaring it again clears it. The worker's hourly
`registry-retirement` job retires anything missing for longer than `REGISTRY_RETIREMENT_GRACE_HOURS`
(24) — long enough for a rolling deploy to finish.

A declaration is applied whole whenever its hash differs from the stored one. Give every release
that changes its declaration a new `version`, so the stored version tells which release applied it.

| Retired | Effect |
|---------|--------|
| Permission | Grants nothing. Stays on custom roles, flagged `retired` |
| System role | Grants nothing; cannot be assigned or requested |
| Event type | New events are refused (`400 event_type_retired`); endpoints still subscribed list it in `retiredEventTypes`; new subscriptions are refused |
| Bucket | Read-only: uploads, copies, multipart and new versions get `409 bucket_retired`. Reads, downloads, shares and deletes still work, and the bucket itself can now be deleted. No data is touched |

Nothing is deleted. Re-declaring an item brings it back, unless an admin deleted the bucket.

## Provisioned services

A provisioned service is read-only through the admin API: rename, deactivate and
`regenerate-secret` answer `409 managed_by_provisioning`, and its secret is rotated by changing the
environment variable its document names. `access/approve`, `access/revoke` and
`revoke-previous-secret` still work. A service dropped from the documents is deactivated after
`REGISTRY_RETIREMENT_GRACE_HOURS`, and reactivated if it returns ([provisioning](provisioning.md#removing-an-entry)).
Its buckets are marked missing at the deactivation and can be deleted from then on
([declared buckets](#declared-buckets)); a return declares them again.

## Core

Core's declaration is `CORE_DECLARATION` (`definitions/declaration.ts`), versioned with core's
`package.json`, registered on every start by `registerCore()` before the server listens, as the
system user. Its names keep their historical
prefixes, all reserved for it, and its roles are exempt from the `<namespace>_` rule. To add a permission, role, bucket or event type to core, add it under
`definitions/`; to remove one, delete it there and it retires a day after the deploy.
