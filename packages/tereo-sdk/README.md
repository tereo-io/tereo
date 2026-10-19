# @tereo-io/sdk

The SDK app services use to reach [tereo](https://github.com/tereo-io/tereo): auth, files, webhooks and
audit over one set of credentials — the `client_id` and `client_secret` an admin got from
`POST /v1/admin/services`.

```sh
npm install @tereo-io/sdk
```

It is ESM only, built and tested on Node.js 22, and needs an `ioredis` client (`redis`, below).

```ts
import { createCoreClient, requestIdMiddleware } from "@tereo-io/sdk";
import { Redis } from "ioredis";

const core = createCoreClient({
  service: "product-service",          // its slug, as core knows it
  url: process.env.CORE_URL,           // these four default to the env names shown
  clientId: process.env.CORE_CLIENT_ID,
  clientSecret: process.env.CORE_CLIENT_SECRET,
  requestHandlerKey: process.env.REQUEST_HANDLER_KEY,
  redis: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
  outbox: { db: prisma },              // optional: the transactional outbox
});
await core.start();

// What this service owns, and the access it needs, is not sent at boot: the build writes a
// provisioning document (see docs/provisioning.md) and the deploy pipeline hands it to core.

app.use(requestIdMiddleware());
app.use(core.auth.requireAuth);

await core.files.uploadObject("product-images", "a.png", { file, contentType: "image/png" });

// Audit entries and events that must not be lost: in the same transaction as the change.
await prisma.$transaction(async (tx) => {
  const item = await tx.item.create({ data });
  await core.outbox.audit(tx, { userId, action: "CREATE", entityType: "Item", entityId: item.id });
  await core.outbox.emit(tx, { organizationId, eventType: "product.item.created", entityType: "Item", entityId: item.id, data: item });
});

await core.stop();
```

## Sending notifications

Core sends the message through a connection an admin configured (email first). Ask for the
sender role in the service's provisioning document (`access.roles`); until it is applied, requests are refused with 403:

```ts
// provisioning document: service.access.roles includes "notification_sender"

// Direct: throws on failure; an idempotencyKey is generated when you give none.
const { id } = await core.notifications.send({
  channel: "email",
  recipients: [{ address: "ops@example.com" }, { userId, as: "cc" }],
  content: { subject: "Order shipped", text: "…", html: "…" },
});
const sent = await core.notifications.get(id); // status and deliveries

// Not to be lost: in the transaction that makes the change; the reaper sends it after commit.
await prisma.$transaction(async (tx) => {
  await tx.order.update({ where: { id: orderId }, data: { shippedAt: new Date() } });
  await core.outbox.notify(tx, { channel: "email", recipients, content });
});
```

`notify` refuses an unknown channel, fewer than 1 or more than 50 recipients, or an email with no
`to` recipient (one without `as` counts as `to`) at once. Core
validates the rest (allowed senders, users, attachments) when the reaper relays the row; a 4xx
other than 401, 403, 408, 409 or 429 dead-letters it.

## `createCoreClient(options)`

One per process — a second call throws until the first client is stopped.

| Option | Default | |
|--------|---------|---|
| `service` | — (required) | The service's slug. The `source` of its audit entries, and what audit reads are scoped to |
| `url` | `CORE_URL` | Core's base URL |
| `clientId` / `clientSecret` | `CORE_CLIENT_ID` / `CORE_CLIENT_SECRET` | From *Add service* in core |
| `requestHandlerKey` | `REQUEST_HANDLER_KEY` | Encrypts what the request handler stores; 32+ characters |
| `redis` | — (required) | An ioredis client with `maxRetriesPerRequest: null`. Owned by the caller |
| `production` | `NODE_ENV === "production"` | Production handlers take priority over others sharing the Redis |
| `auth` | `{}` | `publicRoutes` and `defaultTestPermissions` for `auth.requireAuth` — see [auth](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/auth.md) |
| `eventTypes` | any type | Event types `webhooks.emit` and `outbox.emit` accept |
| `outbox` | none | The transactional outbox — see [outbox](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/outbox.md). Without it, reading `core.outbox` throws |
| `channelPrefix` | none | Core's `REDIS_KEY_PREFIX`, when it sets one: the file cache hears core's invalidations on channels under it |
| `testMode` | `false` | For an app's tests: accept `test-token-…` tokens and stub `auth` lookups and `files` — see [testing](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/testing.md). Throws with `NODE_ENV=production` or `production: true` |

A missing `url`, `clientId`, `clientSecret` or `requestHandlerKey` (option and env both) throws at
once, naming the option and its env variable.

The returned `CoreClient`:

| Member | |
|--------|---|
| `auth` | `AuthServiceClient` — token introspection, `requireAuth`/`requirePermission`, user and organization lookups. [docs/auth.md](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/auth.md) |
| `files` | `FileServiceClient` — objects, buckets, permissions, versions, presigned URLs, archives, shares, lifecycle, multipart. [docs/files.md](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/files.md) |
| `webhooks` | `WebhookServiceClient` — best-effort event emission; `createWebhookVerifier` for receivers. [docs/webhooks.md](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/webhooks.md) |
| `audit` | `AuditLogServiceClient` — best-effort writes and reads of this service's entries. [docs/audit.md](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/audit.md) |
| `notifications` | `NotificationsClient` — `send` an email through core, `get` one back with its deliveries. See [Sending notifications](#sending-notifications) |
| `outbox` | `OutboxClient` — audit entries, events and notifications written in the app's own transaction. [docs/outbox.md](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/outbox.md) |
| `start()` | Starts the request handler, the file cache's invalidation subscriber and the outbox reaper. Call once at boot |
| `stop()` | Stops the reaper, the cache subscriber and the handler; another client may then be created |

Testing — `testMode`'s test tokens and stubs, and the no-op clients — is in
[docs/testing.md](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/testing.md).

## How it connects

Every call goes through one `@dianemo/core` request handler (`src/handler.ts`) with one client for
core, `CORE_CLIENT`: OAuth client credentials against `${url}/oauth/token`. Its twin,
`CORE_PUBLIC_CLIENT` (`<CORE_CLIENT>:public`), sends the same credentials as Basic auth, for
introspection. The handler's Redis keys are prefixed `@tereo-io/sdk:<clientId>`, so replicas of
a service share tokens and rate limits and two services on one Redis never mix them.

The handler retries a 5xx, a 429 and a dropped connection (`ECONNRESET`, `ETIMEDOUT`). So that a
retry never writes twice:

- `audit.log`/`logAsync`/`logBatchAsync` and `webhooks.emit`/`emitAsync`/`emitBatchAsync` send an
  `idempotencyKey` generated once per call (unless the caller gave one), which core dedupes for
  24 hours.
- Creates core cannot dedupe — `createShare`, `initiateMultipart`, `createBucket`, `createArchive`,
  `grantBucketPermission` and `restoreObjectVersion` — go through `CORE_ONCE_CLIENT`
  (`<CORE_CLIENT>:once`), which shares the token but fails at once on a 5xx or a dropped
  connection, since core may already have written. A 4xx, 429 included, is retried as usual.

When core answers 401 to the cached service token — revoked, or signed with a key core has since
rotated — the SDK drops the token and retries the call once with a new one. A call whose body is a
stream (`uploadObject`) is not retried.

What a call may do is what the service's provisioning document grants — see
[docs/provisioning.md](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/provisioning.md) and core's
[provisioning](https://github.com/tereo-io/tereo/blob/master/packages/tereo/docs/provisioning.md) notes. The read caches (introspection, users,
organizations, buckets, object metadata) live in the same Redis, under the same
`@tereo-io/sdk:<clientId>` prefix, so no service reads another's; a Redis failure falls
through to core. Mount `requestIdMiddleware()` to give each
request an `X-Request-ID` and forward it on the calls made to core while handling it.

Errors from core reach the caller as `RequestError`: `code` is the SDK's code for the call
(`FS_0013`), `httpStatus` the status core answered with (undefined after a network failure) and
`coreCode` core's `error` code (`not_found`, `idempotency_key_conflict`). `statusCode` stays 500, what
an app forwarding the error should answer. `getOriginalStatus(err)` and `getOriginalResponseData(err)`
give the status and body. A 4xx (but 429) is logged at debug — often expected, as when `getUser`
turns a 404 into `null` — and anything else at error. The auth middleware throws `UnauthorizedError` / `ForbiddenError` (both `HttpError`)
into the app's error handler. Input that core would refuse, or that a URL or header could not carry
intact, is refused before anything is sent with `InvalidRequestInputError` — a path parameter that is
empty, `.` or `..`, an object key core refuses by shape, tags past core's limits. Every path parameter
is sent escaped as one segment.

The request handler and its transport-level types are published separately as
`@tereo-io/sdk/handler`, because several of them share names with the SDK-level types.

## Layout

One package, folders by kind, no per-area modules:

| Path | Holds |
|------|-------|
| `src/index.ts` | Every export: `createCoreClient`, then outbox, provisioning types, auth, files, webhooks, audit, errors |
| `src/coreClient.ts` | `createCoreClient` and `CoreClientOptions` |
| `src/handler.ts` | The request handler (one per process), `CORE_CLIENT` / `CORE_PUBLIC_CLIENT`, `requests`, transport-level types |
| `src/clients/` | `auth.ts`, `files.ts`, `webhooks.ts`, `audit.ts`, `notifications.ts`, `outbox.ts` |
| `src/templates/` | The one client template, `tereo`, and its request-id interceptor |
| `src/requests/` | Request definitions, mirroring core's URL areas: `auth/`, `files/`, `webhooks/`, `audit/`, `notifications/` |
| `src/types/` | SDK-level types, one file per area |
| `src/utils/` | Errors, caches, test tokens, webhook verification, audit helpers, outbox table SQL |
| `src/tests/` | Unit tests |

## Status

One package, one client on core's paths, the outbox, and the types of the provisioning document.

It depends on the published `@dianemo/core` `^2.0.0`. Nothing in `tereo` depends on this
package.

## Commands

```sh
npm run build   # tsc
npm run check   # tsc --noEmit
npm test        # vitest
npm run clean   # remove dist/
```
