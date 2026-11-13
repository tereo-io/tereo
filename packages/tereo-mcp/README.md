# @tereo-io/mcp

Serve an app service's tools over the [Model Context Protocol](https://modelcontextprotocol.io),
signed in through [tereo](https://github.com/tereo-io/tereo). You define tools and name the Tereo
permission each needs; the package handles the OAuth resource-server side, permission gating, error
handling, logging, rate limiting and the HTTP server, and runs your handler as a known user.

```sh
npm install @tereo-io/mcp
```

It is ESM only and built on Node.js 22. Peer dependencies: `@tereo-io/sdk`, `express` 5, `zod`
4.2 or later (the MCP SDK needs it) and `ioredis`; `@modelcontextprotocol/client` is an optional
peer, needed only for `@tereo-io/mcp/testing`.

Tools only: MCP resources and prompts are not supported.

```ts
import { createTereoMcp, ToolError } from "@tereo-io/mcp";
import * as z from "zod/v4";

const mcp = createTereoMcp({
  name: "query-service",                    // MCP server name shown to clients
  version: "1.0.0",
  core,                                     // CoreClient from createCoreClient(), already started
  publicUrl: "https://mcp.example.com",     // this server's public origin
  allowedClients: ["claude-connector", "chatgpt-connector"],
  redis,                                    // for the rate limit; omit only with rateLimit: false
  provisioning: document,                   // optional: the service's provisioning document
});

mcp.define({
  name: "list_connections",
  description: "List the database connections you can query",
  permission: "query.connections.read",
  readOnly: true,
  handler: async (_input, ctx) => listConnections(ctx.auth.userId),
});

mcp.define({
  name: "describe_connection",
  description: "Show a connection's tables",
  permission: "query.connections.read",
  readOnly: true,
  input: z.object({ connectionId: z.string() }),
  handler: async (input, ctx) =>                       // input: { connectionId: string }
    describeConnection(input.connectionId, { signal: ctx.signal }),
});

mcp.define({
  name: "run_query",
  description: "Run a read-only query against a connection",
  permission: "query.queries.run",
  readOnly: true,
  input: async (ctx) => querySchemaFor(ctx.auth.userId),   // per-user schema
  handler: async (input, ctx) => runQuery(ctx.auth, input),   // input: unknown
});

const server = await mcp.listen(4002);      // or: app.use(await mcp.router())
await server.close();
```

Clients sign in through Tereo, so each one needs a login client created there first; see
[connecting](https://github.com/tereo-io/tereo/blob/master/packages/tereo-mcp/docs/connecting.md).

## `createTereoMcp(options)`

| Option | Required | |
|--------|----------|---|
| `name`, `version` | yes | Reported to MCP clients |
| `instructions` | no | A non-empty string sent to clients at initialize: how to use this server's tools. See [Instructions and titles](#instructions-and-titles) |
| `core` | yes | The app's `CoreClient`. Its `service` slug is the audience core checks at introspection |
| `publicUrl` | yes | Public origin of this server, with no path; https unless the host is loopback. The MCP endpoint is `${publicUrl}${path}` |
| `allowedClients` | yes | Non-empty list of `client_id`s; tokens issued to any other client are refused |
| `path` | no | Default `/mcp`. Must start with `/` |
| `redis` | unless `rateLimit: false` | An `ioredis` client, owned by the caller |
| `rateLimit` | no | `{ perMinute }` (default 120; a positive integer) or `false` |
| `allowServiceAccounts` | no | Default `false`: `client_credentials` tokens are refused |
| `allowedOrigins` | no | Browser origins allowed to call the endpoint, such as `https://app.example.com` (`listen` only). See [Serving](#serving) |
| `scopes` | no | OAuth scopes advertised to clients, typically `["openid", "profile", "email"]`; advertised only, never required. See [Scopes](#scopes) |
| `provisioning` | no | The service's provisioning document, for the start-time permission check |
| `coreUrl` | no | Core's base URL, for fetching its authorization-server metadata at start. Default: the URL `core` was created with (`core.url`, which a client from an `@tereo-io/sdk` before 0.5.2 lacks), else `CORE_URL` |
| `logger` | no | A Pino logger. Default a new one named `@tereo-io/mcp` |
| `maxResultBytes` | no | Default 1 000 000; a positive integer. A larger result becomes a tool error instead of flooding the model |
| `toolTimeoutMs` | no | Default 60 000; a positive integer. How long a tool call may run. See [Timeouts and cancellation](#timeouts-and-cancellation) |

## `mcp.define(tool)`

| Field | Required | |
|-------|----------|---|
| `name` | yes | `[a-z0-9_]`, unique; a duplicate throws |
| `title` | no | A non-empty display name for people; clients show it in place of `name` |
| `description` | yes | Shown to the model |
| `permission` | yes | A non-empty Tereo permission name, or `null` for any signed-in user. The hierarchy is the SDK's: `write` includes `read`, `admin` includes all |
| `readOnly` | yes | Sets `readOnlyHint`. Required so an author has to state it |
| `destructive`, `idempotent` | no | `destructiveHint`, `idempotentHint` |
| `input` | no | `z.object(...)`, or `(ctx) => z.object(...)` (may be async) for a per-user schema. Omitted: no arguments |
| `output` | no | `z.object(...)`, static only. The result is validated and sent as structured content too. See [Structured results](#structured-results) |
| `handler` | yes | `(input, ctx) => value`. A string is returned as text; any other JSON value as JSON text |
| `timeoutMs` | no | A positive integer; overrides `toolTimeoutMs` for this tool |
| `rateLimit` | no | `{ perMinute }` (a positive integer) for the tool's own limit, or `false` for none. Unset: the server-wide limit. See [Rate limit](#rate-limit) |

`define` throws once the server has started (`router()` or `listen()` was called), and when a
field above is out of range; the message names the tool and the field. It also throws for a static
`input` or an `output` that JSON Schema cannot express (a `transform` on the output side,
`z.date()`, `z.bigint()`, a custom type): the MCP SDK converts both when it lists tools, and one
such tool would fail `tools/list` for every caller who can see it.

The handler's input is typed from a static `input`: with `input: z.object({ sides: z.number() })`
the handler sees `{ sides: number }` without an annotation, and with no `input` it sees
`undefined`. A function `input` is known only per request, so there the input is `unknown` unless
you annotate the handler's parameter. With `output`, the handler's return value is checked
against the schema at compile time.

An `input` function runs for every protocol message the caller sends (`initialize`, `tools/list`,
`tools/call`), not only for calls, because the server is built per request. Keep it cheap and free
of side effects. If it throws, returns anything but a `z.object(...)`, or returns one JSON Schema
cannot express, the error is logged as `MCP tool input schema failed` and that tool is left out
for that request; the caller's other tools still list and run.

### `ctx`

| Member | |
|--------|---|
| `auth` | The SDK's `AuthContext`: `userId`, `email`, `name`, `userType`, `permissions`, `clientId`, `scope`, `organizationId`, … |
| `core` | The `CoreClient`, for lookups (groups, users) and `outbox.audit` |
| `requestId` | Also on every log line for the call |
| `logger` | A Pino child logger carrying `tool`, `user_id` and `request_id` |
| `signal` | An `AbortSignal` for the call. See [Timeouts and cancellation](#timeouts-and-cancellation) |

### Instructions and titles

`instructions` is sent to clients when they connect, on both protocol eras; clients typically put
it in the model's context, so say there how the tools fit together. A tool's `title` is listed
with the tool in `tools/list` for clients to show people; the model still calls the tool by
`name`.

## Serving

`router()` and `listen()` are async and run the start checks once.

- `await mcp.router()` returns an Express router with the protected-resource metadata routes and the
  MCP endpoint behind bearer auth. Mount it at the app root (`app.use(await mcp.router())`, not
  `app.use("/x", …)`): the `401` challenge and the `/.well-known` routes assume `publicUrl` maps to
  `/`. The host app owns Host and Origin validation and body limits; use the MCP SDK's
  `hostHeaderValidation` and `originValidation` from `@modelcontextprotocol/express` (which changes
  the type of `req.auth`; see [below](#reqauth-in-the-host-app)). It also owns error handling:
  install a final JSON error handler, or Express answers a malformed body with its HTML error page,
  which outside production carries the stack. Mount the router ahead of an app-wide
  `core.auth.requireAuth`: its `/.well-known` routes take no token, and its endpoint checks the
  token itself.
- `await mcp.listen(port, host?, options?)` builds a standalone app, bound to `0.0.0.0` by default,
  that accepts the host of `publicUrl` (plus loopback names when `host` is loopback), and adds
  `GET /health`. It answers a request it rejects (a malformed JSON body, say) with JSON:
  `{ "error": "invalid_request" }` and the 4xx status, or `500 { "error": "server_error" }`. It
  resolves `{ port, url, close }` (type `Listening`): `port` is the bound port (pass `0` to pick
  one), `url` the endpoint as reached locally, and `close()` stops accepting connections, waits for
  in-flight calls to finish, and closes the MCP handler. Calls still running after
  `shutdownTimeoutMs` have their connections dropped and `close()` resolves anyway. `close()` also
  removes the signal listeners that `listen` installed.

### `req.auth` in the host app

`@modelcontextprotocol/express` and `@tereo-io/sdk` both declare `req.auth`: the MCP SDK as its
`AuthInfo`, on `express-serve-static-core`'s `Request`, and Tereo's SDK as its `AuthContext`, on the
global `Express.Request`. In a project that imports `@modelcontextprotocol/express` anywhere, the MCP
SDK's declaration wins, so `req.auth.userId` does not compile on the app's own routes (and with
`skipLibCheck` off, `@types/express-serve-static-core` reports TS2430). The value there is still the
`AuthContext` that `core.auth.requireAuth` set: read it with `core.auth.validateUser(req)`, which is
typed `AuthContext`, rather than casting `req.auth`. On the MCP endpoint `req.auth` is the MCP SDK's;
a tool gets the `AuthContext` as `ctx.auth`. A project that imports only `@tereo-io/mcp` and
`@tereo-io/sdk` is not affected.

### Shutdown

`listen`'s third parameter (type `ListenOptions`) controls shutdown:

| Option | Default | |
|--------|---------|---|
| `signals` | `["SIGTERM", "SIGINT"]` | Signals that shut the server down. `false`: install no listeners; the host handles signals itself and calls `close()` |
| `shutdownTimeoutMs` | `25000` | How long `close()` waits for in-flight calls before dropping their connections; also bounds `onShutdown`. A positive integer |
| `onShutdown` | none | Runs after the server has closed, before the process exits: stop the core client, close Redis |

`shutdownTimeoutMs` bounds the drain and `onShutdown` separately, so a shutdown can take about
twice that value (50 seconds by default): size a Kubernetes `terminationGracePeriodSeconds` above
it, or lower `shutdownTimeoutMs`.

With signals handled, `listen` owns the exit: on the first signal it logs `MCP server shutting down`,
runs `close()`, then `onShutdown`, and then **exits the process** with code `0`. The exit code is
`1` if the drain deadline was hit, if `close()` or `onShutdown` threw (logged at error as
`MCP server shutdown failed`), or if `onShutdown` had not settled within `shutdownTimeoutMs`. A
second signal during shutdown exits with `1` at once. Wire it like this:

```ts
const server = await mcp.listen(4002, undefined, {
  onShutdown: async () => { await core.stop(); redis.disconnect(); },
});
```

The SDK's request handler stops itself on the same signals and leaves the exit to any host that
listens for them, so without this a served process either lingers with its core client stopped,
refusing every token, or is killed mid-call. Tool handlers still running during the drain can no
longer call core, because the handler refuses new work once stopped, so such a call ends as an
internal error. `router()` installs no listeners and never exits: the host app owns its shutdown.

Browsers send an `Origin` header; other MCP clients do not, and a request without one is allowed.
With `allowedOrigins`, `listen` allows a browser request only from those origins, compared by
hostname (the MCP SDK's rule, so the scheme and port are not checked), plus the loopback hostnames
when `host` is loopback. Without it, a loopback bind allows only loopback origins and any other bind
checks no origin.

## Request flow

1. **Host and Origin** are checked by the standalone app (`listen`) or by the host app (`router`).
2. **Bearer token.** No token, or a bad one, answers `401` with
   `WWW-Authenticate: Bearer … resource_metadata="…"`, which is how a client finds Tereo.
3. **Verification.** The token is introspected through `core.auth.introspectToken`. Core reports a
   token active to this service only when its audience includes the service's slug. The token is
   refused when it is inactive, was issued to a client not in `allowedClients`, belongs to a service
   account (unless `allowServiceAccounts`), or has expired or carries no valid expiry. Every refusal answers `401` with the same
   message, `Invalid or expired token`; the real reason (`inactive`, `client_not_allowed`,
   `service_account`, `expired`) is logged at info as `MCP token refused`.
4. **Per-request server.** A server is built for each request with only the tools whose permission
   the caller holds. A tool the caller lacks is absent from `tools/list`, and calling it is
   indistinguishable from calling a tool that does not exist.
5. **Tool call.** Rate limit, then the handler, then result mapping, then one log line. Input that
   fails the schema never reaches the handler; the MCP SDK answers with a tool error.

A revoked token or a removed permission keeps working for up to the SDK's introspection cache TTL,
`auth.introspectionCacheTtlSeconds` on `createCoreClient` (60 seconds by default). Lower it if that
is too long.

No scopes are required. The protected-resource metadata, at
`/.well-known/oauth-protected-resource${path}`, names Tereo as the authorization server.

### Scopes

The server advertises no scopes by default, so MCP clients request none. Set `scopes`
(typically `["openid", "profile", "email"]`) and they are listed as `scopes_supported` in the
metadata, so clients request them at sign-in. That is what makes `ctx.auth.name` and
`ctx.auth.email` non-null: Tereo puts `name` in a token's details only with the `profile` scope and
`email` only with `email`.

- The scopes are advertised, not required: a token without them is still accepted, and the `401`
  challenge carries no `scope` parameter.
- The login client in Tereo must list them in its `scopes`, or core will not grant them.
- `offline_access` is never advertised; a resource server must not, and `scopes` refuses it.
- Without the scopes, look the user up with `ctx.core.auth.getUser(ctx.auth.userId)`.

## Start checks

`router()` and `listen()` throw, with a message naming the tool or option, when:

- `publicUrl` is not a valid URL, has a path, query or fragment, or is http on a non-loopback host;
- `path` does not start with `/`;
- `allowedClients` is empty;
- `redis` is missing and `rateLimit` is not `false`;
- a tool sets its own `rateLimit` and `redis` is missing;
- `rateLimit.perMinute`, `maxResultBytes` or `toolTimeoutMs` is given and is not a positive integer;
- `instructions` is given and is not a non-empty string;
- an `allowedOrigins` entry is not an http or https origin (scheme, host and optional port only);
- a `scopes` entry is empty, contains whitespace, a quote or a backslash, is repeated, or is `offline_access`;
- with `provisioning`, a tool needs a permission the document's service does not declare;
- none of `coreUrl`, `core.url` and `CORE_URL` is set, or Tereo's authorization-server metadata
  cannot be fetched from `${coreUrl}/.well-known/oauth-authorization-server`;
- the metadata's `issuer` is not https (plain http is allowed on `localhost` and `127.0.0.1`, as the
  MCP SDK requires) or has a query or fragment.

A failed start is not cached: the next `router()` or `listen()` runs the checks again.

## Timeouts and cancellation

Each call has a deadline: the tool's `timeoutMs`, else `toolTimeoutMs`, else 60 seconds. When it
passes, the call answers `Tool timed out after <n> ms` as a tool error, logged at warn with
outcome `timeout`. Whatever the handler returns or throws afterwards is discarded. The call
still counts toward the rate limit.

`ctx.signal` aborts:

- at the deadline, with a `TimeoutError` as its `reason`;
- when the client disconnects, on both protocol eras (the MCP SDK's per-request signal);
- when the client cancels the call, on the 2026 protocol era only. A 2026-era client cancels by
  aborting the call's own HTTP stream, which reaches the call. A 2025-era (legacy) client cancels
  by sending `notifications/cancelled` in a separate POST; since a server is built per request,
  that notification reaches a fresh server with no such call and is dropped. The handler runs on
  until it returns, throws or reaches its deadline, and is logged with that outcome;
- when a `listen` server's `close()` begins, including the shutdown on a signal, with an
  `AbortError`. `router()` has no `close()`, so there the signal aborts only at the deadline, on
  a disconnect or on a 2026-era cancel.

A handler that rejects with the abort, after a disconnect, a cancel or `close()` (the signal's
`reason`, or any `AbortError`, as `fetch` throws), ends as outcome `cancelled`, logged at info with
no `err`; a client still connected gets the tool error `Tool call cancelled`. Any other error stays
an internal error.

A timeout answers the client; it cannot stop a handler that ignores `ctx.signal`, which runs on in
the background, holding whatever connections and locks it has. Pass the signal to database and
HTTP calls (`fetch(url, { signal: ctx.signal })`, a query's abort option) so the work stops with
the call.

In an `input` function `ctx.signal` is the server's closing signal, shared by every request, not
one for the call: read `aborted` if you need to, but do not attach listeners to it there, or they
pile up for the life of the server.

## Structured results

With `output`, the tool is listed with that schema as its `outputSchema`, and the handler's return
value is parsed with it. A successful result is sent twice: as `structuredContent` (the parsed
value; a plain `z.object` drops unknown keys) and as its JSON in a text block, for clients that
read only text. `maxResultBytes` applies to that JSON.

```ts
mcp.define({
  name: "count_rows",
  description: "Count the rows in a table",
  permission: "query.connections.read",
  readOnly: true,
  input: z.object({ table: z.string() }),
  output: z.object({ table: z.string(), rows: z.number().int() }),
  handler: async ({ table }, ctx) => ({ table, rows: await countRows(table, ctx.signal) }),
});
```

A return value that does not match is an internal error: the model sees
`Internal error (request <id>)`, and the log line's `err` names the failing paths and issue
codes, never the values. A path names only fields the schema declares: a key of a `z.record`, a
`catchall` or a `z.map` comes from the result, so it is written `*`. Error results (`ToolError`,
timeouts, cancellations, the rate limit) carry no `structuredContent`.

The schema must accept its own parsed value, because the MCP SDK validates `structuredContent`
again with the same schema; one that does not (an `.overwrite()` that changes the value on every
parse, say) is reported the same way, so the SDK's own message, which may quote values, never
reaches the client. A schema JSON Schema cannot express is refused by `define`, as above.

Output validation runs after the handler, outside the tool's timeout. Keep output schemas
synchronous and cheap: no async refinements, no lookups.

## Errors

| Thrown by the handler | The model sees | Logged |
|-----------------------|----------------|--------|
| `ToolError(message)` | `message`, as a tool error | info, outcome `tool_error` |
| An SDK `HttpError` with status below 500 (`ForbiddenError`, `NotFoundError`, …) | Its message, as a tool error | info, outcome `tool_error` |
| Anything else | `Internal error (request <id>)`, as a tool error | error, with `err`, outcome `internal_error` |

A result over `maxResultBytes` is a tool error too (outcome `tool_error`), as is a call that runs
past its timeout (outcome `timeout`, logged at warn) and one cancelled by a disconnect, a
2026-era cancel or `close()` (outcome `cancelled`, logged at info; see
[Timeouts and cancellation](#timeouts-and-cancellation)). The wrapper exists so that a database
error or a stack detail never reaches the model.

## Logging

One line per tool call, object first: `tool`, `user_id`, `client_id`, `org_id`, `request_id`,
`outcome` (`ok`, `tool_error`, `internal_error`, `rate_limited`, `timeout`, `cancelled`) and
`duration_ms`. Inputs and
results are never logged; they may be the app's data.

## Audit

Tool calls are not written to Tereo's audit log: its actions are change actions only (`CREATE`
through `RESTORE`), so a call has nothing to record. Every call is a log line, as above. A handler
that changes data writes its own entry:

```ts
handler: async (input, ctx) => {
  await prisma.$transaction(async (tx) => {
    const item = await tx.item.create({ data: input });
    await ctx.core.outbox.audit(tx, {
      userId: ctx.auth.userId,
      action: "CREATE",
      entityType: "Item",
      entityId: item.id,
    });
  });
  return "created";
},
```

## Rate limit

A fixed one-minute window per user id, counted in Redis under `@tereo-io/mcp:<name>:rl:<user>`,
120 calls by default. Over the limit the call returns a tool error saying how many seconds to wait
and the handler does not run. Only `tools/call` is counted: `input` functions, which run for every
protocol message, are not limited, and neither is a call whose arguments fail the schema, which the
MCP SDK refuses before the limit is checked. If Redis fails the call goes through and the failure is
logged at error.

A tool can set its own limit instead:

| `rateLimit` on the tool | |
|-------------------------|---|
| unset | The server-wide limit applies |
| `{ perMinute }` | Its own per-user counter, under `@tereo-io/mcp:<name>:rl:<user>:<tool>`. Its calls do not count toward the server-wide limit |
| `false` | Never limited; Redis is not touched |

A tool with its own limit needs `redis` even when the server-wide `rateLimit` is `false`. The
answer over the limit, the outcome and the Redis failure behaviour are the same as above.

## Testing

`@tereo-io/mcp/testing` gives an app's own tests an in-process MCP client and a stub core. It needs
`@modelcontextprotocol/client` installed and a core client in the SDK's
[`testMode`](https://github.com/tereo-io/tereo/blob/master/packages/tereo-sdk/docs/testing.md), so
test tokens are accepted without a core:

```ts
import { createTestClient, startStubCore } from "@tereo-io/mcp/testing";

const stubCore = await startStubCore();
const mcp = createTereoMcp({
  name: "query-service",
  version: "1.0.0",
  core,                                     // createCoreClient({ …, testMode: true })
  publicUrl: "https://mcp.example.com",
  allowedClients: ["claude-connector"],
  rateLimit: false,
  coreUrl: stubCore.coreUrl,
});
mcp.define(/* … */);

const { client, close } = await createTestClient(mcp, {
  token: "test-token-user-1|client=claude-connector|perms=query.connections.read",
});
const { tools } = await client.listTools();
const result = await client.callTool({ name: "list_connections", arguments: {} });
await close();
await stubCore.close();
```

`startStubCore()` serves only core's authorization-server metadata, on a loopback port, so the start
checks pass; it answers nothing else. `createTestClient` calls
`mcp.listen(0, "127.0.0.1", { signals: false })`, so the start checks run, including the fetch of
that metadata, and the test process gains no signal listeners. `close()` stops the client and the server.
