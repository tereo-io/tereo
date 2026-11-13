## 0.1.1 (2026-11-13)

### 🚀 Features

- `hostHeaderValidation(allowedHostnames)` and `originValidation(allowedOrigins)`, exported from `@tereo-io/mcp`, are Express middleware for an app that mounts `router()`: the Host and Origin checks `listen` applies, compared by hostname as the MCP SDK does. `hostHeaderValidation` takes hostnames (`mcp.example.com`); `originValidation` takes the origins `createTereoMcp`'s `allowedOrigins` takes (`https://app.example.com`), hostnames, or `<scheme>://*` for a non-web scheme. An entry of any other shape (a URL as a hostname, a port, a path, `https://*`) throws when the middleware is made. Given the hostname of `publicUrl` and the same `allowedOrigins`, they refuse what `listen` does. With them the app no longer imports `@modelcontextprotocol/express`, whose `req.auth` declaration replaces `@tereo-io/sdk`'s `AuthContext` in the app's types. The README says what to do in an app that imports that package anyway (read Tereo's context with `core.auth.validateUser(req)`), and to mount `router()` ahead of an app-wide `core.auth.requireAuth`. ([#59](https://github.com/tereo-io/tereo/pull/59))

### 🩹 Fixes

- Without `coreUrl`, the start check fetches core's authorization-server metadata from the URL the given `CoreClient` was created with (`core.url`), and only then from `CORE_URL`, so a service that configures its core client from its own settings no longer has to pass `coreUrl` too. Where `createCoreClient({ url })` and `CORE_URL` differ, the metadata now comes from the client's URL, not from `CORE_URL`. This release's `@tereo-io/sdk` peer range requires the SDK release that adds `core.url`; a core client without it (from an older SDK) still falls back to `CORE_URL`. ([#59](https://github.com/tereo-io/tereo/pull/59))
- The README and `ToolContext.signal` now say what a client's cancel does on each protocol era: on a 2026-era connection it aborts `ctx.signal`; on a 2025-era (legacy) connection the `notifications/cancelled` it sends cannot reach the running call, which runs on until it ends or reaches its deadline. A disconnect aborts the signal on both. ([#59](https://github.com/tereo-io/tereo/pull/59))

### 🧱 Updated Dependencies

- Updated @tereo-io/sdk to 0.5.2

### ❤️ Thank You

- Aaron Leman

## 0.1.0 (2026-11-13)

### ⚠️  Breaking Changes

- First release of `@tereo-io/mcp`: define MCP tools, name the Tereo permission each needs, and serve them to clients that sign in through Tereo. ([#55](https://github.com/tereo-io/tereo/pull/55))

### 🧱 Updated Dependencies

- Updated @tereo-io/sdk to 0.5.1

### ❤️ Thank You

- Aaron Leman