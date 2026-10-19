# Auth — @tereo-io/sdk

`core.auth` is an `AuthServiceClient` (`src/clients/auth.ts`, types in `src/types/auth.ts`): it
verifies the Bearer tokens an app service receives, by introspecting them with core, and looks up
users and organizations. Configure it with `createCoreClient({ auth })`:

| `auth` option | Default | |
|---------------|---------|---|
| `publicRoutes` | `[]` | `{ pattern: RegExp, methods? }[]` — requests matching `pattern` (path without query) and a method (default `GET`, `HEAD`) pass `requireAuth` when they carry no `Authorization` header |
| `defaultTestPermissions` | `[]` | Permissions a test token gets when it names none — see [testing](testing.md) |
| `introspectionCacheTtlSeconds` | `60` | Longest time an active introspection is cached (never past the token's `exp`). A signed-out or revoked token stays accepted by this service for up to this many seconds; `0` asks core on every request |

## Middleware

```ts
app.use(requestIdMiddleware());
app.use(core.auth.requireAuth);
router.get("/items", core.auth.requirePermission("product.items.read"), listItems);
```

| | |
|---|---|
| `requireAuth` | Reads `Authorization: Bearer …`, introspects it and sets `req.auth`. A missing, invalid or expired token throws `UnauthorizedError` (401) |
| `requirePermission(permission)` | After `requireAuth`. Throws `ForbiddenError` (403) unless `req.auth.permissions` grants `permission` |
| `validateUser(req)` | Returns `req.auth`, or throws `ForbiddenError` |
| `validateOrganization(req, organizationId?)` | Returns `req.organization` (set by the app, not the SDK), or throws `ForbiddenError` when it is missing; with `organizationId`, throws `NotFoundError` (404) when it differs, so another organization's resource reads as absent rather than as someone else's |

All are arrow-function properties, safe to destructure. Errors go to the app's error handler with
`statusCode` and `code` (`unauthorized`, `forbidden`, `not_found`).

Permissions are hierarchical: `read` < `write` < `archive` < `delete` < `admin` on the same base
(`product.items.write` grants `product.items.read`); `<base>.admin` also covers every permission
under `<base>.`; plain `admin` grants everything.

`req.auth` is an `AuthContext`: `userId` (introspection's `user_id` — the user's id, or for a
client_credentials token its client's service-account user), `email`, `name`, `userType` (`human`
when the token was issued for a user — its `sub` is not its `client_id` — and `service_account` for
a client_credentials token), `permissions`, `currentSessionId`, `oauthClientId` (the token's
`client_id`), `organizationId`, `organizationName`.

`requireAuth` sets `user.id`, `user.roles` (the user type), `tereo.org.id` and
`tereo.oauth.client_id` on the active span; `requirePermission` sets
`tereo.permission.required`. No-ops outside a trace.

## Methods

| Method | Returns | Cache |
|--------|---------|-------|
| `introspectToken(token)` | `IntrospectionResponse` — `{ active: false }` on any failure, including core being unreachable, which is logged at error | Active results up to `introspectionCacheTtlSeconds` (60 s), keyed by the token's SHA-256 |
| `getUser(userId)` | `AuthServiceUser \| null` (null on 404) | 5 min; not-found 60 s |
| `getUsers(userIds)` | `Map<userId, AuthServiceUser \| null>` — cache misses fetched together, one `GET /v1/admin/users?filter[id]=…&filter[id_op]=in` per 100 ids; a non-UUID id is null | as `getUser` |
| `validateUserExists(userId)` | `boolean` | as `getUser` |
| `getOrganization(id)` | `AuthServiceOrganization \| null` (null on 404) — `id` is the JWT `org_id` | 5 min; not-found 60 s |
| `getService()` | `AuthServiceOwnService` — this service as core knows it: `slug`, `namespace`, `declarationVersion`, `declarationHash` and `declaredAt` of the provisioning document core last applied, and `access` (`{ kind, target, status, decidedAt }[]`). `GET /v1/account/service` over `CORE_CLIENT`; needs no permission. Throws when the client belongs to no service (404). Use it at start to check the deploy's document has been applied | None |

Introspection uses `POST /oauth/introspect` over `CORE_PUBLIC_CLIENT` (the service's credentials as
Basic auth); users and organizations use `/v1/admin/users/:id` and `/v1/admin/organizations/:id` over
`CORE_CLIENT`, so the service needs access to read them. Core only reports a token active to this
service when it was issued to this service's own client, or its audience includes this service's
slug — an audience in the issuing service's provisioning document (`access.audiences`, see
[provisioning](provisioning.md)).

The cache is the Redis passed to `createCoreClient`, under `@tereo-io/sdk:<clientId>:auth-sdk:v1:`,
shared by the service's replicas and by no other service — another service's introspection says nothing
about whether core would report the token active to this one.
A Redis failure falls through to core.
