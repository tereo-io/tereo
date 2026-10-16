# Declarative provisioning

Date: 2026-10-16. Status: design agreed in conversation; spec awaiting review.
Supersedes `2026-10-16-cross-service-role-access-design.md` (vanquished gap 0k) and covers gaps
0i and 0n. Gap 0m (private webhook targets) and first-party login clients are separate specs.

## Problem

App services tell core what they own by calling `POST /v1/registry/declaration` at boot, and the
deploy separately lists services, secrets and pre-approved access in a provisioning file. For
vanquished (about ten services that grant each other roles) this splits one system across two
mechanisms and makes boot order matter:

- A declaration requesting `<slug>/<name>` before that service registers is a `422`; mutual pairs
  (oms ↔ order-routing, customer ↔ shipping, customer ↔ pricing) can never both register (0k).
- The provisioning file cannot grant another service's role; growth of a granted role waits for an
  admin.
- Webhook subscriptions between services have no owner and no deploy-managed secret (0i, 0n).

## Decision

Everything an app declares moves into provisioning. Core reads a folder (or one file) of JSON
documents, validates the whole set, and applies it in one transaction, at start and on demand from
the CLI. Registration is deleted.

Core's own declaration (`CORE_DECLARATION`) stays in code, registered in-process on every start as
today: its permissions, roles, event types and buckets are what core's code depends on, and they
change with core's release.

## The provisioning path

`PROVISIONING_PATH` (replacing `PROVISIONING_FILE`) names a JSON file or a directory. Unset, nothing
is applied or retired, as today.

- **Directory**: every `*.json` file directly inside it, in name order. Names starting with `.` are
  skipped (Kubernetes' `..data` entries in a mounted ConfigMap); other extensions and
  subdirectories are ignored.
- **File**: that one document.
- Files are parsed as strict JSON. JSON only: services generate theirs from typed TypeScript, and
  YAML's coercions (`1.10` → `1.1`) bite exactly the version fields these files carry.

## Documents

Every document has the same shape. File names carry no meaning; contents decide.

```jsonc
{
  "$schema": "https://…/provisioning.schema.json",   // optional, ignored by core
  "version": "1.4.0",                                 // required semver
  "service": { … },                                   // at most one
  "clients": [ … ],                                   // login clients
  "roles": [ … ]                                      // custom roles
}
```

A document with none of `service`, `clients`, `roles` is an error. Unknown keys are refused at every
level.

### `service`

```jsonc
{
  "slug": "product-service",
  "name": "Product",
  "namespace": "product",                 // default: slug without "-service"
  "clientId": "product-service",          // default: slug
  "secretFrom": "PRODUCT_CLIENT_SECRET",
  "access": {
    "roles": ["file_user", "customer-service/customer_reader"],
    "audiences": ["pricing-service"]
  },
  "permissions": [{ "name": "product.items.read", "displayName": "…", "description": "…",
                    "orgAssignable": true }],
  "systemRoles": [{ "name": "product_reader", "displayName": "…",
                    "permissions": ["product.items.read"] }],
  "buckets": [{ "bucketName": "product-images", "policy": "private" }],
  "eventTypes": [{ "eventType": "product.item.created", "description": "…",
                   "readPermission": "product.items.read" }],
  "webhooks": [{
    "key": "org-events",
    "url": "http://product.vanquished.svc.cluster.local/webhooks/core",
    "events": ["auth.organization.created"],
    "secretFrom": "PRODUCT_WEBHOOK_SECRET",
    "organizations": "all",               // default; or a list of organization ids
    "description": "…"
  }]
}
```

The service fields, secret rules and namespace rules are today's provisioning and registry rules.
The declaration fields (`permissions` … `eventTypes`) are today's declaration, with the same
namespacing, validation and update semantics (`applyPermissions`, `applyRoles`, `applyBuckets`,
`applyEventTypes`), and the document's `version` is stored as the service's
`declarationVersion`.

### `clients`

Today's login-client entries, unchanged, with an optional `description`.

### `roles`

Custom roles, composed across services:

```jsonc
{ "name": "support", "displayName": "Support", "description": "…",
  "orgAssignable": false,
  "permissions": ["organizations.support-access", "product.items.read", "oms.orders.read"] }
```

- A permission may be core's or any service's in the set.
- `orgAssignable: true` requires every permission to be org-assignable (today's rule for custom
  roles).
- Names are unique across the set and may not collide with a system role. They are not
  namespaced.
- Provisioned roles are read-only in the admin API (`409 managed_by_provisioning` on edit, delete,
  archive); admins still assign them to users and organization members.

## Validation: the whole set, before any write

Core loads every document, then checks the set as one. Every problem is listed, each naming its
file; any problem means nothing is written.

- Per document: schema, JSON syntax, semver `version`.
- Uniqueness across the set: service slug, namespace, client ID (services and login clients),
  custom role name, webhook `key` within its service, permission and event-type names, bucket
  names.
- References resolve **within the set or core's declaration**:
  - `access.roles`: a requestable core role, or `<slug>/<name>` naming a system role a service in
    the set declares (not the service's own).
  - `access.audiences` and login clients' `audience`: a service in the set.
  - A custom role's permissions; a system role's (its own declaration's only, as today); an event
    type's `readPermission` (its own or core's).
  - A webhook's `events`: event types in the set or core's, not reserved (`webhook.test`), and
    readable by the owning service through its `access` — otherwise the endpoint would never be
    sent anything, which is a deploy error, not a silent drop.
- Secrets: today's rules (format, strength, not another env var of core, not the entry's previous
  secret), across service, client and webhook secrets. One exception: webhook entries of the
  **same** service may share a secret (ORS verifies two endpoints with one).
- Rows that exist but are not provisioned (hand-made service or client of the same slug or ID) are
  errors, as today.

Since references are checked here, boot order no longer exists: a typo fails the deploy instead of
waiting `pending`.

## Applying

One transaction, under the existing apply-once lock, so replicas starting together and a CLI run
racing a start apply it once.

1. **Services**: create or update the service, client, service account and secret (today's
   `applyService`).
2. **Declarations**: for each service whose declaration hash or version changed, apply it with
   today's `apply*` functions. Unchanged services are skipped (stored `declarationHash`). A
   `version` lower than the stored one is applied (the folder is the intended state; a lower
   version is a deliberate rollback) with a warning log naming both versions.
3. **Custom roles**: create or update; their permission set is replaced.
4. **Access**: every `access` entry becomes an `approved` access row, approved by the system user,
   recording the role's current permissions. On every apply, approved role access is brought up to
   what the role now grants — **access listed in the file follows the role** (agreed). Entries
   removed from the file are revoked (the role assignment removed, tokens revoked) at that apply.
   A row an admin revoked stays revoked while the file lists it; an admin can approve it again.
5. **Webhooks**: create or update service-owned endpoints (below).
6. **Login clients**: today's `applyClient`.
7. **Removals**: services, clients and custom roles missing from the set are marked
   `unprovisionedAt` and handled after `REGISTRY_RETIREMENT_GRACE_HOURS` by today's retirement:
   services deactivated, clients deleted, custom roles archived. Items a service's declaration
   drops get `missingSince` and retire as today. Webhook endpoints a service drops are archived
   at once (no deliveries to a URL the deploy removed).

Every change is audited as the system user; each document's `version` and file name go into the
audit entries' metadata. `core.service.declared` is still emitted per changed service.

The approval machinery for requests (`pending` rows, `pendingPermissions`, reopening on growth,
`approveProvisionedAccess`, `core.service.access-requested`) is removed: no service requests
anything anymore. `POST /v1/admin/services/:id/access/revoke` and `…/approve` remain, for the
revoke-and-re-approve case above.

## Service-owned webhook endpoints

- `webhooks.webhook_endpoints` gains `owner_service_id` (nullable FK to the service) and
  `provisioned`; `organization_id` becomes nullable, null meaning every organization — allowed only
  with an owner. `organizations: [ids]` creates one endpoint per organization under the same key.
  An identity column `provisioning_key` (`<service slug>:<key>[:<org id>]`) makes reapplying
  idempotent.
- `created_by` is the owning service's account user. The delivery check (`utils/webhookAccess.ts`)
  for an owned endpoint does not require `webhooks.read`; it requires the event's `readPermission`
  (and bucket access for `file-service.*` events) of the service account, which its `access`
  provides.
- Fan-out for an event of organization X selects endpoints of X and owned endpoints with a null
  organization.
- The signing secret comes from `secretFrom` (sealed as today). Changing the variable's value is a
  rotation with `WEBHOOK_SECRET_OVERLAP_HOURS` overlap.
- Provisioned endpoints are read-only in the API (`409 managed_by_provisioning` on PATCH, DELETE,
  archive, rotate-secret); delivery views, retries and test sends work.
- The SSRF guard is unchanged here; in-cluster URLs need the 0m spec.

## CLI

`npm run cli -- provision [--path <path>] [--dry-run]`

- Loads, validates and applies `--path` or `PROVISIONING_PATH`, as start does. Needs the same
  environment as core (database, KEK, the `secretFrom` variables).
- `--dry-run` validates and prints what would change, writing nothing.
- Exit code non-zero on any problem, with every problem printed.
- There is no HTTP route that applies provisioning.

`npm run cli -- provisioning-schema` prints the JSON Schema (generated from the Zod schema), and
the same schema is published as `packages/tereo/provisioning.schema.json` and exported by the SDK.

## Start

Core applies provisioning on every start, as today, after `registerCore()`. An invalid set still
refuses to start (unchanged), so a fresh environment either comes up complete or not at all; in
Kubernetes the CLI Job catches the error first.

## Helm chart

- `provisioning.documents`: a map of file name to document object. The ConfigMap renders each as
  `<name>.json` with `toJson`, mounted as a directory; `PROVISIONING_PATH` points at it.
- `provisioning.existingConfigMap`: mount a ConfigMap the pipeline built from the services'
  generated files instead.
- A `post-install,post-upgrade` hook Job runs `provision` with core's environment.
- The `checksum/provisioning` annotation is removed: a provisioning change no longer rolls core's
  pods.

## SDK (`@tereo-io/sdk`)

- Removed: `register()`, `isRegistered()`, `getRegistration()`, `whenRegistered()`, the retry
  logic, and registration's part in readiness.
- Added: the document types (`ProvisioningDocument`, `ServiceProvisioning`, …) and the JSON Schema,
  so a service's build writes its file with `JSON.stringify` from a typed object.
- Major bump of the `sdk` group.

## Removed from core

- `POST /v1/registry/declaration`, `routes/v1/registry/`, the `registry` core scope area and its
  OpenAPI paths.
- Registration-only code in `utils/registry.ts` (route-facing parsing, `requestedAccess`
  handling, `reopenGrownAccess`, the request-approval path in `utils/serviceAccess.ts`).
- `POST /v1/admin/services` stays: an admin-made service has a client and a service account but
  declares nothing. It is the basis for integration clients (0p).

## Data changes (one migration)

- `auth.roles`: `provisioned boolean`, `unprovisioned_at`.
- `webhooks.webhook_endpoints`: `owner_service_id`, `provisioned`, `provisioning_key` (unique),
  `organization_id` nullable with a CHECK that null requires an owner.
- `auth.services.provisioned_access` is dropped (access lives in the access rows).
- Pending access rows left from registration are deleted.

## Admin UI

- Service detail: declared version and when it was applied (exists), "Managed by provisioning" on
  everything provisioned, and no pending-request inbox (`GET /v1/admin/services/access` keeps
  `approved`/`revoked`).
- Roles: provisioned roles show the badge and hide edit controls.
- Webhooks: owned endpoints show their owning service and "All organizations"; edit controls
  hidden.

## Docs

`docs/provisioning.md` becomes the reference for documents, validation, applying, the CLI and Helm.
`docs/registry.md` shrinks to core's own declaration and the declared-items semantics (retirement,
buckets, org-assignable), linking to provisioning. `docs/webhooks.md` gains owned endpoints. The
SDK's registry docs are replaced by "Writing your provisioning document". README's *Current state*
updated.

## Breaking changes (release notes)

- `PROVISIONING_FILE` (YAML) → `PROVISIONING_PATH` (JSON). The vivo-it deploy of 0.2.0 must convert
  its file, if it sets one.
- Registration removed; services stop calling `register()`.
- Helm: `provisioning` value is now `provisioning.documents` / `existingConfigMap`.
- `core` group minor bump (pre-1.0), `sdk` group major bump.

## Testing

- Loading: directory order, dot-files and non-JSON skipped, single file, JSON syntax errors with
  the file named, empty document refused, unknown keys refused.
- Validation: each cross-file reference rule (good and bad), each uniqueness rule naming both
  files, webhook event not readable by its owner, same-service secret sharing allowed and
  cross-service refused, every problem reported at once.
- Apply: a fresh set creates everything; reapplying an unchanged set writes nothing (no audit
  entries); mutual pair of services granting each other roles applies in one go; role growth
  extends approved access; removing an access entry revokes it; an admin-revoked entry stays
  revoked; lower version applies with a warning; removed service, client and role retire after
  the grace.
- Webhooks: owned endpoint with `all` receives events from two organizations; delivery requires
  the owner's `readPermission`; secret from env verifies; rotation overlap; provisioned endpoint
  refuses PATCH with 409.
- Concurrency: two applies racing apply once.
- CLI: `--dry-run` writes nothing and exits 0; an invalid set exits non-zero listing problems.
- Helm: `helm template` renders documents as JSON files and the hook Job.
- SDK: types compile against the schema; registration exports are gone.
