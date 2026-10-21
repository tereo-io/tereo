# Integrations

An **integration** is a machine client for an external party: a carrier, a partner's system, a
vendor's webhook consumer. It signs in with `client_credentials`, acts as a service account, and
holds only the roles an admin gives it. It is not an app service: it declares nothing (no
permissions, roles, buckets or event types), has no namespace and never registers anything. It
cannot emit events: `POST /v1/webhooks/events` refuses it (`403`) whatever it holds.

It is a `core.services` row with `kind = 'integration'`, `namespace` null and an optional fixed
`organization_id`, so it shares the service slug space (a slug is either a service or an
integration, never core's) and its secret handling, and `/v1/admin/services` neither lists nor
opens it. It lives under `/v1/admin/integrations` (`integrations.read` to read,
`integrations.write` to change, `integrations.admin`; all global-only), and in the admin UI under
Integrations.

## Org-bound or platform

| | Org-bound | Platform |
|---|---|---|
| Created with | an `organizationId` (an existing, unarchived organization; an inactive one is accepted) | none |
| Tokens carry | that `org_id` | no organization |
| Roles | custom, **org-assignable** roles, held as the account's roles **in that organization** | any custom or system role, held **globally** |
| Account | a member of the organization | a user with global roles |
| `/oauth/check-permission` | answered for that organization's members, as for any organization client | refused: only a service's client may ask without an organization |
| Webhook endpoints | in its organization | `organizationId: null`, sent every organization's events |

The organization cannot be changed. A platform integration given a global role holds it
everywhere, so grant sparingly: the admin UI warns when you do.

## Roles

An integration holds roles; it has no permission list of its own. Setting them
(`PUT /v1/admin/integrations/:id/roles`, `{ roleIds }`, replacing the set, `[]` clears) obeys the
same rules as granting to a person:

- Org-bound: only custom roles whose every permission is org-assignable (`400 not_org_assignable`),
  never a system role (`403`).
- Platform: custom or system roles; `unknown_role` for one that does not exist.
- **The approver holds what they grant**: the caller must hold every permission the roles carry
  (`403` naming those lacking), as in [auth](auth.md#granting-only-what-you-hold). Removing roles
  is not checked against what the caller holds.
- An integration can never hold a role carrying the root `admin` permission, whoever grants it:
  `403 role_not_allowed_for_integration`. Provisioning refuses one too, and a role an integration
  holds cannot gain `admin` or be reactivated carrying it ([auth](auth.md)).

A change to roles revokes the integration's tokens, so the new set applies at once.

## Audiences

`PUT /v1/admin/integrations/:id/audiences` (`{ slugs }`, up to 100) names the services whose APIs
the integration may call: the token's `aud` lists them and they may introspect it. Each must be an
app service that is not core; an integration, core or an unknown slug is `422 invalid_audience`. A
change revokes its tokens. Naming a service lets it read the integration's tokens, so the caller
needs `services.approve` too (`403` otherwise), as for a client's audience.

## Secrets

Creation (`POST /v1/admin/integrations`, `{ name, slug?, organizationId? }`) returns the
`clientId` and `clientSecret` once, in `credentials`; the secret has the `tereo_sk_` format of every
core secret. `POST …/:id/regenerate-secret` returns a new one and keeps the old working for
`SERVICE_SECRET_OVERLAP_HOURS`; `POST …/:id/revoke-previous-secret` ends the overlap at once. A
provisioned integration takes its secret from the environment variable its `secretFrom` names and
rotates when that value changes ([provisioning](provisioning.md#rotating-a-secret)).

Deactivating (`PATCH` with `isActive: false`) deactivates its account and revokes its tokens;
reactivating restores it.

## Provisioning

A deploy can declare integrations in the `integrations` section of a
[provisioning document](provisioning.md#integrations): `slug`, `name`, optional `organizationId`,
`secretFrom`, `roles` and `audiences`. They are then `provisioned`: read-only through the admin API
(`409 managed_by_provisioning`) apart from `revoke-previous-secret`, and deactivated after the
retirement grace when a document stops listing them. Role names resolve within the set: an org-bound
integration uses org-assignable custom roles of the set; a platform one may also use core roles and
`<slug>/<name>` system roles of services.

## Webhooks they own

An integration manages its own webhook endpoints through `/v1/webhooks/webhooks` with its token,
with no `webhooks.*` permission; it sees and changes only the endpoints it owns, and delivery to
them is gated on the integration's own read permissions. Others see them only with
`webhooks.admin`, who may pause, archive, restore and delete them but not change or rotate them
(`409 managed_by_integration`). The full rules are in [webhooks](webhooks.md#integration-owned-endpoints).

## Addressed events

An app service can send an event to specific integrations (or services) rather than to every
subscriber: `recipients` on `POST /v1/webhooks/events`, `emitTx` or the SDK's `core.outbox.emit`
lists their slugs (de-duplicated and sorted), and only those owners' endpoints receive it, each still subject to its own read
permission. See [webhooks](webhooks.md#addressed-events).

## Events and audit

`core.integration.created`, `.updated` (rename, reactivate, roles or audiences changed),
`.deactivated`, `.secret-regenerated` and `.previous-secret-revoked` are emitted under the default
organization, read with `integrations.read`. Every write, provisioned or not, is audited (entity
`Integration`), under the admin, or the system user for provisioning.
