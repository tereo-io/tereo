# @tereo-io/mcp

Serve an app service's tools over the [Model Context Protocol](https://modelcontextprotocol.io),
signed in through [tereo](https://github.com/tereo-io/tereo). You define tools and name the Tereo
permission each needs; the package handles the OAuth resource-server side, permission gating, error
handling, logging, rate limiting and the HTTP server, and runs your handler as a known user.

```sh
npm install @tereo-io/mcp
```

It is ESM only and built on Node.js 22. Peer dependencies: `@tereo-io/sdk`, `express` 5, `zod` 4 and
`ioredis`; `@modelcontextprotocol/client` is an optional peer, needed only for `@tereo-io/mcp/testing`.

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
  name: "run_query",
  description: "Run a read-only query against a connection",
  permission: "query.queries.run",
  readOnly: true,
  input: async (ctx) => querySchemaFor(ctx.auth.userId),   // per-user schema
  handler: async (input, ctx) => runQuery(ctx.auth, input),
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
| `coreUrl` | no | Core's base URL, for fetching its authorization-server metadata at start. Default `CORE_URL`, as in the SDK |
| `logger` | no | A Pino logger. Default a new one named `@tereo-io/mcp` |
| `maxResultBytes` | no | Default 1 000 000; a positive integer. A larger result becomes a tool error instead of flooding the model |

## `mcp.define(tool)`

| Field | Required | |
|-------|----------|---|
| `name` | yes | `[a-z0-9_]`, unique; a duplicate throws |
| `description` | yes | Shown to the model |
| `permission` | yes | A non-empty Tereo permission name, or `null` for any signed-in user. The hierarchy is the SDK's: `write` includes `read`, `admin` includes all |
| `readOnly` | yes | Sets `readOnlyHint`. Required so an author has to state it |
| `destructive`, `idempotent` | no | `destructiveHint`, `idempotentHint` |
| `input` | no | `z.object(...)`, or `(ctx) => z.object(...)` (may be async) for a per-user schema. Omitted: no arguments |
| `handler` | yes | `(input, ctx) => value`. A string is returned as text; any other JSON value as JSON text |

`define` throws once the server has started (`router()` or `listen()` was called).

An `input` function runs for every protocol message the caller sends (`initialize`, `tools/list`,
`tools/call`), not only for calls, because the server is built per request. Keep it cheap and free
of side effects. If it throws, or returns anything but a `z.object(...)`, the error is logged and
that tool is left out for that request.

### `ctx`

| Member | |
|--------|---|
| `auth` | The SDK's `AuthContext`: `userId`, `email`, `name`, `userType`, `permissions`, `clientId`, `scope`, `organizationId`, … |
| `core` | The `CoreClient`, for lookups (groups, users) and `outbox.audit` |
| `requestId` | Also on every log line for the call |
| `logger` | A Pino child logger carrying `tool`, `user_id` and `request_id` |

## Serving

`router()` and `listen()` are async and run the start checks once.

- `await mcp.router()` returns an Express router with the protected-resource metadata routes and the
  MCP endpoint behind bearer auth. Mount it at the app root (`app.use(await mcp.router())`, not
  `app.use("/x", …)`): the `401` challenge and the `/.well-known` routes assume `publicUrl` maps to
  `/`. The host app owns Host and Origin validation and body limits; use the MCP SDK's
  `hostHeaderValidation` and `originValidation` from `@modelcontextprotocol/express`. It also owns
  error handling: install a final JSON error handler, or Express answers a malformed body with its
  HTML error page, which outside production carries the stack.
- `await mcp.listen(port, host?)` builds a standalone app, bound to `0.0.0.0` by default, that
  accepts the host of `publicUrl` (plus loopback names when `host` is loopback), and adds
  `GET /health`. It answers a request it rejects (a malformed JSON body, say) with JSON:
  `{ "error": "invalid_request" }` and the 4xx status, or `500 { "error": "server_error" }`. It
  resolves `{ port, url, close }` (type `Listening`): `port` is the bound port (pass `0` to pick
  one), `url` the endpoint as reached locally, and `close()` stops accepting connections, closes the
  MCP handler and resolves when in-flight calls finish. It has no deadline: a handler that never
  returns keeps `close()` waiting, so bound it with your own timeout if needed.

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
- `rateLimit.perMinute` or `maxResultBytes` is given and is not a positive integer;
- an `allowedOrigins` entry is not an http or https origin (scheme, host and optional port only);
- a `scopes` entry is empty, contains whitespace, a quote or a backslash, is repeated, or is `offline_access`;
- with `provisioning`, a tool needs a permission the document's service does not declare;
- neither `coreUrl` nor `CORE_URL` is set, or Tereo's authorization-server metadata cannot be fetched
  from `${coreUrl}/.well-known/oauth-authorization-server`;
- the metadata's `issuer` is not https (plain http is allowed on `localhost` and `127.0.0.1`, as the
  MCP SDK requires) or has a query or fragment.

A failed start is not cached: the next `router()` or `listen()` runs the checks again.

## Errors

| Thrown by the handler | The model sees | Logged |
|-----------------------|----------------|--------|
| `ToolError(message)` | `message`, as a tool error | info, outcome `tool_error` |
| An SDK `HttpError` with status below 500 (`ForbiddenError`, `NotFoundError`, …) | Its message, as a tool error | info, outcome `tool_error` |
| Anything else | `Internal error (request <id>)`, as a tool error | error, with `err`, outcome `internal_error` |

A result over `maxResultBytes` is a tool error too (outcome `tool_error`). The wrapper exists so
that a database error or a stack detail never reaches the model.

## Logging

One line per tool call, object first: `tool`, `user_id`, `client_id`, `org_id`, `request_id`,
`outcome` (`ok`, `tool_error`, `internal_error`, `rate_limited`) and `duration_ms`. Inputs and
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
checks pass; it answers nothing else. `createTestClient` calls `mcp.listen(0, "127.0.0.1")`, so the
start checks run, including the fetch of that metadata. `close()` stops the client and the server.
