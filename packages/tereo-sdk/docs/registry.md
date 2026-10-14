# Registration — @tereo-io/sdk

`core.register(declaration)` tells core, at every boot, what the service owns and the access it
needs. Code: `src/clients/registry.ts` (`RegistryClient`), types in `src/types/registry.ts`. Core's
side — namespaces, approval, retirement — is in core's
[registry notes](../../tereo/docs/registry.md).

```ts
await core.start();
await core.register({
  permissions: [{ name: "product.items.read", displayName: "Read items" }],
  systemRoles: [{ name: "product_reader", displayName: "Product reader", permissions: ["product.items.read"] }],
  buckets: [{ bucketName: "product-images", policy: "private" }],
  eventTypes: [{ eventType: "product.item.created", description: "Item created" }],
  requestedAccess: { roles: ["file_user", "webhook_publisher", "audit_writer"], audiences: ["reporting-service"] },
});
```

## Declaration

| Field | Item shape | |
|-------|-----------|---|
| `permissions` | `{ name, displayName, description?, orgAssignable? }` | `name` is `<namespace>` or `<namespace>.…`. `orgAssignable` (default false): a role assigned within an organization may grant it — only for a permission whose every use stays inside the caller's organization |
| `systemRoles` | `{ name, displayName, description?, permissions }` | `name` is `<namespace>_<name>` (`product_reader`); core refuses anything else with `400 invalid_role_name`. Only permissions this same declaration lists |
| `buckets` | `{ bucketName, description?, policy?, storageQuotaBytes? }` | `<namespace>-…`; policy and quota apply when the bucket is created |
| `eventTypes` | `{ eventType, description? }` | `<namespace>.…` |
| `requestedAccess` | `{ roles?, audiences? }` | Roles: a bare name for core's, `<slug>/<name>` for another service's. Audiences: slugs of services that may introspect this service's tokens |

| `version` | string | The release's semver, `MAJOR.MINOR.PATCH[-prerelease]`. Defaults to `npm_package_version`, else the `version` in `./package.json`; `register` rejects when there is none |

All fields are optional. Something dropped from the declaration is retired by core. Core ignores a
declaration older than the version it applied last, so a replica of an earlier release that
restarts after a rollout cannot undo it; give every release that changes the declaration a new
version.

## Result

`RegistrationResult`: `{ service, applied, changed, access }`. `applied` is false when core ignored
the declaration as older than the one it applied (logged as a warning; the service still counts as
registered). `changed` is false when nothing was applied, or core already had this exact
declaration. Each `access` item is `{ id, kind: "role" | "audience", target, status }` with
status `pending`, `approved` or `revoked`; only `approved` access applies. Pending items are logged
as a warning until an admin approves them under `/v1/admin/services`. Another service's role grants
only the permissions its approval recorded: when that service adds permissions to the role, the
access is `pending` again, the service keeps what was approved, and the additions apply once an
admin approves them.

## Retries

`register` posts to `POST /v1/registry/declaration` and retries, with jittered backoff from 1 s doubling
to a minute, while the cause is one time fixes:

- no response (core unreachable), 5xx, 429 or 401;
- 422 `invalid_requested_access` — a requested role whose service has not registered yet.

Anything else rejects at once — a declaration that breaks a namespace rule, names something another
service owns, or a caller that is not a service. Fix it and redeploy. `core.stop()` ends a
registration still retrying (it rejects with `Registration aborted`).

## Readiness

| | |
|---|---|
| `core.isRegistered()` | True once core has accepted the declaration. Answer not-ready until then |
| `core.whenRegistered()` | Resolves with the result; rejects if registration failed or was never started |

While a registration is pending, the [outbox](outbox.md) reaper sends nothing, so events never reach
core before their event types do.

The declared event types also become the ones `webhooks.emit` and `outbox.emit` accept, unless
`createCoreClient` was given `eventTypes` explicitly.
