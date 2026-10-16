# Testing — @tereo-io/sdk

What an app service's tests can lean on, and what the SDK's own tests do.

## `testMode`

With `createCoreClient({ testMode: true })` some clients answer without calling core. It is an
explicit opt-in — `NODE_ENV=test` alone enables nothing — and `createCoreClient` throws when
`testMode` is combined with `NODE_ENV=production` or `production: true`, since it accepts forged
tokens.

```ts
const core = createCoreClient({ service: "product-service", redis, testMode: true });
```

In test mode:

| Client | Behavior |
|--------|----------|
| `core.auth.introspectToken` / `requireAuth` | A test token (below) is accepted as active without introspection; any other token is introspected as usual |
| `core.auth.getUser`, `getUsers`, `validateUserExists` | A mock user for any id (`test-user-{id}@example.com`) |
| `core.auth.getOrganization` | A mock organization for any id, with a `code` from the id's last block |
| `core.files.*` | Every method returns a stub or does nothing — e.g. `downloadObject` returns `Buffer.from("test-file-contents:{bucket}/{key}")` |

`core.audit`, `core.webhooks` and `core.outbox` are **not** stubbed: they call core (or,
for the outbox, the app's database) as usual. Use the no-op clients below, or drain the outbox
yourself.

`createCoreClient` still needs its `url`, credentials, `requestHandlerKey` and a Redis, and only one
may exist per process — `stop()` it in teardown before creating another.

## Test tokens

```
test-token-{userId}
test-token-{userId}|client={clientId}
test-token-{userId}|org={orgId}|org_name={name}|perms={perm1},{perm2}
```

Parts after the user id are optional and in any order. Without `perms`, the token gets
`createCoreClient({ auth: { defaultTestPermissions } })`. `client={clientId}` sets the token's
`client_id` (default `test-client`). The user id `service` resolves to
`createCoreClient({ testMode: true, testServiceUserId })` — a UUID, validated at creation — so a
test can act as a service user whose id is a real UUID; without it, the id stays `service`.
`testServiceUserId` is validated whenever it is passed, even without `testMode`, and a bad value
throws at creation. Values in a token (client id, org id and name, permissions) cannot contain `|`
or `=`, which delimit the parts.
`parseTestToken(token, defaultPermissions, { serviceUserId })`
(exported) returns the `ActiveIntrospectionResponse` a token stands for, or `null` when it is not a
test token.

## No-op clients

`AuditLogServiceClient.noop()` and `WebhookServiceClient.noop()` return clients whose methods do
nothing and return empty results (`assertEventType` accepts anything). Use them where a service
should run without core's audit or webhooks.

## The outbox

The reaper runs on a timer after `core.start()`. For deterministic tests, pass
`outbox: { db, dispatch: false }` so no timer runs, and call `core.outbox.processBatch()` to drain:
it claims one batch, dispatches it and returns how many rows it handled.

## The SDK's own tests

`src/tests/` holds unit tests (Vitest) — `npm test` from this package. They mock the request
handler, Redis or database with fakes; none needs a running core.
