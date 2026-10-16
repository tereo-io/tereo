# Provisioning

A deploy declares everything its app services own in a folder of JSON **provisioning documents**:
each service with its permissions, system roles, buckets, event types, access and webhook
subscriptions, plus login clients and custom roles. Core reads them at every start, checks the whole
set, and applies it in one transaction, so a fresh environment comes up with its services, secrets,
roles and access already in place. There is no registration: services do not call core to say what
they own, and no HTTP route applies provisioning. Services and clients made in the admin UI keep
working beside it.

## The path

`PROVISIONING_PATH` names a JSON file or a directory. Unset, core neither applies nor retires
anything: rows a document provisioned earlier stay `provisioned` (read-only in the admin API) and
are never retired. To release them, deploy documents that no longer list them; they are removed as
[below](#removing-an-entry).

- **Directory**: every `*.json` file directly inside it, in name order. Names starting with `.`
  (Kubernetes' `..data` entries in a mounted ConfigMap), other extensions and subdirectories are
  skipped. A directory with no `*.json` file is an error, not "nothing provisioned".
- **File**: that one document.
- Files are strict JSON. There is no YAML: services generate their document from typed TypeScript
  (`@tereo-io/sdk` exports the types), and YAML's coercions (`1.10` becomes `1.1`) bite exactly the
  `version` fields these files carry.
- File names carry no meaning, but they are what problems and audit entries cite. Under Helm each
  document is a key of a ConfigMap mounted as a directory ([Helm](#helm)).

## Documents

Every document has this shape; unknown keys are refused at every level, so a typo is an error.

```jsonc
{
  "$schema": "https://…/provisioning.schema.json", // optional, ignored
  "version": "1.4.0",                              // required semver
  "service": { … },                                // at most one
  "clients": [ … ],                                // login clients
  "roles": [ … ]                                   // custom roles
}
```

A document needs at least one of `service`, `clients`, `roles`. Core prints the JSON Schema with
`npm run cli -- provisioning-schema`; it is also published as `packages/tereo/provisioning.schema.json`
and exported by `@tereo-io/sdk`. An editor given it as `$schema` completes and checks documents.

A service normally ships its own document, generated at build time; a deploy repo can add
documents for clients and roles of its own.

### `service`

```json
{
  "version": "1.4.0",
  "service": {
    "slug": "product-service",
    "name": "Product",
    "namespace": "product",
    "clientId": "product-service",
    "secretFrom": "PRODUCT_CLIENT_SECRET",
    "access": {
      "roles": ["file_user", "customer-service/customer_reader"],
      "audiences": ["pricing-service"]
    },
    "permissions": [
      {
        "name": "product.items.read",
        "displayName": "Read items",
        "description": "List and read items",
        "orgAssignable": true
      }
    ],
    "systemRoles": [
      {
        "name": "product_reader",
        "displayName": "Product reader",
        "permissions": ["product.items.read"]
      }
    ],
    "buckets": [{ "bucketName": "product-images", "policy": "private" }],
    "eventTypes": [
      {
        "eventType": "product.item.created",
        "description": "Item created",
        "readPermission": "product.items.read"
      }
    ],
    "webhooks": [
      {
        "key": "org-events",
        "url": "http://product.shop.svc.cluster.local/webhooks/core",
        "events": ["auth.organization.created", "product.item.created"],
        "secretFrom": "PRODUCT_WEBHOOK_SECRET",
        "organizations": "all",
        "description": "Core events for the product service"
      }
    ]
  },
  "clients": [
    {
      "clientId": "product-admin",
      "name": "Product admin app",
      "clientType": "public",
      "redirectUris": ["https://product.example.com/callback"],
      "scopes": ["openid", "profile", "email"],
      "audience": ["product-service"],
      "consentRequired": true
    }
  ],
  "roles": [
    {
      "name": "support",
      "displayName": "Support",
      "orgAssignable": false,
      "permissions": ["organizations.support-access", "product.items.read"]
    }
  ]
}
```

(`clients` and `roles` are shown here for completeness; a service's own document usually holds
only `version` and `service`.)

| Field | Rule |
|-------|------|
| `slug`, `namespace` | Lowercase words joined by hyphens, max 64. `namespace` defaults to the slug without a trailing `-service`. It prefixes everything the service declares ([registry](registry.md)) |
| `name` | Required, max 100 |
| `clientId` | The service's OAuth client ID; defaults to the slug. Unique across services and login clients |
| `secretFrom` | Required: an environment variable's name ([Secrets](#secrets)) |
| `access.roles` | Requestable core roles, bare (`file_user`, `webhook_publisher`, `audit_writer`, `notification_sender`, `tenant_resolver`, `user_resolver`), or `<slug>/<name>`, a system role another service of the set declares |
| `access.audiences` | Services of the set whose APIs this one may call (it can be introspected by them). Not core, not itself |
| `permissions`, `systemRoles`, `buckets`, `eventTypes` | The service's declaration, with the namespacing, validation and update rules of [registry](registry.md#what-a-declaration-holds) |
| `webhooks` | Service-owned endpoints: [Webhooks](#webhooks) |

The document's `version` is stored as the service's declared version.

### `clients`

Login clients, as made in the admin UI.

| Field | Rule |
|-------|------|
| `clientId` | Required, max 64 |
| `name` | Required, max 100 |
| `clientType` | `public` (default) has no secret (`secretFrom` is an error); `confidential` needs it |
| `redirectUris`, `postLogoutRedirectUris` | Safe URLs: `https`, or loopback `http` |
| `scopes`, `grantTypes` | Default grant types `authorization_code` and `refresh_token`. Scopes and audience take effect as for clients made in the admin UI ([auth](auth.md)) |
| `audience` | Services of the set its tokens may name. Unlike a hand-made client's audience, no `services.approve` is involved: the documents are the deploy's decision |
| `consentRequired` | Default `true`. `false` skips consent after a login, unless the request asks for a `core:*` scope: those always show the consent screen. It grants no core API access |
| `description` | Optional, max 500 |

### `roles`

Custom roles composed across services, for people (assigned to users and organization members by
admins as usual):

| Field | Rule |
|-------|------|
| `name` | Lowercase letters, digits, `_` and `-`; unique across the set; may not equal a system role of core or of a service. Not namespaced |
| `displayName`, `description`, `permissions` | A permission may be core's or any service's in the set |
| `orgAssignable` | Default `false`. `true` needs every permission to be org-assignable |

## Validation

Core loads every document, then checks the set as one. Every problem is reported, each prefixed with
its file name, and any problem means **nothing is written**. At start, core then does not start; from
the CLI the exit code is non-zero.

- **Per document**: JSON syntax, the schema, a semver `version`, at least one of the three sections.
- **Uniqueness across the set**: service slug and namespace (and no overlap, as a namespace may
  not equal or hyphen-extend another's, nor one core reserves), client ID across services and login
  clients, custom role name, webhook `key` within its service, permission, event-type and bucket
  names.
- **References resolve within the set or core's declaration**, so boot order does not exist and a typo
  fails the deploy:
  - `access.roles`: a requestable core role, or `<slug>/<name>` for a system role of another service
    in the set (never the service's own);
  - `access.audiences` and a login client's `audience`: a service in the set;
  - a custom role's permissions; a system role's (its own service's only); an event type's
    `readPermission` (its own service's or core's).
- **Webhooks**:
  - `events` name event types declared in the set or by core, not reserved (`webhook.test`);
  - the owning service must be able to read each one. A service's account does **not** hold its own
    permissions, so a webhook on the service's own events needs `access.roles` to list a role
    that grants the event's `readPermission`: another service's role, or a requestable core role.
    Otherwise the endpoint would never be sent anything, which is an error rather than a silent
    drop;
  - the URL is `http` or `https` with no credentials, and its host is not `localhost` or a
    private or reserved IP literal (private in-cluster targets get their own feature). In-cluster
    DNS names are fine.
- **Secrets**: format, strength and the other rules of [Secrets](#secrets), across service, client
  and webhook secrets; every `secretFrom` variable must be set.
- **Existing rows**: a service or client of the same slug or ID that exists but is not
  provisioned is an error naming it; core never adopts a hand-made row. Delete or rename it, or
  change the entry.

## Applying

At start (after core's own declaration is registered in-process) and on `provision`, one
transaction applies the set, under a lock so replicas starting together, or a CLI run racing a start,
apply it once. A set that has not changed writes nothing and audits nothing.

1. **Services**: each service, its OAuth client, service account and secret are created or updated.
2. **Declarations**: a service whose declaration or `version` changed has its permissions, system
   roles, buckets and event types applied ([registry](registry.md)). A `version` **lower** than the
   stored one is applied anyway, because the documents are the intended state and a lower version is
   a deliberate rollback; core logs a warning naming both versions.
3. **Custom roles**: created or updated, their permission set replaced.
4. **Access**: every `access` entry becomes an approved access row, decided by the system user.
   **Access follows the role**: an entry for another service's role grants whatever the role holds
   now, so when its service adds a permission to the role, the next apply extends the holder.
   There is no approval step and nothing waits `pending`.
   - Access **removed from the file is revoked** at that apply (the role assignment goes, the
     service's tokens are revoked); listed again later, it is granted again.
   - An admin's revocation stays: a row an admin revoked remains revoked while the file lists it.
     An admin can approve it again ([admin API](#managed-rows)).
5. **Webhooks**: service-owned endpoints are created or updated ([Webhooks](#webhooks)).
6. **Login clients**.
7. **Removals** ([below](#removing-an-entry)).

Every write is audited as the system user, with the document's `file` and `version` in the entry's
metadata. `core.service.declared` is emitted for each changed service. A service made in the admin
UI declares nothing; provisioning is how a service gets a declaration.

## Webhooks

A service's `webhooks` give it endpoints core delivers events to, owned by the service. Each is
created from its `key` (`<service slug>:<key>`, so reapplying is idempotent).

| Field | Rule |
|-------|------|
| `key` | Required, unique within the service |
| `url` | Required; checked as under [Validation](#validation) |
| `events` | Required, at least one event type |
| `secretFrom` | Required: signs the deliveries ([Secrets](#secrets)); webhooks of the **same** service may share a secret, those of different services may not |
| `organizations` | `"all"` (default): one endpoint receiving the events of every organization, present and future. Or a list of organization IDs: one endpoint per organization, same key |
| `description` | Optional |

- The endpoint is created by the service's account. Delivery needs not `webhooks.read` but the
  event's `readPermission` (and bucket access for `file-service.*` events) of that account, which
  `access` provides: see the rule under Validation.
- Delivery history of an all-organization endpoint is shown per event's organization; payloads are
  redacted unless the viewer can read the event in that organization.
- Changing the variable's value rotates the secret, with `WEBHOOK_SECRET_OVERLAP_HOURS` overlap.
- A webhook a service drops from its document is **archived at once**: no deliveries go to a URL the
  deploy removed.
- A provisioned endpoint is read-only through the API ([Managed rows](#managed-rows)); delivery
  views, retries and test sends work. See [webhooks](webhooks.md#service-owned-endpoints).

## Secrets

A document never holds a secret. `secretFrom` names an environment variable of the core process, and
core reads the value from there. The same goes for webhook secrets. Under Helm that means the variable must be a key of
`secrets.existingSecret` (or of the Secret `secrets.externalSecret` builds), or come from
`extraEnvFrom`; core's pods get every key of those as environment variables.

A secret is `tereo_sk_` followed by 43 base64url characters (32 random bytes). Generate one with:

```sh
npm run cli -- generate-secret
```

or, without Node:

```sh
printf 'tereo_sk_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
```

Core refuses a secret that

- does not match that format;
- does not look random: fewer than 16 distinct characters, or a run of six or more repeated,
  ascending or descending characters;
- is used by two entries of the set (service, client or webhook), except that webhook entries of the
  **same** service may share one secret;
- is the same value as another environment variable of core (so a database password pasted into a
  client secret is caught);
- is the entry's previous secret (see rotation below).

Every message names the file, the variable and the rule. A secret's value, or any part of it, is never printed,
logged or put in an audit entry. Secrets core generates itself (a client made in the admin UI,
`regenerate-secret`) use the same format.

## Rotating a secret

Change the environment variable's value (a new `generate-secret`, updated in the Secret) and
restart core, or run `provision` (below). The old secret moves to the service's previous secret and keeps working for
`SERVICE_SECRET_OVERLAP_HOURS`, as with `regenerate-secret`, while you roll the new value out to the
service. A confidential login client rotates the same way: change its `secretFrom` variable and
restart, and its old secret keeps working for the same overlap.

If the old secret leaked, end a service's overlap at once with
`POST /v1/admin/services/:id/revoke-previous-secret` (the admin UI's "End Overlap Now"). That route
is allowed on a provisioned service, since the file cannot express it.

Core refuses to start if the new value is the previous secret, which is what happens when a deploy
is rolled back to the old Secret: the message says to generate a new secret. The guard covers only
the most recent previous secret. A secret from two or more rotations back is accepted again, so
always generate a fresh one rather than reusing an old value.

A webhook's secret rotates the same way, with `WEBHOOK_SECRET_OVERLAP_HOURS` of overlap
([webhooks](webhooks.md)).

## Removing an entry

Delete the entry from the documents. Core marks the row as removed at the next apply and keeps it
for `REGISTRY_RETIREMENT_GRACE_HOURS` (default 24), so a rollback or a rolling deploy that briefly
runs older documents does nothing. After that the hourly retirement job

- **deactivates** a service: its tokens are revoked and it cannot get new ones; its data and
  history stay;
- **deletes** a login client, as the admin delete does;
- **archives** a custom role.

An entry that returns, before or after, is reactivated: a deactivated service becomes active again and an archived role is restored. A deleted login client is created anew. Items a service's declaration
stops listing retire as in [registry](registry.md#retirement); its dropped webhooks are archived at
once, as above.

## Managed rows

Provisioned rows change only in the documents. The admin API answers `409` with code
`managed_by_provisioning` to:

| Row | Refused | Still allowed |
|-----|---------|---------------|
| Service | `PATCH /v1/admin/services/:id` (rename, deactivate), `regenerate-secret` | `access/approve` and `access/revoke`; `revoke-previous-secret`, to end a rotation's overlap at once |
| Login client | `PATCH`, `DELETE`, `regenerate-secret` on `/v1/admin/clients/:id` | Reading it |
| Custom role | Edit, delete, archive, restore, and changing its permissions | Assigning it to users and organization members, and duplicating it |
| Webhook endpoint | `PATCH` (except a status-only re-enable), `DELETE`, archive, restore, `rotate-secret`, `revoke-previous-secret` | Delivery views, retries, test sends, a status-only `PATCH` to re-enable |

Responses carry `provisioned: true` (an endpoint also `ownerService`), and the admin UI shows a
"Managed by provisioning" badge and hides the change controls.

## CLI

```sh
npm run cli -- provision [--path <path>] [--dry-run]
npm run cli -- provisioning-schema
```

- `provision` loads, validates and applies `--path` or `PROVISIONING_PATH`, as start does, and prints
  what changed as JSON (`created`, `updated`, `rotated`, `unprovisioned`, `declared`, `access`,
  `roles`). It needs core's environment: the database, `CORE_KEK` (or stored keys), the
  `secretFrom` variables and `REDIS_URL`, through which it delivers live permission pushes to
  signed-in users. On any problem it prints every one and exits non-zero. With no path set it says
  so and exits 0.
- `--dry-run` validates and checks against the database, then rolls back, printing what would
  change. It writes nothing to the provisioned state. On a never-started database it can still
  create the rows `loadKeys()` and the default organization need.
- `provisioning-schema` prints the JSON Schema.

Run `provision --dry-run` in a pipeline before rolling out, to catch a bad set before core refuses
to start on it.

## Helm

With the chart, put each document under `provisioning.documents`, a map of file name to document:

```yaml
provisioning:
  documents:
    product:            # rendered as product.json
      version: 1.4.0
      service:
        slug: product-service
        name: Product
        secretFrom: PRODUCT_CLIENT_SECRET
        access:
          roles: [file_user]
```

The chart renders them as a ConfigMap, mounted at `/etc/tereo/provisioning`, where it points
`PROVISIONING_PATH`. To mount a ConfigMap your pipeline builds from the services' generated files
instead, set `provisioning.existingConfigMap` (one `*.json` key per document); the chart then
renders none of its own. With neither set, nothing is mounted and `PROVISIONING_PATH` stays unset.

A `post-install,post-upgrade` hook Job runs `provision` with core's full environment (every key of
`secrets.existingSecret` and `extraEnvFrom`, `REDIS_URL` included), so changed documents take
effect on each `helm upgrade` without restarting core, and a bad set fails the release rather than a
pod start. Tune it with `provisioning.job.backoffLimit` and `activeDeadlineSeconds`. Core also
applies the documents at start. A change to the documents does not roll core's pods.

Secrets referenced by `secretFrom` must be keys of `secrets.existingSecret` (or of the Secret
`secrets.externalSecret` builds) or come from `extraEnvFrom`:

```sh
kubectl patch secret tereo-secrets --type merge \
  -p "{\"stringData\": {\"PRODUCT_CLIENT_SECRET\": \"$SECRET\"}}"
```

## Adding a service

1. Generate a secret (`npm run cli -- generate-secret`) and give it to both sides: core's
   environment, under the name the document's `secretFrom` uses, and the service's environment as
   `CORE_CLIENT_SECRET`.
2. Add the service's document to the path (a `provisioning.documents` entry, or the file the
   service's build generated).
3. Apply it: `helm upgrade`, a restart, or `provision`. Core creates the service, its OAuth
   client and its service account, grants its access and declares what it owns.
4. Start the service with `CORE_URL`, `CORE_CLIENT_ID` (its `clientId`) and `CORE_CLIENT_SECRET`.
   It calls nothing at boot to be known.

## Migrating

From `PROVISIONING_FILE` (YAML, 0.2.0):

1. Rename the variable to `PROVISIONING_PATH`; point it at a folder (or one file) of JSON.
2. Convert each `services[]` entry to a document `{ "version": "…", "service": { … } }` and the
   `clients[]` entries to `clients`. The fields are unchanged. Quote nothing as a number: write
   versions as strings.
3. Helm: the `provisioning` value is now `provisioning.documents` (a map of file name to
   document) or `provisioning.existingConfigMap`.
4. Run `provision --dry-run` with the new documents.

From service registration:

1. Move each service's `register()` declaration (`permissions`, `systemRoles`, `buckets`,
   `eventTypes`) into its document's `service`, and `requestedAccess` into `access`. A service
   builds the document from the SDK's types and writes it with `JSON.stringify`; see
   `@tereo-io/sdk`.
2. Delete the `register()`, `isRegistered()`, `whenRegistered()` and `getRegistration()` calls.
   `POST /v1/registry/declaration` no longer exists.
3. Services now exist only through provisioning or `POST /v1/admin/services` (a service with a
   client and account that declares nothing). List every role and audience the service needs in
   `access`: a request still `pending` from a registration is deleted by the migration.
4. The admin UI's Access Requests page and the `core.service.access-requested` event type are gone.

