# Provisioning

A deploy can declare the app services and login clients core should have, in one YAML file. Core
reads it at every start and makes the database match, so a fresh environment comes up with its
services, their secrets and their access already in place, with no one calling `POST
/v1/admin/services` by hand. Use it when the environment is built from code (GitOps, the Helm chart,
Compose); services and clients made in the admin UI keep working beside it.

Set `PROVISIONING_PATH` to the file's path. Unset, nothing happens: core neither applies nor
retires anything, so rows a file provisioned earlier stay `provisioned` — read-only in the admin API
— and are never retired. To release them, deploy an empty file (`services: []`, `clients: []`)
instead: its entries are then removed as below, after `REGISTRY_RETIREMENT_GRACE_HOURS`. With the
Helm chart, put the file's contents under the `provisioning` value; the chart mounts it and sets the
variable.

## The file

```yaml
services:
  - slug: billing-service # required: lowercase words joined by hyphens, max 64
    name: Billing # required, max 100
    namespace: billing # default: slug without a trailing "-service"
    clientId: billing-service # default: slug
    secretFrom: BILLING_CLIENT_SECRET # required: an environment variable's name
    access:
      roles: [file_user, audit_writer] # core roles the service may have
      audiences: [orders-service] # services whose APIs it may call

clients:
  - clientId: billing-web # required, max 64
    name: Billing web app # required, max 100
    clientType: public # public (default) or confidential
    secretFrom: BILLING_WEB_SECRET # confidential clients only, and required for them
    redirectUris: [https://billing.example.com/callback]
    postLogoutRedirectUris: []
    scopes: [openid, profile, email]
    grantTypes: [authorization_code, refresh_token] # the default
    audience: [billing-service] # services its tokens may name
    consentRequired: true # default; false skips the consent screen
```

Both lists are optional, and unknown keys are refused, so a typo is caught rather than ignored.

| Field | Rule |
|-------|------|
| `services[].slug`, `namespace` | Lowercase words joined by hyphens; each unique in the file. The namespace prefixes everything the service declares ([registry](registry.md)) |
| `services[].clientId` | The service's OAuth client ID. Unique across services and clients |
| `services[].access.roles` | Only roles marked requestable, named bare: `tenant_resolver`, `user_resolver`, `file_user`, `webhook_publisher`, `audit_writer`, `notification_sender`. `admin`, `platform_admin`, the `*_admin` roles and any `core/<name>` spelling are refused |
| `services[].access.audiences` | Not core, and not the service itself |
| `clients[].clientType` | A `public` client has no secret (`secretFrom` is an error); a `confidential` one needs it |
| `clients[].redirectUris`, `postLogoutRedirectUris` | Safe URLs: `https`, or loopback `http` |
| `clients[].audience` | Not core. Unlike a hand-made client's audience, no `services.approve` is involved: the file is the deploy's decision |
| `clients[].consentRequired` | `false` skips consent for this client after a login, unless the request asks for a `core:*` scope: those always show the consent screen. It grants no core API access |

A login client's `scopes` and `audience` take effect as they do for clients made in the admin UI
([auth](auth.md)).

## Secrets

The file never holds a secret. `secretFrom` names an environment variable of the core process, and
core reads the value from there. Under Helm that means the variable must be a key of
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
- is used by two entries in the file;
- is the same value as another environment variable of core (so a database password pasted into a
  client secret is caught);
- is the entry's previous secret (see rotation below).

Every message names the variable and the rule. A secret's value, or any part of it, is never printed,
logged or put in an audit entry. Secrets core generates itself (a client made in the admin UI,
`regenerate-secret`) use the same format.

## What core does at start

The file is applied whole, or not at all. If any entry is wrong (an unknown key, an unset variable, a
weak secret, a duplicate), core logs every problem and **does not start**, and nothing is written.
Fix the file or the environment and restart. With several replicas starting together, one applies
and the others wait for it, then find nothing left to do.

For each entry core creates the service or client, or updates it to match the file. These rows are
marked `provisioned`. Everything core does here is done as its system user, audited like any admin
change.

A file entry whose slug or client ID matches an existing row that is **not** provisioned is an
error naming it, and core does not start: it never adopts a hand-made row. Delete or rename the
hand-made row, or change the entry.

## Adding a service

1. Generate a secret and give it to both sides: core's environment, under a name of your choice, and
   the new service's environment as its client secret.

   ```sh
   npm run cli -- generate-secret
   ```

   With Helm, add it to the Secret that `secrets.existingSecret` names:

   ```sh
   kubectl patch secret tereo-secrets --type merge \
     -p "{\"stringData\": {\"REPORTS_CLIENT_SECRET\": \"$SECRET\"}}"
   ```

2. Add the entry. In Helm values:

   ```yaml
   provisioning:
     services:
       - slug: reports-service
         name: Reports
         secretFrom: REPORTS_CLIENT_SECRET
         access:
           roles: [file_user, user_resolver]
   ```

3. Restart core (`helm upgrade` does this: the chart's `checksum/provisioning` annotation rolls the
   pods when the file changes). Core creates the service, its OAuth client and its service
   account, with client ID `reports-service` and the secret you set.

4. Start the new service with `CORE_CLIENT_ID=reports-service` and `CORE_CLIENT_SECRET` set to the same secret. It registers at boot
   as usual ([registry](registry.md)); what it requests that the file already lists is approved, and
   the rest waits for an admin.

## Pre-approved access

`access.roles` and `access.audiences` are stored on the service. When the service requests one of
them, core approves the request itself, as its system user, with no one clicking. This is only for a
request **never decided before**:

- A request that comes back to `pending` because another service's role gained permissions waits
  for an admin.
- A request an admin revoked waits for an admin, even if the file still lists it.

So the file can grant access first, and an admin's later decision always stands. Removing an item
from `access` does not revoke what was approved; revoke it in the admin UI.

## Rotating a secret

Change the environment variable's value (a new `generate-secret`, updated in the Secret) and
restart core. The old secret moves to the service's previous secret and keeps working for
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

## Removing an entry

Delete the entry from the file. Core marks the row as removed the next time it starts and keeps it
for `REGISTRY_RETIREMENT_GRACE_HOURS` (default 24), so a rollback or a rolling deploy that briefly
runs an older file does nothing. After that the hourly retirement job

- **deactivates** a service: its tokens are revoked and it cannot get new ones; its data and
  history stay;
- **deletes** a login client, as the admin delete does.

An entry that returns to the file, before or after, is reactivated: a deactivated service becomes
active again. A deleted login client is created anew.

## Managed rows

A provisioned service or client changes only in the file. The admin API refuses to edit,
delete, deactivate or regenerate the secret of one, with `409` and code `managed_by_provisioning`:

| Row | Refused | Still allowed |
|-----|---------|---------------|
| Service | `PATCH /v1/admin/services/:id` (rename, deactivate), `regenerate-secret` | Approving and revoking its access; `revoke-previous-secret`, to end a rotation's overlap at once |
| Login client | `PATCH`, `DELETE`, `regenerate-secret` on `/v1/admin/clients/:id` | Reading it |

Responses carry `provisioned: true`, and the admin UI shows a "Managed by provisioning" badge and
hides the change controls, keeping access decisions and "End Overlap Now".
